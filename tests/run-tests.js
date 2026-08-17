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
}


(async () => {
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

	console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
	process.exit(failed ? 1 : 0);
})();