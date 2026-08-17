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
}

console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
process.exit(failed ? 1 : 0);