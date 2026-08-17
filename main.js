"use strict";

const {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	Modal,
	ItemView,
	requestUrl,
	normalizePath,
	MarkdownRenderer,
} = require("obsidian");

const PLUGIN_ID = "ai-vault-assistant";
const VIEW_TYPE = "ai-vault-assistant-chat";
const COMMUNITY_PLUGINS_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const MCP_PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_SETTINGS = {
	aiBaseUrl: "http://127.0.0.1:15721/v1",
	ccSwitchDir: "",
	skillsDirs: [],
	model: "deepseek-v4-flash",
	customModels: [],
	maxTokens: 4096,
	temperature: 0.3,
	firstTokenTimeoutMs: 60000,
	idleTimeoutMs: 30000,
	totalTimeoutMs: 180000,
	enableTools: true,
	maxToolRounds: 6,
	mcpEnabled: true,
	mcpPort: 33157,
	mcpToken: "",
	mcpAuthRequired: true,
	includeVaultIndex: true,
	includeSkills: true,
	includeCommands: true,
	vaultTreeMaxEntries: 900,
	lastModelRefresh: 0,
};

function uuid() {
	try {
		if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
	} catch (err) {}
	return "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function copyText(text) {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text);
			return true;
		}
	} catch (err) {}
	try {
		const electron = require("electron");
		if (electron && electron.clipboard) {
			electron.clipboard.writeText(text);
			return true;
		}
	} catch (err) {}
	return false;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给 Promise 加超时（无法真正取消底层请求，仅用于防止界面无限等待）。
 */
function withTimeout(promise, ms, message) {
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message || "操作超时")), ms);
	});
	return Promise.race([promise, timeout]).then(
		(v) => { clearTimeout(timer); return v; },
		(e) => { clearTimeout(timer); throw e; }
	);
}

/**
 * SSE 增量解析：把收到的文本缓冲解析成 JSON 事件数组。
 * 返回剩余（不完整）的尾部字符串，供下一次拼接。
 */
function parseSseBuffer(buffer, events) {
	let data = "";
	const lines = buffer.split("\n");
	const rest = lines.pop();
	for (const line of lines) {
		const trimmed = line.replace(/\r$/, "");
		if (trimmed.startsWith("data:")) {
			data += (data ? "\n" : "") + trimmed.slice(5).trimStart();
		} else if (trimmed === "" && data) {
			if (data !== "[DONE]") {
				try {
					events.push(JSON.parse(data));
				} catch (err) {}
			}
			data = "";
		}
	}
	return rest;
}

function uniqueStrings(arr) {
	const seen = new Set();
	const out = [];
	for (const s of arr || []) {
		if (s && typeof s === "string" && !seen.has(s)) {
			seen.add(s);
			out.push(s);
		}
	}
	return out;
}

/** 从 cc-switch.db 原始文本中提取配置过的模型名（无需 SQLite 解析） */
function extractDbModels(rawText) {
	const out = [];
	if (!rawText) return out;
	const re = /model\s*=\s*"([^"]{1,120})"/g;
	let m;
	while ((m = re.exec(rawText)) !== null) out.push(m[1]);
	const re2 = /"model"\s*:\s*"([^"]{1,120})"/g;
	while ((m = re2.exec(rawText)) !== null) out.push(m[1]);
	return uniqueStrings(out);
}

/** 合并模型列表：当前模型 → 代理返回 → db 提取 → 自定义 → 内置目录 */
function mergeModelList(proxyModels, dbModels, customModels, catalog, current) {
	const out = [];
	const push = (id) => {
		if (id && !out.includes(id)) out.push(id);
	};
	push(current);
	(proxyModels || []).forEach(push);
	(dbModels || []).forEach(push);
	(customModels || []).forEach(push);
	(catalog || []).forEach((e) => push(Array.isArray(e) ? e[0] : e));
	return out;
}

/** 生成 Vault 文件索引文本（供 AI 上下文使用） */
function buildVaultIndex(files, maxEntries) {
	if (!files || files.length === 0) return "(空库)";
	const rows = files
		.map((f) => f.path + (f.size ? " (" + f.size + "B)" : ""))
		.slice(0, maxEntries || 900);
	let text = rows.join("\n");
	if (files.length > rows.length) {
		text += "\n…共 " + files.length + " 个文件（仅显示前 " + rows.length + " 个）";
	}
	return text;
}

/** 简易行级 diff，用于配置改动预览 */
function makeDiff(oldText, newText) {
	const a = String(oldText || "").split("\n");
	const b = String(newText || "").split("\n");
	const out = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			out.push("  " + a[i]);
			i++;
			j++;
		} else if (j < b.length && (i >= a.length || b[j] !== a[i])) {
			out.push("+ " + b[j]);
			j++;
		} else {
			out.push("- " + a[i]);
			i++;
		}
	}
	return out.join("\n");
}

function jsonRpcError(id, code, message) {
	return {
		jsonrpc: "2.0",
		id: id === undefined ? null : id,
		error: { code, message },
	};
}

async function requestJson(url) {
	const res = await requestUrl({ url, throw: false });
	if (res.status !== 200) {
		throw new Error("请求失败 " + res.status + ": " + url);
	}
	try {
		return res.json;
	} catch (err) {
		return JSON.parse(res.text);
	}
}

async function requestBinary(url) {
	const res = await requestUrl({ url, throw: false });
	if (res.status !== 200) {
		throw new Error("下载失败 " + res.status + ": " + url);
	}
	return res.arrayBuffer;
}
const MODEL_CATALOG = [
	["claude-3-5-haiku-20241022", "Claude 3.5 Haiku"],
	["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet"],
	["claude-fable-5", "Claude Fable 5"],
	["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
	["claude-mythos-5", "Claude Mythos 5"],
	["claude-opus-4-1-20250805", "Claude Opus 4.1"],
	["claude-opus-4-20250514", "Claude Opus 4"],
	["claude-opus-4-5-20251101", "Claude Opus 4.5"],
	["claude-opus-4-6", "Claude Opus 4.6"],
	["claude-opus-4-6-20260206", "Claude Opus 4.6"],
	["claude-opus-4-7", "Claude Opus 4.7"],
	["claude-opus-4-8", "Claude Opus 4.8"],
	["claude-opus-5", "Claude Opus 5"],
	["claude-sonnet-4-20250514", "Claude Sonnet 4"],
	["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
	["claude-sonnet-4-6", "Claude Sonnet 4.6"],
	["claude-sonnet-4-6-20260217", "Claude Sonnet 4.6"],
	["claude-sonnet-5", "Claude Sonnet 5"],
	["codestral-2508", "Codestral"],
	["codex-mini", "Codex Mini"],
	["command-a", "Cohere Command A"],
	["command-r", "Cohere Command R"],
	["command-r-plus", "Cohere Command R+"],
	["deepseek-chat", "DeepSeek Chat"],
	["deepseek-reasoner", "DeepSeek Reasoner"],
	["deepseek-v3", "DeepSeek V3"],
	["deepseek-v3.1", "DeepSeek V3.1"],
	["deepseek-v3.2", "DeepSeek V3.2"],
	["deepseek-v4-flash", "DeepSeek V4 Flash"],
	["deepseek-v4-pro", "DeepSeek V4 Pro"],
	["devstral-2-2512", "Devstral 2"],
	["devstral-medium", "Devstral Medium"],
	["devstral-small-1.1", "Devstral Small 1.1"],
	["devstral-small-2-2512", "Devstral Small 2"],
	["doubao-seed-2-0-code", "Doubao Seed 2.0 Code"],
	["doubao-seed-2-0-code-preview-latest", "Doubao Seed 2.0 Code Preview"],
	["doubao-seed-2-0-lite", "Doubao Seed 2.0 Lite"],
	["doubao-seed-2-0-mini", "Doubao Seed 2.0 Mini"],
	["doubao-seed-2-0-pro", "Doubao Seed 2.0 Pro"],
	["doubao-seed-2-1-pro", "Doubao Seed 2.1 Pro"],
	["doubao-seed-2-1-turbo", "Doubao Seed 2.1 Turbo"],
	["doubao-seed-code", "Doubao Seed Code"],
	["gemini-2.0-flash", "Gemini 2.0 Flash"],
	["gemini-2.5-flash", "Gemini 2.5 Flash"],
	["gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"],
	["gemini-2.5-pro", "Gemini 2.5 Pro"],
	["gemini-3-flash-preview", "Gemini 3 Flash Preview"],
	["gemini-3-pro-preview", "Gemini 3 Pro Preview"],
	["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
	["gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview"],
	["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
	["gemini-3.5-flash", "Gemini 3.5 Flash"],
	["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
	["gemini-3.6-flash", "Gemini 3.6 Flash"],
	["glm-4.6", "GLM-4.6"],
	["glm-4.7", "GLM-4.7"],
	["glm-5", "GLM-5"],
	["glm-5-turbo", "GLM-5-Turbo"],
	["glm-5.1", "GLM-5.1"],
	["glm-5.2", "GLM-5.2"],
	["glm-5v-turbo", "GLM-5V-Turbo"],
	["gpt-4.1", "GPT-4.1"],
	["gpt-4.1-mini", "GPT-4.1 Mini"],
	["gpt-4.1-nano", "GPT-4.1 Nano"],
	["gpt-5", "GPT-5"],
	["gpt-5-codex", "GPT-5 Codex"],
	["gpt-5-codex-high", "GPT-5 Codex"],
	["gpt-5-codex-low", "GPT-5 Codex"],
	["gpt-5-codex-medium", "GPT-5 Codex"],
	["gpt-5-codex-mini", "GPT-5 Codex"],
	["gpt-5-codex-mini-high", "GPT-5 Codex"],
	["gpt-5-codex-mini-medium", "GPT-5 Codex"],
	["gpt-5-high", "GPT-5"],
	["gpt-5-low", "GPT-5"],
	["gpt-5-medium", "GPT-5"],
	["gpt-5-mini", "GPT-5 Mini"],
	["gpt-5-minimal", "GPT-5"],
	["gpt-5-nano", "GPT-5 Nano"],
	["gpt-5.1", "GPT-5.1"],
	["gpt-5.1-codex", "GPT-5.1 Codex"],
	["gpt-5.1-codex-max", "GPT-5.1 Codex"],
	["gpt-5.1-codex-max-high", "GPT-5.1 Codex"],
	["gpt-5.1-codex-max-xhigh", "GPT-5.1 Codex"],
	["gpt-5.1-codex-mini", "GPT-5.1 Codex"],
	["gpt-5.1-high", "GPT-5.1"],
	["gpt-5.1-low", "GPT-5.1"],
	["gpt-5.1-medium", "GPT-5.1"],
	["gpt-5.1-minimal", "GPT-5.1"],
	["gpt-5.2", "GPT-5.2"],
	["gpt-5.2-codex", "GPT-5.2 Codex"],
	["gpt-5.2-codex-high", "GPT-5.2 Codex"],
	["gpt-5.2-codex-low", "GPT-5.2 Codex"],
	["gpt-5.2-codex-medium", "GPT-5.2 Codex"],
	["gpt-5.2-codex-xhigh", "GPT-5.2 Codex"],
	["gpt-5.2-high", "GPT-5.2"],
	["gpt-5.2-low", "GPT-5.2"],
	["gpt-5.2-medium", "GPT-5.2"],
	["gpt-5.2-xhigh", "GPT-5.2"],
	["gpt-5.3-codex", "GPT-5.3 Codex"],
	["gpt-5.3-codex-high", "GPT-5.3 Codex"],
	["gpt-5.3-codex-low", "GPT-5.3 Codex"],
	["gpt-5.3-codex-medium", "GPT-5.3 Codex"],
	["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
	["gpt-5.3-codex-xhigh", "GPT-5.3 Codex"],
	["gpt-5.4", "GPT-5.4"],
	["gpt-5.4-mini", "GPT-5.4 Mini"],
	["gpt-5.4-nano", "GPT-5.4 Nano"],
	["gpt-5.5", "GPT-5.5"],
	["gpt-5.5-high", "GPT-5.5"],
	["gpt-5.5-low", "GPT-5.5"],
	["gpt-5.5-medium", "GPT-5.5"],
	["gpt-5.5-minimal", "GPT-5.5"],
	["gpt-5.5-xhigh", "GPT-5.5"],
	["gpt-5.6", "GPT-5.6 Sol"],
	["gpt-5.6-high", "GPT-5.6 Sol"],
	["gpt-5.6-low", "GPT-5.6 Sol"],
	["gpt-5.6-luna", "GPT-5.6 Luna"],
	["gpt-5.6-medium", "GPT-5.6 Sol"],
	["gpt-5.6-minimal", "GPT-5.6 Sol"],
	["gpt-5.6-sol", "GPT-5.6 Sol"],
	["gpt-5.6-terra", "GPT-5.6 Terra"],
	["gpt-5.6-xhigh", "GPT-5.6 Sol"],
	["grok-3", "Grok 3"],
	["grok-3-mini", "Grok 3 Mini"],
	["grok-4", "Grok 4"],
	["grok-4-1-fast-non-reasoning", "Grok 4.1 Fast"],
	["grok-4-1-fast-reasoning", "Grok 4.1 Fast Reasoning"],
	["grok-4.20-0309-non-reasoning", "Grok 4.20"],
	["grok-4.20-0309-reasoning", "Grok 4.20 Reasoning"],
	["grok-4.3", "Grok 4.3"],
	["grok-4.5", "Grok 4.5"],
	["grok-4.5-build", "Grok 4.5 Build"],
	["grok-build-0.1", "Grok Build 0.1"],
	["grok-code-fast-1", "Grok Build 0.1 (Code Fast Alias)"],
	["hunyuan-hy3", "Hunyuan Hy3"],
	["hy3", "Hunyuan Hy3"],
	["k3", "Kimi K3"],
	["kimi-k2-0905", "Kimi K2"],
	["kimi-k2-thinking", "Kimi K2 Thinking"],
	["kimi-k2-turbo", "Kimi K2 Turbo"],
	["kimi-k2.5", "Kimi K2.5"],
	["kimi-k2.6", "Kimi K2.6"],
	["kimi-k2.7-code", "Kimi K2.7 Code"],
	["kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed"],
	["kimi-k3", "Kimi K3"],
	["magistral-medium", "Magistral Medium"],
	["magistral-small", "Magistral Small"],
	["mimo-v2-flash", "MiMo V2 Flash"],
	["mimo-v2-pro", "MiMo V2 Pro"],
	["mimo-v2.5", "MiMo V2.5"],
	["mimo-v2.5-pro", "MiMo V2.5 Pro"],
	["minimax-m2", "MiniMax M2"],
	["minimax-m2.1", "MiniMax M2.1"],
	["minimax-m2.1-lightning", "MiniMax M2.1 Lightning"],
	["minimax-m2.5", "MiniMax M2.5"],
	["minimax-m2.5-lightning", "MiniMax M2.5 Lightning"],
	["minimax-m2.7", "MiniMax M2.7"],
	["minimax-m2.7-highspeed", "MiniMax M2.7 Highspeed"],
	["minimax-m3", "MiniMax M3"],
	["mistral-large-3-2512", "Mistral Large 3"],
	["mistral-medium-3.1", "Mistral Medium 3.1"],
	["mistral-medium-3.5", "Mistral Medium 3.5"],
	["mistral-small-3.2-24b", "Mistral Small 3.2"],
	["mistral-small-4", "Mistral Small 4"],
	["o1", "OpenAI o1"],
	["o1-mini", "OpenAI o1-mini"],
	["o3", "OpenAI o3"],
	["o3-mini", "OpenAI o3-mini"],
	["o3-pro", "OpenAI o3-pro"],
	["o4-mini", "OpenAI o4-mini"],
	["qwen3-235b-a22b", "Qwen3 235B-A22B"],
	["qwen3-32b", "Qwen3 32B"],
	["qwen3-coder-480b", "Qwen3 Coder 480B"],
	["qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B-A35B Instruct"],
	["qwen3-coder-flash", "Qwen3 Coder Flash"],
	["qwen3-coder-next", "Qwen3 Coder Next"],
	["qwen3-coder-plus", "Qwen3 Coder Plus"],
	["qwen3-max", "Qwen3 Max"],
	["qwen3.5-plus", "Qwen3.5 Plus"],
	["qwen3.6-flash", "Qwen3.6 Flash"],
	["qwen3.6-plus", "Qwen3.6 Plus"],
	["qwen3.7-max", "Qwen3.7 Max"],
	["qwen3.7-plus", "Qwen3.7 Plus"],
	["qwen3.8-max", "Qwen3.8 Max"],
	["qwq-32b", "QwQ 32B"],
	["qwq-plus", "QwQ Plus"],
	["step-3.5-flash", "Step 3.5 Flash"],
	["step-3.5-flash-2603", "Step 3.5 Flash 2603"],
	["step-3.7-flash", "Step 3.7 Flash"],
];

module.exports = class AIVaultAssistantPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		await this.ensureMcpToken();

		this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon("bot", "AI Vault 助手", () => this.openChatView());
		this.addCommand({
			id: "open-chat",
			name: "打开 AI 助手对话",
			callback: () => this.openChatView(),
		});
		this.addCommand({
			id: "refresh-models",
			name: "刷新模型列表",
			callback: () => this.refreshModelList(true),
		});
		this.addCommand({
			id: "community-install",
			name: "搜索并安装社区插件",
			callback: () => this.openCommunityModal(),
		});
		this.addCommand({
			id: "organize-vault",
			name: "AI 整理 Vault（生成概览/MOC）",
			callback: () => {
				this.openChatView();
				setTimeout(() => this.askOrganize(), 800);
			},
		});
		this.addSettingTab(new AIVaultAssistantSettingTab(this.app, this));

		this.refreshModelList(false);
		this.refreshSkillsList();

		if (this.settings.mcpEnabled) {
			try {
				this.startMcpServer();
			} catch (err) {
				console.error("[AI Vault Assistant] MCP 启动失败:", err);
				new Notice("AI Vault Assistant MCP 服务启动失败: " + err.message);
			}
		}
	}

	onunload() {
		this.stopMcpServer();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async ensureMcpToken() {
		if (!this.settings.mcpToken) {
			this.settings.mcpToken = uuid();
			await this.saveSettings();
		}
	}

	// ---------- Vault / 插件 / 命令 枚举 ----------

	async listVaultFiles(includeStat) {
		const files = this.app.vault.getFiles();
		const out = [];
		for (const f of files) {
			const item = { path: f.path, ext: f.extension, name: f.name };
			if (includeStat) {
				try {
					const stat = await this.app.vault.adapter.stat(f.path);
					item.size = stat ? stat.size : 0;
					item.mtime = stat ? stat.mtime : 0;
				} catch (err) {}
			}
			out.push(item);
		}
		out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return out;
	}

	async listInstalledPlugins() {
		const plugins = this.app.plugins.plugins || {};
		let enabled = [];
		try {
			const raw = await this.app.vault.adapter.read(normalizePath(".obsidian/community-plugins.json"));
			enabled = JSON.parse(raw) || [];
		} catch (err) {}
		const enabledSet = new Set(Array.isArray(enabled) ? enabled : []);
		const out = [];
		for (const id of Object.keys(plugins)) {
			const p = plugins[id];
			if (!p || !p.manifest) continue;
			out.push({
				id,
				name: p.manifest.name || id,
				version: p.manifest.version || "0.0.0",
				author: p.manifest.author || "",
				description: p.manifest.description || "",
				enabled: enabledSet.has(id),
			});
		}
		out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return out;
	}

	listCommands(pluginId) {
		const commands =
			this.app.commands.listCommands && typeof this.app.commands.listCommands === "function"
				? this.app.commands.listCommands()
				: [];
		const out = commands.map((c) => ({ id: c.id, name: c.name || "", icon: c.icon || "" }));
		if (!pluginId) return out;
		return out.filter((c) => c.id.startsWith(pluginId + ":"));
	}

	// ---------- cc-switch 接入 ----------

	getCCSwitchDir() {
		const candidates = [];
		if (this.settings.ccSwitchDir) candidates.push(this.settings.ccSwitchDir);
		try {
			const os = require("os");
			const path = require("path");
			const home = os.homedir ? os.homedir() : "";
			if (home) candidates.push(path.join(home, ".cc-switch"));
		} catch (err) {}
		candidates.push("C:\\Users\\陶鑫旺\\.cc-switch", "C:\\Users\\UserX\\.cc-switch");
		for (const c of candidates) {
			try {
				const fs = require("fs");
				const path = require("path");
				if (c && fs.existsSync(c) && fs.existsSync(path.join(c, "settings.json"))) return c;
			} catch (err) {}
		}
		return candidates[0] || "";
	}

	readCCSwitchSettings() {
		try {
			const fs = require("fs");
			const path = require("path");
			const dir = this.getCCSwitchDir();
			if (!dir) return null;
			const p = path.join(dir, "settings.json");
			if (!fs.existsSync(p)) return null;
			return JSON.parse(fs.readFileSync(p, "utf8"));
		} catch (err) {
			return null;
		}
	}

	async refreshModelList(notify) {
		try {
			const proxyModels = [];
			try {
				const url = this.settings.aiBaseUrl.replace(/\/+$/, "") + "/models";
				const res = await requestUrl({ url, throw: false });
				let data = null;
				if (res.status === 200) {
					data = res.json;
					if (!data) { try { data = JSON.parse(res.text); } catch (err) { data = null; } }
				}
				if (data && Array.isArray(data.models)) {
					for (const m of data.models) {
						const id = typeof m === "string" ? m : m && (m.id || m.slug || m.model);
						if (id) proxyModels.push(id);
					}
				}
			} catch (err) {}

			let dbModels = [];
			try {
				const fs = require("fs");
				const path = require("path");
				const dir = this.getCCSwitchDir();
				if (dir) {
					const dbPath = path.join(dir, "cc-switch.db");
					if (fs.existsSync(dbPath)) {
						const raw = fs.readFileSync(dbPath, "latin1");
						dbModels = extractDbModels(raw);
					}
				}
			} catch (err) {}

			const merged = mergeModelList(
				proxyModels,
				dbModels,
				this.settings.customModels,
				MODEL_CATALOG,
				this.settings.model
			);
			this.modelList = merged;
			this.settings.lastModelRefresh = Date.now();
			await this.saveSettings();
			this.triggerModelRefresh();
			if (notify) new Notice("已刷新模型列表，共 " + merged.length + " 个候选模型");
			return merged;
		} catch (err) {
			if (notify) new Notice("刷新模型失败: " + (err && err.message));
			return [];
		}
	}

	triggerModelRefresh() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view && leaf.view.refreshModelSelect) leaf.view.refreshModelSelect();
		}
	}

	refreshSkillsList() {
		this.skills = this.scanSkills();
		return this.skills;
	}

	scanSkills() {
		let out = [];
		const dirs = this.getSkillsDirs();
		try {
			const fs = require("fs");
			const path = require("path");
			for (const dir of dirs) {
				if (!dir || !fs.existsSync(dir)) continue;
				for (const name of fs.readdirSync(dir)) {
					const skillDir = path.join(dir, name);
					if (!fs.statSync(skillDir).isDirectory()) continue;
					const mdPath = path.join(skillDir, "SKILL.md");
					if (!fs.existsSync(mdPath)) continue;
					let desc = "";
					try {
						const text = fs.readFileSync(mdPath, "utf8");
						const m = /^description:\s*"([^"]*)"/m.exec(text) || /^description:\s*(.+)$/m.exec(text);
						if (m) desc = m[1].trim();
					} catch (err) {}
					out.push({ name, description: desc, path: mdPath });
				}
			}
		} catch (err) {}
		const seen = new Set();
		out = out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
		out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return out;
	}

	getSkillsDirs() {
		const dirs = [];
		if (Array.isArray(this.settings.skillsDirs)) dirs.push(...this.settings.skillsDirs);
		const cc = this.getCCSwitchDir();
		if (cc) dirs.push(cc + "\\skills");
		try {
			const os = require("os");
			const path = require("path");
			const home = os.homedir ? os.homedir() : "";
			if (home) {
				dirs.push(path.join(home, ".codex", "skills"));
				dirs.push(path.join(home, ".agents", "skills"));
			}
		} catch (err) {}
		const seen = new Set();
		return dirs.filter((d) => d && !seen.has(d) && seen.add(d));
	}

	async buildSystemPrompt() {
		const parts = [];
		parts.push(
			"你是「AI Vault 助手」，运行在用户的 Obsidian 笔记库中。你可以读取/搜索/创建/修改库内任意笔记，" +
				"也可以列出已安装插件与命令、读取本地 skills、搜索并安装社区插件、读取并修改插件配置。"
		);
		parts.push("规则：");
		parts.push("1. 用中文回复，简洁、可执行。");
		parts.push(
			"2. 所有写操作（创建/修改文件、安装插件、改配置）都必须先经过用户确认；在对话界面中，工具执行前会自动弹窗确认，你只需先说明你要做什么。"
		);
		parts.push("3. 整理文件时优先使用 MOC（Map of Content）、双链 [[]]、frontmatter 和 tags，让笔记相互关联。");
		parts.push("4. 修改插件配置时，先读取当前 data.json，给出最小改动方案，经用户确认后再写。");
		if (this.settings.includeVaultIndex) {
			try {
				const files = await this.listVaultFiles(true);
				parts.push(
					"\n## 当前 Vault 文件索引（前 " +
						this.settings.vaultTreeMaxEntries +
						" 条）\n" +
						buildVaultIndex(files, this.settings.vaultTreeMaxEntries)
				);
			} catch (err) {}
		}
		if (this.settings.includeSkills && this.skills && this.skills.length) {
			const lines = this.skills
				.map((s) => "- " + s.name + (s.description ? "：" + s.description : ""))
				.slice(0, 150);
			parts.push("\n## 可用 Skills（可通过工具读取详细内容）\n" + lines.join("\n"));
		}
		if (this.settings.includeCommands) {
			try {
				const cmds = this.listCommands().slice(0, 200);
				parts.push(
					"\n## 当前插件命令（部分，可通过 commands_list 获取更多）\n" +
						cmds.map((c) => "- " + c.id + (c.name ? "：" + c.name : "")).join("\n")
				);
			} catch (err) {}
		}
		return parts.join("\n\n");
	}
	// ---------- AI 工具定义 ----------

	buildToolsSpec() {
		return [
			{
				name: "vault_tree",
				description: "列出库内全部文件的路径索引（含大小）",
				inputSchema: {
					type: "object",
					properties: { max: { type: "number", description: "最多返回条数" } },
				},
			},
			{
				name: "vault_read",
				description: "读取库内任意文件内容（markdown/JSON/文本）",
				inputSchema: {
					type: "object",
					properties: { path: { type: "string", description: "文件路径，如 notes/a.md" } },
					required: ["path"],
				},
			},
			{
				name: "vault_search",
				description: "按文件名与内容搜索笔记",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string" },
						max: { type: "number", description: "最多返回条数，默认 20" },
					},
					required: ["query"],
				},
			},
			{
				name: "vault_write",
				description: "创建或修改库内文件（写入前需要 confirm:true 确认）",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
						content: { type: "string" },
						mode: { type: "string", enum: ["overwrite", "append", "create"] },
						confirm: { type: "boolean" },
					},
					required: ["path", "content"],
				},
			},
			{
				name: "vault_link",
				description: "在 fromPath 笔记末尾追加一条指向 toPath 的 wikilink",
				inputSchema: {
					type: "object",
					properties: {
						fromPath: { type: "string" },
						toPath: { type: "string" },
						label: { type: "string" },
						confirm: { type: "boolean" },
					},
					required: ["fromPath", "toPath"],
				},
			},
			{
				name: "plugins_list",
				description: "列出已安装插件及启用状态",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "commands_list",
				description: "列出插件可用命令（可按插件 id 过滤）",
				inputSchema: {
					type: "object",
					properties: { pluginId: { type: "string" } },
				},
			},
			{
				name: "skills_list",
				description: "列出本地可用 skills（来自 cc-switch / codex / agents）",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "skill_read",
				description: "读取某个 skill 的完整说明",
				inputSchema: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
			{
				name: "ai_chat",
				description: "调用本地 AI 模型做一次独立问答",
				inputSchema: {
					type: "object",
					properties: {
						message: { type: "string" },
						system: { type: "string" },
						model: { type: "string" },
					},
					required: ["message"],
				},
			},
			{
				name: "open_chat_view",
				description: "在 Obsidian 中打开 AI 助手对话界面",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "community_search",
				description: "在 Obsidian 官方社区插件库中搜索插件",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string" },
						max: { type: "number" },
					},
					required: ["query"],
				},
			},
			{
				name: "plugin_install",
				description:
					"安装一个社区插件（需要 confirm:true；会从 GitHub Release 下载 main.js/manifest.json 到 .obsidian/plugins）",
				inputSchema: {
					type: "object",
					properties: {
						id: { type: "string" },
						confirm: { type: "boolean" },
					},
					required: ["id"],
				},
			},
			{
				name: "config_read",
				description: "读取插件 data.json 或 .obsidian 下的 JSON 配置",
				inputSchema: {
					type: "object",
					properties: {
						target: { type: "string", description: "插件 id 或 .obsidian/xxx.json 路径" },
					},
					required: ["target"],
				},
			},
			{
				name: "config_apply",
				description: "修改插件配置（需要 confirm:true；先 config_read 拿到当前内容，再给 next 完整配置）",
				inputSchema: {
					type: "object",
					properties: {
						target: { type: "string" },
						next: { type: "object" },
						confirm: { type: "boolean" },
					},
					required: ["target", "next"],
				},
			},
		];
	}

	// ---------- AI 对话（流式 + 工具循环） ----------

	async streamChat(messages, opts, onDelta) {
		const model = (opts && opts.model) || this.settings.model;
		const useTools = this.settings.enableTools && (!opts || opts.tools !== false);
		const body = {
			model,
			messages,
			max_tokens: this.settings.maxTokens,
			temperature: this.settings.temperature,
			stream: true,
		};
		if (useTools) body.tools = this.buildToolsSpec();

		let attempt = 0;
		let lastErr = null;
		while (attempt < 3) {
			attempt++;
			try {
				return await this.streamChatOnce(body, onDelta);
			} catch (err) {
				lastErr = err;
				const isTimeout = err && /超时/.test(err.message || "");
				if (attempt >= 3 || isTimeout) break;
				await sleep(1200 * attempt);
			}
		}
		throw lastErr || new Error("AI 请求失败");
	}

	async streamChatOnce(body, onDelta) {
		const url = this.settings.aiBaseUrl.replace(/\/+$/, "") + "/chat/completions";
		const firstTokenMs = this.settings.firstTokenTimeoutMs || 60000;
		const idleMs = this.settings.idleTimeoutMs || 30000;
		const totalMs = this.settings.totalTimeoutMs || 180000;
		
		// 优先走 fetch 流式（带超时控制，避免上游挂起时界面无限转圈）
		if (typeof fetch === "function") {
			const controller = new AbortController();
			let firstTokenTimer = null;
			let idleTimer = null;
			let totalTimer = null;
			let timedOut = false;
			const clearTimers = () => {
				if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
				if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
				if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
			};
			const abort = () => {
				timedOut = true;
				clearTimers();
				try { controller.abort(); } catch (err) {}
			};
			try {
				firstTokenTimer = setTimeout(abort, firstTokenMs);
				totalTimer = setTimeout(abort, totalMs);
				const resp = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				clearTimeout(firstTokenTimer);
				firstTokenTimer = null;
				if (!resp.ok) {
					let detail = "";
					try {
						detail = (await resp.text()).slice(0, 300);
					} catch (err) {}
					clearTimers();
					throw new Error("AI 请求失败 (" + resp.status + "): " + detail);
				}
				const reader = resp.body.getReader();
				const decoder = new TextDecoder("utf-8");
				let buffer = "";
				let content = "";
				const toolCalls = [];
				let toolIndex = -1;
				const events = [];
				for (;;) {
					if (idleTimer) clearTimeout(idleTimer);
					idleTimer = setTimeout(abort, idleMs);
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					buffer = parseSseBuffer(buffer, events);
					for (const ev of events) {
						const choice = ev.choices && ev.choices[0];
						if (!choice) continue;
						const delta = choice.delta || {};
						if (delta.content) {
							content += delta.content;
							if (onDelta) onDelta(delta.content);
						}
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								if (tc.index !== undefined && tc.index !== toolIndex) {
									toolIndex = tc.index;
									toolCalls.push({
										id: tc.id || "call_" + toolCalls.length,
										type: "function",
										function: { name: "", arguments: "" },
									});
								}
								const cur = toolCalls[toolCalls.length - 1];
								if (tc.id) cur.id = tc.id;
								if (tc.function && tc.function.name) cur.function.name += tc.function.name;
								if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
							}
						}
					}
					events.length = 0;
				}
				clearTimers();
				return {
					content,
					tool_calls: toolCalls.length ? toolCalls : undefined,
					finish_reason: "stop",
				};
			} catch (err) {
				clearTimers();
				if (timedOut || (err && err.name === "AbortError")) {
					throw new Error(
						"AI 请求超时（" + Math.round(firstTokenMs / 1000) + "s 未返回数据），请检查 cc-switch 代理与上游模型是否可用"
					);
				}
				if (err && /请求失败/.test(err.message)) throw err;
				// fetch 不可用/CSP 拦截 → 降级非流式
				console.warn("[AI Vault Assistant] 流式请求失败，降级非流式:", err);
			}
		}
		
		// 非流式降级（requestUrl 无取消机制，用竞速兜底，避免界面无限转圈）
		const res = await withTimeout(
			requestUrl({
				url,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(Object.assign({}, body, { stream: false })),
				throw: false,
			}),
			totalMs,
			"AI 请求超时（非流式，请检查 cc-switch 代理与上游）"
		);
		if (res.status !== 200) {
			throw new Error(
				"AI 请求失败 (" + res.status + "): " + String(res.text || "").slice(0, 300)
			);
		}
		let data = res.json;
		if (!data) { try { data = JSON.parse(res.text); } catch (err) { data = {}; } }
		const msg = data.choices && data.choices[0] && data.choices[0].message;
		const content = (msg && msg.content) || "";
		if (onDelta) onDelta(content);
		return {
			content,
			tool_calls: msg && msg.tool_calls,
			finish_reason: data.choices && data.choices[0] && data.choices[0].finish_reason,
		};
	}
		async callAI(message, system, model) {
		const messages = [];
		if (system) messages.push({ role: "system", content: system });
		messages.push({ role: "user", content: message || "" });
		const res = await this.streamChat(messages, { model: model || this.settings.model, tools: false }, null);
		return { ok: true, reply: res.content || "" };
	}

	// ---------- 工具执行 ----------

	resolveConfigTarget(target) {
		if (!target) return null;
		if (typeof target === "string" && (target.startsWith(".obsidian/") || target.startsWith(".obsidian\\"))) {
			return { path: normalizePath(target), kind: "file" };
		}
		return { path: normalizePath(".obsidian/plugins/" + target + "/data.json"), kind: "plugin" };
	}

	async runTool(name, args, opts) {
		opts = opts || {};
		const confirmMode = opts.confirmMode || "auto";
		const needConfirm = (desc) => {
			if (confirmMode === "required") {
				if (!args || !args.confirm) {
					return Promise.resolve({ ok: false, error: "该操作需要 confirm: true 参数确认" });
				}
				return Promise.resolve(null);
			}
			if (confirmMode === "modal") {
				return this.confirmModal("确认操作", desc).then((ok) =>
					ok ? null : { ok: false, error: "用户取消操作" }
				);
			}
			return Promise.resolve(null);
		};

		try {
			switch (name) {
				case "vault_tree": {
					const files = await this.listVaultFiles(true);
					const max = (args && args.max) || this.settings.vaultTreeMaxEntries;
					return {
						ok: true,
						count: files.length,
						files: files
							.slice(0, max)
							.map((f) => f.path + (f.size ? " (" + f.size + "B)" : "")),
					};
				}
				case "vault_read": {
					if (!args || !args.path) return { ok: false, error: "缺少 path" };
					const norm = normalizePath(args.path);
					if (!(await this.app.vault.adapter.exists(norm))) {
						return { ok: false, error: "文件不存在: " + norm };
					}
					const content = await this.app.vault.adapter.read(norm);
					return { ok: true, path: norm, content, size: content.length };
				}
				case "vault_search": {
					const q = String((args && args.query) || "").toLowerCase();
					if (!q) return { ok: false, error: "缺少 query" };
					const max = (args && args.max) || 20;
					const files = this.app.vault.getMarkdownFiles();
					const hits = [];
					for (const f of files) {
						if (f.path.toLowerCase().includes(q)) {
							hits.push({ path: f.path, match: "文件名" });
							if (hits.length >= max) break;
						}
					}
					if (hits.length < max) {
						for (const f of files) {
							if (hits.some((h) => h.path === f.path)) continue;
							try {
								const text = await this.app.vault.cachedRead(f);
								if (text && text.toLowerCase().includes(q)) {
									const idx = text.toLowerCase().indexOf(q);
									hits.push({
										path: f.path,
										match:
											"内容: …" +
											text.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, " ") +
											"…",
									});
									if (hits.length >= max) break;
								}
							} catch (err) {}
						}
					}
					return { ok: true, query: args.query, count: hits.length, hits };
				}
				case "vault_write": {
					if (!args || !args.path || typeof args.content !== "string") {
						return { ok: false, error: "缺少 path/content" };
					}
					const norm = normalizePath(args.path);
					const exists = await this.app.vault.adapter.exists(norm);
					const mode = args.mode || (exists ? "overwrite" : "create");
					if (mode === "create" && exists) {
						return { ok: false, error: "文件已存在，若要覆盖请用 overwrite" };
					}
					const c = await needConfirm(
						"写入文件 " + norm + "（" + mode + "，" + args.content.length + " 字符）\n\n" + args.content.slice(0, 800)
					);
					if (c) return c;
					if (mode === "append") {
						const old = await this.app.vault.adapter.read(norm);
						await this.app.vault.adapter.write(norm, old + "\n" + args.content);
					} else {
						await this.app.vault.adapter.write(norm, args.content);
					}
					return { ok: true, path: norm, mode, size: args.content.length };
				}
				case "vault_link": {
					const fromPath = normalizePath((args && args.fromPath) || "");
					const toPath = (args && args.toPath) || "";
					if (!fromPath || !toPath) return { ok: false, error: "缺少 fromPath/toPath" };
					const link = "[[" + toPath + (args.label ? "|" + args.label : "") + "]]";
					const c = await needConfirm("在 " + fromPath + " 末尾追加 wikilink → " + link);
					if (c) return c;
					const old = await this.app.vault.adapter.read(fromPath);
					await this.app.vault.adapter.write(
						fromPath,
						old + (old.endsWith("\n") ? "" : "\n") + link + "\n"
					);
					return { ok: true, path: fromPath, link };
				}
				case "plugins_list":
					return { ok: true, plugins: await this.listInstalledPlugins() };
				case "commands_list": {
					const cmds = this.listCommands(args && args.pluginId);
					return { ok: true, count: cmds.length, commands: cmds.slice(0, 300) };
				}
				case "skills_list":
					return {
						ok: true,
						count: (this.skills || []).length,
						skills: (this.skills || []).map((s) => ({
							name: s.name,
							description: s.description,
						})),
					};
				case "skill_read": {
					const skill = (this.skills || []).find((s) => s.name === (args && args.name));
					if (!skill) return { ok: false, error: "未找到 skill: " + (args && args.name) };
					try {
						const fs = require("fs");
						return {
							ok: true,
							name: skill.name,
							content: fs.readFileSync(skill.path, "utf8").slice(0, 12000),
						};
					} catch (err) {
						return { ok: false, error: err.message };
					}
				}
				case "ai_chat":
					return await this.callAI(args && args.message, args && args.system, args && args.model);
				case "community_search":
					return await this.searchCommunity(args && args.query, args && args.max);
				case "plugin_install": {
					const c = await needConfirm(
						"安装社区插件 " + (args && args.id) + "？将下载 GitHub Release 到 .obsidian/plugins/"
					);
					if (c) return c;
					const installed = await this.installCommunityPlugin(args && args.id);
					return { ok: true, installed };
				}
				case "config_read": {
					const target = this.resolveConfigTarget(args && args.target);
					if (!target) return { ok: false, error: "无效 target，应为插件 id 或 .obsidian 下的 JSON 路径" };
					if (!(await this.app.vault.adapter.exists(target.path))) {
						return { ok: false, error: "配置文件不存在: " + target.path };
					}
					const content = await this.app.vault.adapter.read(target.path);
					let parsed = null;
					try {
						parsed = JSON.parse(content);
					} catch (err) {}
					return { ok: true, target: target.path, content, parsed };
				}
				case "config_apply": {
					const target = this.resolveConfigTarget(args && args.target);
					if (!target) return { ok: false, error: "无效 target" };
					const exists = await this.app.vault.adapter.exists(target.path);
					const cur = exists ? await this.app.vault.adapter.read(target.path) : "";
					let nextStr = "";
					if (typeof args.next === "string") {
						nextStr = args.next;
					} else {
						try {
							nextStr = JSON.stringify(args.next, null, "\t");
						} catch (err) {
							return { ok: false, error: "next 无法序列化" };
						}
					}
					const diff = makeDiff(cur, nextStr);
					const c = await needConfirm("修改配置 " + target.path + "：\n\n" + diff.slice(0, 2000));
					if (c) return c;
					await this.app.vault.adapter.write(target.path, nextStr);
					return { ok: true, target: target.path, diff };
				}
				case "open_chat_view": {
					const view = this.openChatView();
					return { ok: true, opened: !!view };
				}
				default:
					return { ok: false, error: "未知工具: " + name };
			}
		} catch (err) {
			return { ok: false, error: (err && err.message) || String(err) };
		}
	}

	// ---------- 社区插件 ----------

	async getCommunityRegistry() {
		if (!this.registryCache) {
			const res = await requestUrl({ url: COMMUNITY_PLUGINS_URL, throw: false });
			if (res.status === 200) {
				try {
					this.registryCache = JSON.parse(res.text);
				} catch (err) {
					this.registryCache = [];
				}
			} else {
				this.registryCache = [];
			}
		}
		return this.registryCache;
	}

	async searchCommunity(query, max) {
		const registry = await this.getCommunityRegistry();
		const q = String(query || "").toLowerCase();
		const out = [];
		for (const p of registry) {
			if (!p || !p.id) continue;
			if (
				!q ||
				p.id.toLowerCase().includes(q) ||
				(p.name || "").toLowerCase().includes(q) ||
				(p.description || "").toLowerCase().includes(q)
			) {
				out.push({
					id: p.id,
					name: p.name,
					author: p.author,
					description: p.description,
					repo: p.repo,
				});
				if (out.length >= (max || 10)) break;
			}
		}
		return { ok: true, query, count: out.length, plugins: out };
	}

	async installCommunityPlugin(id) {
		if (!id) throw new Error("缺少插件 id");
		const registry = await this.getCommunityRegistry();
		const entry = registry.find((p) => p && p.id === id);
		if (!entry || !entry.repo) throw new Error("未在官方插件库中找到 " + id);
		const release = await requestJson("https://api.github.com/repos/" + entry.repo + "/releases/latest");
		const tag = release.tag_name;
		if (!tag || !Array.isArray(release.assets)) throw new Error("无法获取发布信息");
		const assetNames = new Set(release.assets.map((a) => a.name));
		const adapter = this.app.vault.adapter;
		const dir = normalizePath(".obsidian/plugins/" + id);
		const downloaded = [];
		for (const name of ["main.js", "manifest.json", "styles.css"]) {
			if (!assetNames.has(name)) continue;
			const buf = await requestBinary(
				"https://github.com/" + entry.repo + "/releases/download/" + encodeURIComponent(tag) + "/" + name
			);
			await adapter.writeBinary(normalizePath(dir + "/" + name), buf);
			downloaded.push(name);
		}
		if (!downloaded.includes("main.js") || !downloaded.includes("manifest.json")) {
			throw new Error(
				"发布包缺少 main.js/manifest.json（可用资源: " + (assetNames.size ? [...assetNames].join(", ") : "无") + "）"
			);
		}
		const enabledPath = normalizePath(".obsidian/community-plugins.json");
		let enabled = [];
		try {
			enabled = JSON.parse(await adapter.read(enabledPath)) || [];
		} catch (err) {}
		if (!enabled.includes(id)) enabled.push(id);
		await adapter.write(enabledPath, JSON.stringify(enabled, null, "\t"));
		return { id, files: downloaded, enabled: true };
	}

	// ---------- UI 入口 ----------

	confirmModal(title, message) {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText(title);
			const content = modal.contentEl;
			content.createEl("pre", { text: message, cls: "ava-confirm-text" });
			const btnRow = content.createDiv({ cls: "ava-confirm-buttons" });
			const cancelBtn = btnRow.createEl("button", { text: "取消" });
			cancelBtn.addEventListener("click", () => {
				modal.close();
				resolve(false);
			});
			const okBtn = btnRow.createEl("button", { text: "确认执行", cls: "mod-cta" });
			okBtn.addEventListener("click", () => {
				modal.close();
				resolve(true);
			});
			modal.onClose = () => resolve(false);
			modal.open();
		});
	}

	openChatView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length) {
			this.app.workspace.revealLeaf(leaves[0]);
			return leaves[0].view;
		}
		let leaf = null;
		try {
			if (this.app.workspace.getRightLeaf) leaf = this.app.workspace.getRightLeaf(false);
		} catch (err) {}
		if (!leaf) {
			try {
				if (this.app.workspace.getLeftLeaf) leaf = this.app.workspace.getLeftLeaf(false);
			} catch (err) {}
		}
		if (!leaf && this.app.workspace.getLeaf) {
			try {
				leaf = this.app.workspace.getLeaf(true);
			} catch (err) {}
		}
		if (!leaf) return null;
		leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
		return leaf.view;
	}

	askOrganize() {
		const view = this.openChatView();
		if (view && view.autoSend) {
			view.autoSend(
				"请帮我整理这个 Vault：先分析整体结构，生成一份 MOC/总览笔记（存到 `00-概览/MOC.md`），" +
					"并为主要主题建立相互关联的索引笔记。写操作前先说明计划。"
			);
		}
	}

	openPluginsModal() {
		const modal = new Modal(this.app);
		modal.titleEl.setText("已安装插件与命令");
		const listEl = modal.contentEl.createDiv({ cls: "ava-modal-list" });
		this.listInstalledPlugins().then((plugins) => {
			for (const p of plugins) {
				const row = listEl.createDiv({ cls: "ava-plugin-row ava-plugin-block" });
				const info = row.createDiv({ cls: "ava-plugin-info" });
				info.createEl("div", {
					text: p.name + " v" + p.version + (p.enabled ? "" : "（已停用）"),
					cls: "ava-plugin-name",
				});
				info.createEl("div", {
					text: p.id + (p.author ? " — " + p.author : ""),
					cls: "ava-plugin-desc",
				});
				const cmds = this.listCommands(p.id);
				if (cmds.length) {
					const cmdEl = info.createDiv({ cls: "ava-cmds" });
					for (const c of cmds.slice(0, 60)) {
						cmdEl.createEl("div", {
							text: "• " + c.id + (c.name ? "：" + c.name : ""),
							cls: "ava-cmd",
						});
					}
				}
			}
		});
		modal.open();
	}

	openCommunityModal() {
		new CommunityInstallModal(this.app, this).open();
	}

	openConfigPicker() {
		const modal = new Modal(this.app);
		modal.titleEl.setText("选择要编辑配置的插件");
		const listEl = modal.contentEl.createDiv({ cls: "ava-modal-list" });
		this.listInstalledPlugins().then((plugins) => {
			if (!plugins.length) {
				listEl.createEl("div", { text: "没有找到已安装插件。" });
				return;
			}
			for (const p of plugins) {
				const row = listEl.createDiv({ cls: "ava-plugin-row" });
				const info = row.createDiv({ cls: "ava-plugin-info" });
				info.createEl("div", { text: p.name + "（" + p.id + "）", cls: "ava-plugin-name" });
				const btn = row.createEl("button", { text: "编辑 data.json", cls: "mod-cta" });
				btn.addEventListener("click", () => {
					modal.close();
					new ConfigEditModal(this.app, this, p.id).open();
				});
			}
		});
		modal.open();
	}

	// ---------- MCP 服务 ----------

	startMcpServer() {
		const http = require("http");
		this.mcpServer = http.createServer((req, res) => this.handleMcpRequest(req, res));
		this.mcpServer.on("error", (err) => {
			console.error("[AI Vault Assistant] MCP 服务错误:", err);
			new Notice("AI Vault Assistant MCP 端口 " + this.settings.mcpPort + " 启动失败: " + err.message);
		});
		this.mcpServer.listen(this.settings.mcpPort, "127.0.0.1", () => {
			console.log(
				"[AI Vault Assistant] MCP server: http://127.0.0.1:" + this.settings.mcpPort + "/mcp"
			);
		});
	}

	stopMcpServer() {
		if (this.mcpServer) {
			try {
				this.mcpServer.close();
			} catch (err) {}
			this.mcpServer = null;
		}
	}

	handleMcpRequest(req, res) {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization, Mcp-Session-Id, X-Obsidian-Token"
		);
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (req.method === "GET") {
			this.mcpJson(res, 200, {
				ok: true,
				name: "ai-vault-assistant",
				version: this.manifest.version,
				usage: "POST /mcp (JSON-RPC 2.0)，需要 Authorization: Bearer <token>",
			});
			return;
		}
		if (req.method !== "POST") {
			this.mcpJson(res, 405, jsonRpcError(null, -32600, "仅支持 POST /mcp"));
			return;
		}
		if (this.settings.mcpAuthRequired) {
			const auth = req.headers["authorization"] || "";
			const xt = req.headers["x-obsidian-token"] || "";
			const token = auth.replace(/^Bearer\s+/i, "").trim();
			if (token !== this.settings.mcpToken && xt !== this.settings.mcpToken) {
				this.mcpJson(
					res,
					401,
					jsonRpcError(null, -32001, "未授权：需要 Bearer token（可在插件设置中查看/复制）")
				);
				return;
			}
		}
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (d) => {
			raw += d;
			if (raw.length > 2 * 1024 * 1024) {
				res.destroy();
			}
		});
		req.on("end", () => {
			let msg = null;
			try {
				msg = JSON.parse(raw);
			} catch (err) {
				this.mcpJson(res, 400, jsonRpcError(null, -32700, "Invalid JSON"));
				return;
			}
			this.handleMcpMessage(msg, res);
		});
		req.on("error", () => {});
	}

	mcpJson(res, status, obj) {
		const body = JSON.stringify(obj);
		res.writeHead(status, {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	}

	async handleMcpMessage(msg, res) {
		if (!msg || msg.jsonrpc !== "2.0") {
			this.mcpJson(res, 400, jsonRpcError(msg && msg.id, -32600, "需要 JSON-RPC 2.0"));
			return;
		}
		const id = msg.id;
		const method = msg.method;
		try {
			if (method === "initialize") {
				this.mcpJson(res, 200, {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "ai-vault-assistant", version: this.manifest.version },
					},
				});
			} else if (method === "notifications/initialized" || method === "notifications/cancelled") {
				res.writeHead(202, { "Content-Type": "application/json" });
				res.end();
			} else if (method === "ping") {
				this.mcpJson(res, 200, { jsonrpc: "2.0", id, result: {} });
			} else if (method === "tools/list") {
				this.mcpJson(res, 200, {
					jsonrpc: "2.0",
					id,
					result: { tools: this.buildToolsSpec() },
				});
			} else if (method === "tools/call") {
				const params = msg.params || {};
				const result = await this.runTool(params.name, params.arguments || {}, {
					confirmMode: "required",
				});
				const text = JSON.stringify(result, null, 2);
				this.mcpJson(res, 200, {
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text }],
						isError: !!(result && result.ok === false),
					},
				});
			} else if (method === "resources/list" || method === "prompts/list") {
				this.mcpJson(res, 200, {
					jsonrpc: "2.0",
					id,
					result: method === "resources/list" ? { resources: [] } : { prompts: [] },
				});
			} else {
				this.mcpJson(res, 200, jsonRpcError(id, -32601, "未知方法: " + method));
			}
		} catch (err) {
			this.mcpJson(res, 200, jsonRpcError(id, -32603, (err && err.message) || String(err)));
		}
	}
};

// ---------- 对话视图 ----------

class ChatView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.history = [];
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "AI Vault 助手";
	}

	getIcon() {
		return "bot";
	}

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		container.addClass("ava-chat");

		const header = container.createDiv({ cls: "ava-header" });
		header.createEl("span", { text: "AI Vault 助手", cls: "ava-title" });
		this.statusEl = header.createEl("span", { text: "", cls: "ava-status" });

		const modelRow = container.createDiv({ cls: "ava-model-row" });
		this.modelSelect = modelRow.createEl("select", { cls: "ava-model-select" });
		this.modelSelect.addEventListener("change", () => {
			this.plugin.settings.model = this.modelSelect.value;
			this.plugin.saveSettings();
		});
		this.modelInput = modelRow.createEl("input", {
			cls: "ava-model-input",
			attr: { type: "text", placeholder: "或输入自定义模型后回车" },
		});
		this.modelInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && this.modelInput.value.trim()) {
				const m = this.modelInput.value.trim();
				this.plugin.settings.model = m;
				if (!this.plugin.settings.customModels.includes(m)) {
					this.plugin.settings.customModels.push(m);
				}
				this.plugin.saveSettings();
				this.refreshModelSelect();
			}
		});
		const refreshBtn = modelRow.createEl("button", { text: "刷新模型", cls: "ava-btn" });
		refreshBtn.addEventListener("click", () => this.plugin.refreshModelList(true));
		const pluginsBtn = modelRow.createEl("button", { text: "插件/命令", cls: "ava-btn" });
		pluginsBtn.addEventListener("click", () => this.plugin.openPluginsModal());
		const newBtn = modelRow.createEl("button", { text: "新会话", cls: "ava-btn" });
		newBtn.addEventListener("click", () => this.resetChat());

		this.msgContainer = container.createDiv({ cls: "ava-messages" });

		const inputBar = container.createDiv({ cls: "ava-input-bar" });
		this.inputEl = inputBar.createEl("textarea", {
			cls: "ava-input",
			attr: { placeholder: "输入消息…（Enter 发送，Shift+Enter 换行）", rows: "3" },
		});
		const sendBtn = inputBar.createEl("button", { text: "发送", cls: "ava-send mod-cta" });
		sendBtn.addEventListener("click", () => this.onSend());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.onSend();
			}
		});

		this.refreshModelSelect();
		this.showWelcome();
	}

	async onClose() {}

	refreshModelSelect() {
		if (!this.modelSelect) return;
		const model = this.plugin.settings.model;
		const list = (this.plugin.modelList || []).slice();
		if (!list.includes(model)) list.unshift(model);
		this.modelSelect.empty();
		for (const m of list) {
			const opt = this.modelSelect.createEl("option", { text: m, value: m });
			if (m === model) opt.selected = true;
		}
	}

	showWelcome() {
		this.msgContainer.empty();
		const box = this.msgContainer.createDiv({ cls: "ava-msg ava-welcome" });
		box.createEl("p", { text: "你好！我是 AI Vault 助手，已接入你的 cc-switch 本地代理。" });
		box.createEl("p", {
			text: "我可以：整理文件、生成 MOC 与双链、分析全库、列出插件与命令、搜索并安装社区插件、修改插件配置（都会先经你确认）。",
		});
		const tips = box.createEl("ul");
		const tipTexts = [
			"帮我整理 Vault，生成总览 MOC",
			"找出长期没更新的笔记并归类",
			"推荐几个做双链可视化的插件",
			"列出所有已安装插件和命令",
		];
		for (const t of tipTexts) {
			const li = tips.createEl("li");
			const btn = li.createEl("button", { text: t, cls: "ava-tip" });
			btn.addEventListener("click", () => this.autoSend(t));
		}
	}

	resetChat() {
		this.history = [];
		this.setStatus("");
		this.showWelcome();
	}

	setStatus(text) {
		if (this.statusEl) this.statusEl.textContent = text;
	}

	addMessage(role, text) {
		const wrap = this.msgContainer.createDiv({ cls: "ava-msg ava-" + role });
		const bubble = wrap.createEl("div", { cls: "ava-bubble" + (role === "assistant" ? " ava-md" : "") });
		if (role === "assistant") {
			this.renderMarkdown(text || "", bubble);
		} else {
			bubble.textContent = text || "";
		}
		return bubble;
	}

	renderMarkdown(md, el) {
		try {
			MarkdownRenderer.renderMarkdown(md || "", el, "", this);
		} catch (err) {
			el.textContent = md || "";
		}
	}

	onSend() {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		this.send(text);
	}

	autoSend(text) {
		this.inputEl.value = text;
		this.onSend();
	}

	scrollToBottom() {
		this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
	}

	async send(text) {
		this.setStatus("思考中…");
		this.addMessage("user", text);
		this.history.push({ role: "user", content: text });
		const bubble = this.addMessage("assistant", "");
		const streamTarget = bubble;

		let full = "";
		const onDelta = (chunk) => {
			full += chunk;
			streamTarget.empty();
			this.renderMarkdown(full, streamTarget);
			this.scrollToBottom();
		};

		try {
			const system = await this.plugin.buildSystemPrompt();
			const messages = [{ role: "system", content: system }, ...this.history];

			for (
				let round = 0;
				round <= this.plugin.settings.maxToolRounds;
				round++
			) {
				const { content, tool_calls } = await this.plugin.streamChat(
					messages,
					{ model: this.plugin.settings.model },
					onDelta
				);
				if (
					tool_calls &&
					tool_calls.length &&
					this.plugin.settings.enableTools
				) {
					messages.push({ role: "assistant", content: content || "", tool_calls });
					for (const tc of tool_calls) {
						let fnName = "";
						let args = {};
						try {
							fnName = (tc.function && tc.function.name) || "";
							args = JSON.parse((tc.function && tc.function.arguments) || "{}");
						} catch (err) {
							args = {};
						}
						this.setStatus("执行工具: " + fnName + "…");
						const result = await this.plugin.runTool(fnName, args, {
							confirmMode: "modal",
						});
						const toolMsg = this.msgContainer.createDiv({ cls: "ava-msg ava-tool" });
						toolMsg.createEl("span", { text: "🔧 " + fnName, cls: "ava-tool-name" });
						toolMsg.createEl("span", {
							text: JSON.stringify(result).slice(0, 220),
							cls: "ava-tool-result",
						});
						this.scrollToBottom();
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: JSON.stringify(result),
						});
					}
					full = "";
					this.setStatus("继续推理…");
					continue;
				} else {
					full = content || full;
					streamTarget.empty();
					this.renderMarkdown(full, streamTarget);
					break;
				}
			}
			this.history.push({ role: "assistant", content: full });
			this.setStatus("");
			this.scrollToBottom();
		} catch (err) {
			this.setStatus("");
			const wrap = this.msgContainer.createDiv({ cls: "ava-msg ava-error" });
			const bubbleErr = wrap.createEl("div", {
				text: "请求失败: " + ((err && err.message) || err),
				cls: "ava-bubble",
			});
			this.scrollToBottom();
		}
	}
}

// ---------- 社区插件安装 ----------

class CommunityInstallModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		this.titleEl.setText("搜索并安装社区插件");
		const { contentEl } = this;
		const searchRow = contentEl.createDiv({ cls: "ava-modal-search" });
		const input = searchRow.createEl("input", {
			attr: { type: "text", placeholder: "输入插件名/关键词，如 dataview" },
		});
		const btn = searchRow.createEl("button", { text: "搜索", cls: "mod-cta" });
		const listEl = contentEl.createDiv({ cls: "ava-modal-list" });

		const run = async () => {
			const q = input.value.trim();
			if (!q) return;
			listEl.empty();
			listEl.createEl("div", { text: "搜索中…" });
			try {
				const res = await this.plugin.searchCommunity(q, 12);
				listEl.empty();
				if (!res.plugins.length) {
					listEl.createEl("div", { text: "没有找到匹配的插件。" });
					return;
				}
				for (const p of res.plugins) {
					const row = listEl.createDiv({ cls: "ava-plugin-row" });
					const info = row.createDiv({ cls: "ava-plugin-info" });
					info.createEl("div", { text: p.name + "（" + p.id + "）", cls: "ava-plugin-name" });
					info.createEl("div", {
						text: (p.author || "") + (p.description ? " — " + p.description : ""),
						cls: "ava-plugin-desc",
					});
					const installBtn = row.createEl("button", { text: "安装", cls: "mod-cta" });
					installBtn.addEventListener("click", async () => {
						const ok = await this.plugin.confirmModal(
							"安装插件",
							"确定安装 " + p.name + "？\n将下载 GitHub Release 到 .obsidian/plugins/" + p.id + " 并启用。"
						);
						if (!ok) return;
						installBtn.setText("安装中…");
						installBtn.disabled = true;
						try {
							const r = await this.plugin.installCommunityPlugin(p.id);
							new Notice("已安装 " + p.name + "（" + r.files.join(", ") + "）");
						} catch (err) {
							new Notice("安装失败: " + err.message);
						}
						installBtn.setText("安装");
						installBtn.disabled = false;
					});
				}
			} catch (err) {
				listEl.empty();
				listEl.createEl("div", { text: "搜索失败: " + err.message });
			}
		};

		btn.addEventListener("click", run);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") run();
		});
		input.focus();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------- 配置编辑 ----------

class ConfigEditModal extends Modal {
	constructor(app, plugin, target) {
		super(app);
		this.plugin = plugin;
		this.target = target;
	}

	async onOpen() {
		this.titleEl.setText("插件配置：" + this.target);
		const { contentEl } = this;
		const res = await this.plugin.runTool(
			"config_read",
			{ target: this.target },
			{ confirmMode: "auto" }
		);
		const textarea = contentEl.createEl("textarea", {
			cls: "ava-config-editor",
			attr: { rows: "16", spellcheck: "false" },
		});
		textarea.value = res.ok ? res.content || "" : "";
		if (!res.ok) {
			contentEl.createEl("div", { text: res.error || "", cls: "ava-plugin-desc" });
		}
		const diffEl = contentEl.createDiv({ cls: "ava-config-diff" });
		const updateDiff = () => {
			diffEl.empty();
			diffEl.createEl("div", { text: "改动预览：", cls: "ava-config-diff-title" });
			diffEl.createEl("pre", {
				text: makeDiff(res.ok ? res.content : "", textarea.value).slice(0, 3000),
				cls: "ava-config-diff-pre",
			});
		};
		textarea.addEventListener("input", updateDiff);
		updateDiff();

		const btnRow = contentEl.createDiv({ cls: "ava-confirm-buttons" });
		const saveBtn = btnRow.createEl("button", { text: "保存并应用", cls: "mod-cta" });
		saveBtn.addEventListener("click", async () => {
			let next = textarea.value;
			try {
				next = JSON.stringify(JSON.parse(next), null, "\t");
			} catch (err) {}
			const ok = await this.plugin.confirmModal(
				"确认修改配置",
				"将把以下内容写入 " + this.target + "：\n\n" + next.slice(0, 2000)
			);
			if (!ok) return;
			const r = await this.plugin.runTool(
				"config_apply",
				{ target: this.target, next },
				{ confirmMode: "auto" }
			);
			if (r.ok) new Notice("配置已更新: " + this.target);
			else new Notice("更新失败: " + (r.error || ""));
			this.close();
		});
		const cancelBtn = btnRow.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------- 设置页 ----------

class AIVaultAssistantSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h3", { text: "cc-switch 状态" });
		const info = containerEl.createDiv({ cls: "ava-cc-info" });
		const cc = this.plugin.readCCSwitchSettings();
		const ccDir = this.plugin.getCCSwitchDir();
		if (cc) {
			info.createEl("div", { text: "配置目录：" + (ccDir || "未找到") });
			info.createEl("div", {
				text:
					"本地代理：" +
					(cc.enableLocalProxy ? "已启用" : "未启用") +
					"（" +
					this.plugin.settings.aiBaseUrl +
					"）",
			});
			info.createEl("div", { text: "当前 Codex Provider：" + (cc.currentProviderCodex || "-") });
			info.createEl("div", { text: "当前 Claude Provider：" + (cc.currentProviderClaude || "-") });
		} else {
			info.createEl("div", { text: "未读取到 cc-switch 配置，请检查下面的数据目录设置。" });
		}

		new Setting(containerEl)
			.setName("AI 接入地址（cc-switch 本地代理）")
			.setDesc("默认 http://127.0.0.1:15721/v1，对应 cc-switch 的本地代理端口")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:15721/v1")
					.setValue(this.plugin.settings.aiBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.aiBaseUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("默认模型")
			.setDesc("必须是当前 provider 支持的真实模型名（如 deepseek-v4-flash）；也可在对话界面输入自定义模型")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.model)
					.onChange(async (v) => {
						this.plugin.settings.model = v.trim() || "deepseek-v4-flash";
						await this.plugin.saveSettings();
						this.plugin.triggerModelRefresh();
					})
			);

		containerEl.createEl("h3", { text: "AI 超时设置" });
		new Setting(containerEl)
			.setName("首 token 超时（秒）")
			.setDesc("请求发出后多久未收到首个数据即判定超时（默认 60）")
			.addText((text) =>
				text
					.setValue(String(Math.round(this.plugin.settings.firstTokenTimeoutMs / 1000) || 60))
					.onChange(async (v) => {
						const s = parseInt(v, 10);
						if (s > 0 && s <= 600) {
							this.plugin.settings.firstTokenTimeoutMs = s * 1000;
							await this.plugin.saveSettings();
						}
					})
			);
		new Setting(containerEl)
			.setName("流式空闲超时（秒）")
			.setDesc("流式输出中相邻数据间隔超过该时长即判定超时（默认 30）")
			.addText((text) =>
				text
					.setValue(String(Math.round(this.plugin.settings.idleTimeoutMs / 1000) || 30))
					.onChange(async (v) => {
						const s = parseInt(v, 10);
						if (s > 0 && s <= 600) {
							this.plugin.settings.idleTimeoutMs = s * 1000;
							await this.plugin.saveSettings();
						}
					})
			);
		new Setting(containerEl)
			.setName("总超时（秒）")
			.setDesc("单次 AI 请求最长等待时间（默认 180）")
			.addText((text) =>
				text
					.setValue(String(Math.round(this.plugin.settings.totalTimeoutMs / 1000) || 180))
					.onChange(async (v) => {
						const s = parseInt(v, 10);
						if (s > 0 && s <= 3600) {
							this.plugin.settings.totalTimeoutMs = s * 1000;
							await this.plugin.saveSettings();
						}
					})
			);
				new Setting(containerEl)
			.setName("cc-switch 数据目录")
			.setDesc("用于读取 settings.json / cc-switch.db / skills。留空则自动探测")
			.addText((text) =>
				text
					.setPlaceholder("留空自动探测")
					.setValue(this.plugin.settings.ccSwitchDir)
					.onChange(async (v) => {
						this.plugin.settings.ccSwitchDir = v.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshSkillsList();
					})
			);

		new Setting(containerEl)
			.setName("刷新模型列表")
			.setDesc("从代理 /models 与 cc-switch.db 中提取候选模型")
			.addButton((b) =>
				b.setButtonText("立即刷新").setCta().onClick(() => this.plugin.refreshModelList(true))
			);

		containerEl.createEl("h3", { text: "MCP 服务（供外部 Agent 使用）" });
		new Setting(containerEl)
			.setName("启用 MCP 服务")
			.setDesc("在本地端口启动 HTTP MCP 服务，Codex 等外部 Agent 可接入")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.mcpEnabled).onChange(async (v) => {
					this.plugin.settings.mcpEnabled = v;
					await this.plugin.saveSettings();
					if (v) {
						try {
							this.plugin.startMcpServer();
							new Notice("MCP 服务已启动");
						} catch (err) {
							new Notice("启动失败: " + err.message);
						}
					} else {
						this.plugin.stopMcpServer();
						new Notice("MCP 服务已停止");
					}
				})
			);

		new Setting(containerEl)
			.setName("MCP 端口")
			.setDesc("默认 33157")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.mcpPort)).onChange(async (v) => {
					const port = parseInt(v, 10);
					if (port > 0 && port < 65536) {
						this.plugin.settings.mcpPort = port;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("访问 Token")
			.setDesc("外部 Agent 需带 Authorization: Bearer <Token>")
			.addText((text) => text.setValue(this.plugin.settings.mcpToken).setDisabled(true))
			.addButton((b) =>
				b.setButtonText("复制").onClick(() => {
					copyText(this.plugin.settings.mcpToken);
					new Notice("Token 已复制");
				})
			)
			.addButton((b) =>
				b.setButtonText("重新生成").onClick(async () => {
					this.plugin.settings.mcpToken = uuid();
					await this.plugin.saveSettings();
					this.display();
					new Notice("已生成新 Token");
				})
			);

		new Setting(containerEl)
			.setName("复制 Codex 接入配置")
			.setDesc("把复制的内容合并到 ~/.codex/config.toml 的 [mcp_servers] 中，或执行 codex mcp add")
			.addButton((b) =>
				b.setButtonText("复制").setCta().onClick(() => {
					const cfg =
						'[mcp_servers.ai-vault-assistant]\ntype = "http"\nurl = "http://127.0.0.1:' +
						this.plugin.settings.mcpPort +
						'/mcp"\nheaders = { Authorization = "Bearer ' +
						this.plugin.settings.mcpToken +
						'" }';
					copyText(cfg);
					new Notice("Codex 配置已复制");
				})
			);

		new Setting(containerEl)
			.setName("测试 AI 连接")
			.setDesc("向当前模型发送一条 ping，检查代理是否可用（免费上游偶尔 502，会自动重试）")
			.addButton((b) =>
				b.setButtonText("测试").onClick(async () => {
					b.setButtonText("测试中…");
					b.setDisabled(true);
					try {
						const res = await this.plugin.streamChat(
							[{ role: "user", content: "ping" }],
							{ tools: false },
							null
						);
						new Notice("AI 连接正常：" + String(res.content || "").slice(0, 60));
					} catch (err) {
						new Notice("AI 连接失败: " + err.message);
					}
					b.setButtonText("测试");
					b.setDisabled(false);
				})
			);

		containerEl.createEl("h3", { text: "工具" });
		new Setting(containerEl)
			.setName("打开 AI 助手对话")
			.setDesc("在当前窗口打开聊天界面（左侧 Ribbon 机器人图标也可用，或 Ctrl+P 搜命令）")
			.addButton((b) => b.setButtonText("打开").setCta().onClick(() => this.plugin.openChatView()));
		new Setting(containerEl)
			.setName("搜索并安装社区插件")
			.addButton((b) =>
				b.setButtonText("打开").onClick(() => this.plugin.openCommunityModal())
			);
		new Setting(containerEl)
			.setName("编辑已安装插件的配置")
			.addButton((b) => b.setButtonText("打开").onClick(() => this.plugin.openConfigPicker()));
		new Setting(containerEl)
			.setName("查看已安装插件与命令")
			.addButton((b) => b.setButtonText("打开").onClick(() => this.plugin.openPluginsModal()));
	}
}

module.exports.helpers = {
	DEFAULT_SETTINGS,
	MODEL_CATALOG,
	parseSseBuffer,
	uniqueStrings,
	extractDbModels,
	mergeModelList,
	buildVaultIndex,
	makeDiff,
	jsonRpcError,
	withTimeout,
};
