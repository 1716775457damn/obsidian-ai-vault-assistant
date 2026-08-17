# AI Vault Assistant（Obsidian 插件）

一个把 **cc-switch 本地代理**、**Obsidian Vault**、**社区插件生态** 和 **外部 AI Agent（如 Codex）** 串起来的插件。

## 功能

1. **接入 cc-switch 配置并用 AI 对话**
   - 自动探测 `~/.cc-switch`（settings.json + cc-switch.db），读取本地代理地址、当前 Provider 信息。
   - AI 请求走 cc-switch 本地代理 `http://127.0.0.1:15721/v1`（默认端口，可在设置里改），无需手动配置 API Key。
   - 模型下拉 = 代理 `/models` + cc-switch.db 中配置过的模型 + 内置 189 个模型目录 + 自定义模型（可直接输入）。
   - 支持流式输出；免费上游偶发 502 会自动重试 3 次。

2. **读取全部文件 + 读取其他插件与命令**
   - 可读取/搜索/创建/修改库内任意文件（markdown、JSON、附件统计）。
   - 枚举已安装插件（名称/版本/启用状态）与每个插件的命令（`app.commands.listCommands()`）。
   - 对话界面顶部“插件/命令”按钮可直观浏览。

3. **内置 Skills + 开放 MCP 服务**
   - 自动扫描本地 skills：`<cc-switch>/skills`、`~/.codex/skills`、`~/.agents/skills`，注入 AI 系统提示，可通过 `skill_read` 读取全文。
   - 内置本地 HTTP MCP 服务（默认 `127.0.0.1:33157/mcp`，Bearer Token 鉴权），暴露 15 个工具，供 **Codex** 等外部 Agent 接入。

4. **对话界面：整理、互链、装插件、改配置**
   - Ribbon 图标 / 命令面板打开对话视图；支持 Markdown 渲染与流式打字效果。
   - AI 可整理文件、生成 MOC、为笔记建立双链、分析全库。
   - 搜索推荐社区插件并（确认后）从 GitHub Release 安装。
   - 读取/推荐插件配置，展示 diff，**用户确认后**写入 data.json。

## 安装

1. 把 `main.js`、`manifest.json`、`styles.css` 放入 vault 的 `.obsidian/plugins/ai-vault-assistant/`。
2. 打开 Obsidian → 设置 → 第三方插件 → 启用 “AI Vault Assistant”。
3. 确保 cc-switch 正在运行且“本地代理”已启用（默认端口 15721）。

> 本插件仅桌面可用（依赖本地代理与 Node 文件访问）。

## 给外部 Agent（Codex）接入 MCP

1. 在插件设置里复制 **Codex 接入配置**，内容形如：

```toml
[mcp_servers.ai-vault-assistant]
type = "http"
url = "http://127.0.0.1:33157/mcp"
headers = { Authorization = "Bearer <你的Token>" }
```

2. 合并到 `~/.codex/config.toml` 的 `[mcp_servers]` 段（每个 server 一个段落），重启 Codex。

或使用命令：

```bash
codex mcp add ai-vault-assistant --type http --url http://127.0.0.1:33157/mcp --header "Authorization: Bearer <你的Token>"
```

3. 之后 Codex 就能调用这些工具（读文件、搜索、写笔记、装插件、改配置等）。**写操作类工具需要显式传 `confirm: true`**，插件才会执行。

### MCP 工具一览

| 工具 | 说明 | 需确认 |
| --- | --- | --- |
| `vault_tree` | 列出全部文件索引 | 否 |
| `vault_read` | 读取任意文件 | 否 |
| `vault_search` | 按文件名/内容搜索 | 否 |
| `vault_write` | 创建/修改/追加文件 | 是 (`confirm:true`) |
| `vault_link` | 追加 wikilink | 是 |
| `plugins_list` | 已安装插件 | 否 |
| `commands_list` | 插件命令 | 否 |
| `skills_list` / `skill_read` | 内置 skills | 否 |
| `ai_chat` | 独立 AI 问答 | 否 |
| `community_search` | 搜索社区插件 | 否 |
| `plugin_install` | 安装社区插件 | 是 |
| `config_read` | 读取插件配置 | 否 |
| `config_apply` | 修改插件配置 | 是 |

## 常见问题

- **AI 连接失败 / 502**：免费上游会间歇性 502（`Upstream access forbidden`）。插件会自动重试；也可以在 cc-switch 里切换 provider 或换模型。
- **模型 404（Model not supported）**：必须使用当前 provider 真正支持的模型名。打开“刷新模型列表”可从 cc-switch.db 提取配置过的模型。
- **找不到 MCP token**：插件设置 → MCP 服务 → 访问 Token → 复制/重新生成。
- **MCP 端口被占用**：在设置里改端口（默认 33157）后重新启用。
- **写操作总是弹确认**：这是设计——所有写操作（写笔记、装插件、改配置）都必须经你确认；外部 Agent 需要传 `confirm: true`。

## 隐私与安全

- 所有 AI 请求只发往本机 cc-switch 本地代理（默认 `127.0.0.1:15721`），由 cc-switch 转发到你的上游。
- MCP 服务只监听 `127.0.0.1`，并强制 Bearer Token 鉴权。
- 不收集任何遥测；配置仅保存在 vault 的 `data.json`（含自动生成的 MCP Token，请勿外泄）。
