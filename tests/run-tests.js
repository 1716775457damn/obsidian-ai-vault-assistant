const fs = require("fs");
const vm = require("vm");
const path = require("path");

const obsidianStub = {
	Plugin: class {},
	PluginSettingTab: class {},
	Setting: class {},
	Notice: class {},
	Modal: class {},
	ItemView: class {},
	requestUrl: async () => ({ status: 200, json: {}, text: "" }),
	normalizePath: (p) => p,
	MarkdownRenderer: { renderMarkdown() {} },
};

const code = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const sandbox = {
	require: (name) => (name === "obsidian" ? obsidianStub : require(name)),
	module: { exports: {} },
	exports: {},
	console,
	setTimeout,
	clearTimeout,
	Buffer,
	TextDecoder,
	TextEncoder,
	ReadableStream,
	AbortController,
	fetch: () => Promise.reject(new Error("no fetch")),
	crypto: require("crypto"),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "main.js" });

const helpers = sandbox.module.exports.helpers;
let passed = 0;
let failed = 0;
function assert(cond, msg) {
	if (cond) { passed++; console.log("PASS " + msg); }
	else { failed++; console.log("FAIL " + msg); }
}

// parseSseBuffer
{
	const events = [];
	const rest = helpers.parseSseBuffer('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c', events);
	assert(events.length === 2, "parseSseBuffer 解析两个完整事件");
	assert(JSON.stringify(events[0]) === '{"a":1}', "parseSseBuffer 事件1");
	assert(rest === 'data: {"c', "parseSseBuffer 保留不完整尾部");
	events.length = 0;
	const r2 = helpers.parseSseBuffer(rest + '":3}\n\ndata: [DONE]\n', events);
	assert(events.length === 1 && events[0].c === 3, "parseSseBuffer 补全并跳过 [DONE]");
}

// extractDbModels
{
	const raw = 'model = "deepseek-v4-flash"\n"model":"gpt-5.6-sol"';
	const models = helpers.extractDbModels(raw);
	assert(models.includes("deepseek-v4-flash"), "extractDbModels TOML 形式");
	assert(models.includes("gpt-5.6-sol"), "extractDbModels JSON 形式");
	assert(helpers.extractDbModels("").length === 0, "extractDbModels 空输入");
	assert(helpers.extractDbModels(null).length === 0, "extractDbModels null 输入");
}

// mergeModelList
{
	const merged = helpers.mergeModelList(["a", "b"], ["b", "c"], ["d"], [["e", "E"], ["a", "A"]], "cur");
	assert(JSON.stringify(merged) === JSON.stringify(["cur", "a", "b", "c", "d", "e"]), "mergeModelList 去重排序");
}

// buildVaultIndex
{
	const files = [{ path: "a.md", size: 10 }, { path: "b.md" }];
	const idx = helpers.buildVaultIndex(files, 10);
	assert(idx.includes("a.md (10B)") && idx.includes("b.md"), "buildVaultIndex 路径+大小");
	assert(helpers.buildVaultIndex([], 10) === "(空库)", "buildVaultIndex 空库");
}

// makeDiff
{
	const diff = helpers.makeDiff("a\nb\n", "a\nc\n");
	assert(diff.includes("+ c") && diff.includes("- b"), "makeDiff 增删标记");
}

// jsonRpcError
{
	const e = helpers.jsonRpcError(7, -32601, "bad");
	assert(e.error.code === -32601 && e.id === 7, "jsonRpcError 结构");
}

// MODEL_CATALOG
{
	assert(Array.isArray(helpers.MODEL_CATALOG) && helpers.MODEL_CATALOG.length === 189, "MODEL_CATALOG 189 个模型");
	assert(helpers.MODEL_CATALOG.some(([id]) => id === "deepseek-v4-flash"), "MODEL_CATALOG 含 deepseek-v4-flash");
}

// DEFAULT_SETTINGS
{
	assert(helpers.DEFAULT_SETTINGS.aiBaseUrl === "http://127.0.0.1:15721/v1", "默认 AI 地址");
	assert(helpers.DEFAULT_SETTINGS.mcpPort === 33157, "默认 MCP 端口");
	assert(helpers.DEFAULT_SETTINGS.firstTokenTimeoutMs === 60000, "默认首 token 超时 60s");
	assert(helpers.DEFAULT_SETTINGS.idleTimeoutMs === 30000, "默认空闲超时 30s");
	assert(helpers.DEFAULT_SETTINGS.totalTimeoutMs === 180000, "默认总超时 180s");
	assert(helpers.DEFAULT_SETTINGS.maxHistoryMessages === 40, "默认历史 40 条");
	assert(helpers.DEFAULT_SETTINGS.aiConcurrentLimit === 2, "默认 AI 并发 2");
	assert(helpers.DEFAULT_SETTINGS.vaultReadMaxBytes === 500000, "默认读取上限 500KB");
}


(async () => {
	// isSafeVaultPath
	{
		assert(helpers.isSafeVaultPath("a/b.md"), "isSafeVaultPath 合法路径");
		assert(helpers.isSafeVaultPath("文件夹/笔记.md"), "isSafeVaultPath 中文路径");
		assert(!helpers.isSafeVaultPath("../a.md"), "isSafeVaultPath 拒绝 ..");
		assert(!helpers.isSafeVaultPath("a/../b.md"), "isSafeVaultPath 拒绝中间 ..");
		assert(!helpers.isSafeVaultPath("C:/x.md"), "isSafeVaultPath 拒绝盘符");
		assert(!helpers.isSafeVaultPath("/abs/x.md"), "isSafeVaultPath 拒绝绝对路径");
		assert(!helpers.isSafeVaultPath("a\\b.md"), "isSafeVaultPath 拒绝反斜杠");
		assert(!helpers.isSafeVaultPath("./a.md"), "isSafeVaultPath 拒绝 ./");
		assert(!helpers.isSafeVaultPath(""), "isSafeVaultPath 拒绝空串");
		assert(!helpers.isSafeVaultPath(null), "isSafeVaultPath 拒绝 null");
	}

	// vault_read 大文件截断
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { vaultReadMaxBytes: 100 };
		inst.app = { vault: { adapter: { exists: async () => true, read: async () => "x".repeat(500) } } };
		const r = await inst.runTool("vault_read", { path: "big.md" }, { confirmMode: "required" });
		assert(r.ok === true && r.truncated === true && r.content.length < 500, "vault_read 大文件截断");
	}

	// AI 并发限制：第三个请求等待/失败
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiConcurrentLimit: 1, aiBaseUrl: "http://x/v1", maxTokens: 16, temperature: 0.3, enableTools: false, firstTokenTimeoutMs: 60000, idleTimeoutMs: 30000, totalTimeoutMs: 180000 };
		let inflight = 0;
		sandbox.fetch = async () => {
			inflight++;
			const encoder = new TextEncoder();
			const stream = new ReadableStream({
				start(c) { setTimeout(() => { c.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")); c.enqueue(encoder.encode("data: [DONE]\n\n")); c.close(); }, 30); },
			});
			return { ok: true, status: 200, text: async () => "", body: { getReader: () => stream.getReader() } };
		};
		const p1 = inst.streamChat([{ role: "user", content: "a" }], { tools: false });
		await new Promise((r) => setTimeout(r, 10));
		const p2 = inst.streamChat([{ role: "user", content: "b" }], { tools: false });
		await new Promise((r) => setTimeout(r, 50));
		assert(inflight <= 1, "AI 并发限制：同时最多 1 个请求");
		await Promise.all([p1, p2]);
		assert(inflight === 2, "AI 并发限制：两个请求都完成");
	}

	// runTool 路径穿越拒绝
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = {};
		inst.app = { vault: { adapter: { exists: async () => false, read: async () => "", write: async () => {} } } };
		const r1 = await inst.runTool("vault_read", { path: "../../x.md" }, { confirmMode: "required" });
		assert(r1.ok === false && /路径/.test(r1.error), "vault_read 拒绝 ../");
		const r2 = await inst.runTool("vault_write", { path: "../../x.md", content: "x", confirm: true }, { confirmMode: "required" });
		assert(r2.ok === false && /路径/.test(r2.error), "vault_write 拒绝 ../");
		const r3 = await inst.runTool("vault_write", { path: ".obsidian/app.json", content: "{}", confirm: true }, { confirmMode: "required" });
		assert(r3.ok === false && /config_apply/.test(r3.error), "vault_write 拒绝写 .obsidian");
		const r4 = await inst.runTool("config_read", { target: "../../x" }, { confirmMode: "required" });
		assert(r4.ok === false, "config_read 拒绝穿越 target");
		const r5 = await inst.runTool("config_apply", { target: "a/../b", next: "{}", confirm: true }, { confirmMode: "required" });
		assert(r5.ok === false, "config_apply 拒绝穿越 target");
		const r6 = await inst.runTool("config_apply", { target: "bad target!", next: "{}", confirm: true }, { confirmMode: "required" });
		assert(r6.ok === false, "config_apply 拒绝非法插件 id");
	}

	// withTimeout 正常 resolve
	{
		const v = await helpers.withTimeout(Promise.resolve(42), 500, "x");
		assert(v === 42, "withTimeout 正常 resolve");
	}
	// withTimeout 超时 reject
	{
		let hit = false;
		try {
			await helpers.withTimeout(new Promise(() => {}), 60, "超时测试");
		} catch (e) {
			hit = /超时测试/.test(e.message);
		}
		assert(hit, "withTimeout 超时后 reject");
	}

	// streamChatOnce 流式正常拼接
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiBaseUrl: "http://127.0.0.1:15721/v1", firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 10000 };
		const encoder = new TextEncoder();
		const chunks = [
			encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'),
			encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'),
			encoder.encode("data: [DONE]\n\n"),
		];
		let i = 0;
		const stream = new ReadableStream({
			pull(controller) {
				if (i < chunks.length) controller.enqueue(chunks[i++]);
				else controller.close();
			},
		});
		sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => "", body: { getReader: () => stream.getReader() } });
		let out = "";
		const res = await inst.streamChatOnce({ model: "m", messages: [] }, (c) => { out += c; });
		assert(res.content === "你好" && out === "你好", "streamChatOnce 流式内容拼接");
	}

	// streamChatOnce 上游挂起 → 超时错误（不再无限等待）
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiBaseUrl: "http://127.0.0.1:15721/v1", firstTokenTimeoutMs: 80, idleTimeoutMs: 40, totalTimeoutMs: 5000 };
		let signal = null;
		sandbox.fetch = async (url, opts) => {
			signal = opts.signal;
			return {
				ok: true,
				status: 200,
				text: async () => "",
				body: {
					getReader: () => ({
						read: () =>
							new Promise((resolve, reject) => {
								signal.addEventListener("abort", () => {
									const e = new Error("aborted");
									e.name = "AbortError";
									reject(e);
								}, { once: true });
							}),
						}),
					},
			};
		};
		let timedOut = false;
		try {
			await inst.streamChatOnce({ model: "m", messages: [] }, null);
		} catch (e) {
			timedOut = /超时/.test(e.message);
		}
		assert(timedOut, "streamChatOnce 上游挂起时抛超时错误");
	}

	// DEFAULT_SETTINGS chatHistory
	{
		assert(Array.isArray(helpers.DEFAULT_SETTINGS.chatHistory), "DEFAULT_SETTINGS 含 chatHistory 数组");
	}

	// streamChatOnce 停止生成：onDelta 返回 false 抛已停止，不再接收后续 chunk
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiBaseUrl: "http://127.0.0.1:15721/v1", firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 10000 };
		const encoder = new TextEncoder();
		const chunks = [
			encoder.encode('data: {"choices":[{"delta":{"content":"一"}}]}\n\n'),
			encoder.encode('data: {"choices":[{"delta":{"content":"二"}}]}\n\n'),
			encoder.encode("data: [DONE]\n\n"),
		];
		let i = 0;
		const stream = new ReadableStream({
			pull(controller) {
				if (i < chunks.length) controller.enqueue(chunks[i++]);
				else controller.close();
			},
		});
		sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => "", body: { getReader: () => stream.getReader() } });
		let got = "";
		let stopped = false;
		try {
			await inst.streamChatOnce({ model: "m", messages: [] }, (c) => { got += c; return false; });
		} catch (e) {
			stopped = /已停止/.test(e.message);
		}
		assert(stopped, "streamChatOnce 停止生成抛已停止");
		assert(got === "一", "streamChatOnce 停止后不再接收后续 chunk");
	}

	// streamChat 停止信号已触发：不发起请求、不重试
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiBaseUrl: "http://127.0.0.1:15721/v1", firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 10000, maxTokens: 16, temperature: 0.3, enableTools: false, aiConcurrentLimit: 2 };
		const ac = new AbortController();
		ac.abort();
		let fetches = 0;
		sandbox.fetch = async () => { fetches++; return { ok: true, status: 200, text: async () => "", body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } }; };
		let stopped = false;
		try {
			await inst.streamChat([{ role: "user", content: "a" }], { tools: false, stopSignal: ac.signal });
		} catch (e) {
			stopped = /已停止/.test(e.message);
		}
		assert(stopped && fetches === 0, "streamChat 已停止信号不发起请求且抛已停止");
	}

	// streamChat 停止后不重试（onDelta 返回 false 触发停止，只请求 1 次）
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiBaseUrl: "http://127.0.0.1:15721/v1", firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 10000, maxTokens: 16, temperature: 0.3, enableTools: false, aiConcurrentLimit: 2 };
		const encoder = new TextEncoder();
		const chunks = [
			encoder.encode('data: {"choices":[{"delta":{"content":"一"}}]}\n\n'),
			encoder.encode('data: {"choices":[{"delta":{"content":"二"}}]}\n\n'),
			encoder.encode("data: [DONE]\n\n"),
		];
		let i = 0;
		const stream = new ReadableStream({
			pull(controller) {
				if (i < chunks.length) controller.enqueue(chunks[i++]);
				else controller.close();
			},
		});
		let fetches = 0;
		sandbox.fetch = async () => { fetches++; return { ok: true, status: 200, text: async () => "", body: { getReader: () => stream.getReader() } }; };
		let stopped = false;
		try {
			await inst.streamChat([{ role: "user", content: "a" }], { tools: false }, () => false);
		} catch (e) {
			stopped = /已停止/.test(e.message);
		}
		assert(stopped && fetches === 1, "streamChat 停止后不重试（只请求 1 次）");
	}

	// 正常 onDelta 返回 true 时流式继续拼接
	{
		const cls = sandbox.module.exports;
		const inst = Object.create(cls.prototype);
		inst.settings = { aiBaseUrl: "http://127.0.0.1:15721/v1", firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 10000 };
		const encoder = new TextEncoder();
		const chunks = [
			encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
			encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'),
			encoder.encode("data: [DONE]\n\n"),
		];
		let i = 0;
		const stream = new ReadableStream({
			pull(controller) {
				if (i < chunks.length) controller.enqueue(chunks[i++]);
				else controller.close();
			},
		});
		sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => "", body: { getReader: () => stream.getReader() } });
		let out = "";
		const res = await inst.streamChatOnce({ model: "m", messages: [] }, (c) => { out += c; return true; });
		assert(res.content === "ab" && out === "ab", "streamChatOnce onDelta 返回 true 正常拼接");
	}

	console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
	process.exit(failed ? 1 : 0);
})();