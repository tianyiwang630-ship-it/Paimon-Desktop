# Paimon Desktop Assistant / 派蒙桌面助手

[中文](#中文) | [English](#english)

---

## 中文

Paimon（取名自《原神》中的向导派蒙）是一款本地优先的桌面 AI 助手。你可以把它当作豆包 / DeepSeek / ChatGPT 等聊天应用的“可执行升级版”：不仅能聊，还能在工作区里动手做事。  
升级点（精简版）：🧰 工具可调用（含文件增删改查、运行代码） / 🔁 ReAct 多步推理（决策→执行→观察→再决策） / 📁 会话&项目工作区（文件/文件夹贯穿任务） / 🧩 Skills 可扩展（自建/导入文件夹/GitHub 链接）。  
适用：日常聊天；高效信息搜集与深度报告（推荐配合内置小红书浏览工具）；办公文档处理（Excel/PPT/Word；PDF 目前偏英文流程）；把你的经验沉淀为可复用的对话式工作流（Skill），处理复杂项目与长文阅读笔记。

![派蒙桌面助手主界面](./Screenshot%202026-02-19%20003425.png)

### 核心功能 🧩
- 🖥️ **桌面端 + 本地后端**：基于 Electron + React + FastAPI，启动桌面端即自动拉起本地后端服务。
- 🧷 **会话 / 项目管理**：新建、切换、归档、删除、置顶、重命名，一套流程打通。
- 📁 **文件工作区**：围绕 `input / output / temp`，支持上传、浏览、下载、打包下载。
- 🧰 **统一工具入口**：MCP + Skills + 内置工具（`bash / read / write / append / edit / glob / grep / fetch`）统一编排。
- 🧩 **Skills 零配置加载**：把技能丢进 `skills/`（运行时优先 `runtime/skills/`）-> 自动发现接入，无需改核心代码。
- 🌊 **流式 + 可控执行**：流式对话、执行中断、权限审批后可 `resume` 继续跑。

### AI能力 🧠
- 🔁 **ReAct 推理-行动循环**：先推理 -> 再调用工具执行 -> 观察结果 -> 继续推理，直到产出最终答案。
- 🧰 **多轮工具编排**：工具调用与结果回注贯穿对话过程，支持复杂任务拆解。
- 🧮 **上下文管理**：token 预算分配 + 历史压缩，兼顾长对话与可用性。
- 🔎 **MCP 按需加载**：核心工具常驻，可检索工具通过 BM25 + `tool_search` 动态注入。
- 🧩 **Skills 动态加载**：基于 `SKILL.md` 自动解析为可调用工具（`skill__*`）。
- 💾 **持久化记忆**：会话 / 消息 / 项目 / 设置存储于 SQLite（WAL）。

### 关键Agent技术实现 🛠️
#### 🔁 ReAct 框架
- `agent/core/main.py`：模型输出进入“推理 -> 工具调用 -> 工具结果回注 -> 继续推理”的循环，直到产出最终回答或达到回合上限。
- 同时支持流式执行与中断恢复，前端可查看中间步骤（assistant/tool）。

#### 🧮 上下文管理
- `agent/core/context_manager.py`：负责 token 预算控制与历史压缩。
- 当历史接近阈值时自动压缩旧对话，保留近期关键轮次，避免上下文膨胀并保持任务连续性。

#### 🧩 Skills 和 MCP 配置
- MCP：`agent/core/tool_loader.py` + `agent/tools/mcp_manager.py` 自动扫描 `mcp-servers/`；按 `registry.json` 区分 `core/searchable`；searchable 通过 BM25 + `tool_search` 按需注入。
- Skills：自动解析 `skills/**/SKILL.md` 生成 `skill__*` 工具接口；`runtime/skills/` 优先于内置目录，实现零配置覆盖加载。

#### 📁 内置文件操作和 Bash 执行工具
- 内置工具：`read / write / append / edit / glob / grep / fetch / bash`，统一注册到工具执行器。
- 文件类工具通过 `resolve_path_for_tool` 做沙箱校验；Bash 类工具通过权限系统判定风险并结合审批流执行。

### 用户交互逻辑（含界面） 🧭
#### 1) ⚙️ 配置 API 与 Guide 指引
- 首次进入会检测是否已配置模型（`/api/settings/status`）：未配置 -> 进入初始化配置页。
- 聊天页内也可打开 Config 面板更新 `Base URL / API Key / Model`。
- Guide 面板通过 `/api/meta/guide` 返回当前可用 MCP、Skills、工具与工作区说明，作为操作指引。

![配置与Guide面板](./Screenshot%202026-02-19%20004314.png)

#### 2) 🗂️ 会话操作 + 项目共享文件空间
- 会话支持新建 / 置顶 / 重命名 / 删除；后端对应 `sessions` 路由；删除支持归档删除与硬删除。
- 项目机制下，同一项目内会话共享项目工作区：`projects/{project_id}/files/input|output|temp`，便于多会话协作同一批文件。

![会话与项目管理-1](./Screenshot%202026-02-19%20004103.png)
![会话与项目管理-2](./Screenshot%202026-02-19%20004221.png)

#### 3) 📦 文件空间：上传/下载 + AI Temp
- 文件面板提供 `Input / Output / Temp` 三个作用域。
- 支持：单文件上传、保持目录结构上传、单文件下载、目录 zip 下载、`Output/Temp` 一键打包下载。
- `Temp`（可视作 AI Temp）：用于模型执行的中间产物与临时文件，便于排查与复用。

![文件空间与AI Temp](./Screenshot%202026-02-19%20004358.png)

### 后端前端技术 🧱
- **后端**：FastAPI、Uvicorn、OpenAI 兼容客户端、fastmcp、SQLite。
- **前端**：Electron、React、Vite、TypeScript、Zustand、Axios、Tailwind CSS。
- **关键接口**：`/api/chat`、`/api/chat/stream`、`/api/sessions`、`/api/projects`、`/api/files`、`/api/settings`、`/api/permissions`、`/api/meta`。

### 安全机制 🔒

#### 派蒙桌面助手 - 安全机制说明

##### 一、安全设计理念
派蒙桌面助手采用“多层防护、最小权限、默认拒绝”的安全设计原则，确保 AI 助手在执行任务时不会对系统和数据造成意外损害。所有安全机制均在后台自动运行。

##### 二、三层安全防护体系

###### 第一层：沙箱隔离
- 内置工具在加载时由 `agent/core/tool_loader.py` 注入沙箱边界：`sandbox_root`、`sandbox_read_roots`、`sandbox_write_roots`（默认指向运行时根目录）。
- `read/write/edit/append` 工具统一通过 `agent/core/sandbox.py` 的 `resolve_path_for_tool` 做路径解析与越界校验。
- 相对路径会基于 `sandbox_root` 解析，越界访问直接拒绝。
- 路径必须满足文件/目录类型与存在性约束（按工具动作区分 `must_exist`、`allow_directory`）。

实际效果：即使 AI 试图写入系统关键目录（如 `C:\Windows\System32` 或 `/etc`），也会被拒绝。

###### 第二层：权限审批
敏感操作会触发审批，不会擅自执行。

实现逻辑（`agent/core/permission_manager.py`）：
- 每次工具调用先进入 `check_permission()`。
- 删除操作统一判定为 `ask`（必须确认），不会因为自动模式直接放开。
- 写入/删除操作会执行工作区边界检查：目标路径超出工作区直接 `deny`。
- 命令中的动态路径表达式（如 `` `...` ``、`$VAR`、`%VAR%`、`$(...)`）用于写删场景会被拒绝。
- UNC 路径（`\\\\server\\share`）用于写删场景会被拒绝。
- 规则文件 `agent/core/permissions.json` 中 `deny/allow/ask` 会参与最终决策。

可选审批动作：
- 允许一次
- 允许本会话（删除类通常不做会话级永久放行）
- 拒绝
- 重试并附加说明
- 切换自动模式

###### 第三层：危险命令拦截
高破坏命令会被硬拦截，例如：
- `format`、`mkfs`、`fdisk`、`parted`、`diskpart clean`
- `dd` 直接写盘
- 批量危险删除（如 `rm -rf /`、`rm -rf *`）
- 启动配置与高危权限滥用命令

实现位置：
- 关键命令规则在 `agent/core/permission_manager.py` 的 `_CRITICAL_COMMAND_PATTERNS`。
- 命令删除/写入行为识别分别由 `_DELETE_COMMAND_PATTERNS` 与 `_WRITE_COMMAND_PATTERNS` 实现。

##### 三、权限模式说明
- 询问模式（默认）：安全性最高，敏感操作需确认。
- 自动模式：执行更流畅，但仍受沙箱与危险命令拦截保护。

##### 四、安全边界说明
以下边界始终有效：
- 危险命令拦截不可绕过
- 写入/删除不能越过工作区
- 删除操作需明确确认
- 敏感路径受策略保护

敏感路径默认策略（`agent/core/permissions.json`）包含：
- `read:.env`、`read:.env.*`
- `read:**/.ssh/**`
- `read:**/secrets/**`
- 以及系统目录写入拒绝规则（如 `/etc`、`/usr` 等）

策略文件：`agent/core/permissions.json`

##### 五、会话级授权管理
- 一次性授权
- 会话级授权
- 签名级拒绝

实现细节：
- `pending_allow_once`：仅放行一次请求签名。
- `session_allowed_tools`：会话内按工具放行。
- `session_denied`：会话内拒绝签名集合。
- 删除操作即使点“允许本会话”，后端也会降级为“仅当前请求允许一次”。

会话结束后，临时授权可清理，降低长期风险累积。

##### 六、透明度与可追溯性
- 每次权限决策都有原因记录。
- 可查看允许/拒绝原因。
- 规则可审计、可配置。

链路实现：
- 工具层触发审批时抛出 `PermissionRequestError`（`agent/core/tool_loader.py`）。
- 聊天接口收到审批事件后返回 HTTP `409`，错误码 `permission_required`（`agent/server/routes/chat.py`）。
- 前端弹窗调用 `/api/permissions/confirm` 提交审批动作（`frontend/src/renderer/api/permissions.ts`）。
- 审批后通过 `resume` 机制继续执行原任务。

##### 七、安全使用建议
- 默认使用询问模式。
- 审批前检查工具名、参数、目标路径。
- 定期检查工作区输出。

##### 八、常见问题（FAQ）
- Q: 自动模式下会直接删文件吗？
  - A: 不会，删除操作始终需要确认。
- Q: AI 能写工作区外文件吗？
  - A: 不能，写入/删除受工作区边界保护。
- Q: 配置修改后是否立即生效？
  - A: 通常重启应用后完整生效。

### 如何部署

#### 1. 安装 Python 依赖
```bash
pip install -r requirements.txt
```

#### 2. 安装前端依赖
```bash
cd frontend
npm install
```

#### 3. 安装 MCP 依赖
```bash
npm install --prefix ../mcp-servers/open-websearch
npm install --prefix ../mcp-servers/playwright
npm install --prefix ../mcp-servers/rednote
```

#### 4. 开发模式启动
```bash
npm run electron:dev
```

#### 5. 打包发布
```bash
npm run prepare:runtimes
npm run verify:runtimes
npm run electron:build
```

---

## English

Paimon (named after the guide character in *Genshin Impact*) is a local-first desktop AI assistant. Think of it as an “executable upgrade” over typical chat apps: it can not only chat, but also do work inside a structured workspace.  
Upgrades (short): 🧰 tool use (file CRUD + run generated code) / 🔁 ReAct multi-step loop (decide -> act -> observe -> decide) / 📁 session & project workspaces / 🧩 extensible Skills (create/import folders/configure from GitHub links).  
Use it for: daily chat; fast research and deep reports (recommended with the built-in RedNote/Xiaohongshu browsing tool); office docs (Excel/PPT/Word; PDF workflows are currently English-leaning); and turning your routines into reusable conversation-driven workflows (Skills).

![Paimon Desktop Main UI](./Screenshot%202026-02-19%20003425.png)

### Core Features 🧩
- 🖥️ **Desktop + local backend**: Electron + React + FastAPI; launching the app automatically boots a local backend service.
- 🧷 **Sessions / projects**: create, switch, pin, rename, archive, delete.
- 📁 **Workspace files**: scoped `input / output / temp` browsing + upload/download + zip export.
- 🧰 **One tool surface**: MCP + Skills + built-ins (`bash / read / write / append / edit / glob / grep / fetch`).
- 🧩 **Zero-config skills**: drop skills into `skills/` (runtime-preferred `runtime/skills/`) -> auto-discovered, no core code changes.
- 🌊 **Streaming + control**: streaming chat, interruption, approval, then `resume`.

### AI Capabilities 🧠
- 🔁 **ReAct loop**: reason -> act (tool call) -> observe -> iterate until final output.
- 🧰 **Multi-turn tool orchestration**: structured tool-result injection across the dialogue loop.
- 🧮 **Context management**: token budgeting + history compression.
- 🔎 **Dynamic MCP loading**: BM25 + `tool_search` for on-demand tool injection.
- 🧩 **Dynamic skills**: parse `SKILL.md` and expose callable `skill__*` interfaces.
- 💾 **Persistence**: sessions/messages/projects/settings stored in SQLite (WAL).

### Key Agent Technical Implementations 🛠️
#### 🔁 ReAct framework
- `agent/core/main.py`: runs a loop of reason -> tool call -> tool result injection -> continue reasoning, until final output or max turns.
- Supports streaming output and interruption/resume so users can inspect intermediate assistant/tool steps.

#### 🧮 Context management
- `agent/core/context_manager.py`: token budgeting + history compression.
- When history reaches threshold, older turns are compressed while recent turns are preserved for continuity.

#### 🧩 Skills and MCP configuration
- MCP: `agent/core/tool_loader.py` + `agent/tools/mcp_manager.py` scan `mcp-servers/`, classify servers via `registry.json`, and lazily inject searchable tools via BM25 + `tool_search`.
- Skills: parse `skills/**/SKILL.md` into callable `skill__*` tool interfaces; `runtime/skills/` has higher priority for zero-config override loading.

#### 📁 Built-in file ops and Bash execution
- Built-ins: `read / write / append / edit / glob / grep / fetch / bash`, registered through a unified executor.
- File tools are sandbox-validated by `resolve_path_for_tool`; Bash commands are gated by permission checks + approval flow.

### User Interaction Logic (with UI) 🧭
#### 1) ⚙️ API configuration and Guide panel
- On startup, UI checks model configuration via `/api/settings/status`; if not configured -> first setup flow.
- In chat: open Config panel to update `Base URL / API Key / Model`.
- Guide panel (`/api/meta/guide`) lists available MCP/skills/tools/workspace rules.

![API Config and Guide](./Screenshot%202026-02-19%20004314.png)

#### 2) 🗂️ Session operations + project-shared workspace
- Sessions support create/pin/rename/delete (archive vs hard delete via backend session routes).
- Under project mode, sessions share the same project workspace: `projects/{project_id}/files/input|output|temp`.

![Session and Project Management - 1](./Screenshot%202026-02-19%20004103.png)
![Session and Project Management - 2](./Screenshot%202026-02-19%20004221.png)

#### 3) 📦 File workspace: upload/download + AI Temp
- File panel provides `Input / Output / Temp`.
- Supports: single-file upload, folder-structure-preserving upload, single-file download, directory zip download, quick output/temp zip export.
- Temp (AI Temp) is for intermediate artifacts generated during agent execution.

![File Workspace and AI Temp](./Screenshot%202026-02-19%20004358.png)

### Backend & Frontend Technology
- Backend: FastAPI, Uvicorn, OpenAI-compatible client, fastmcp, SQLite.
- Frontend/Desktop: Electron, React, Vite, TypeScript, Zustand, Axios, Tailwind CSS.
- Key APIs: `/api/chat`, `/api/chat/stream`, `/api/sessions`, `/api/projects`, `/api/files`, `/api/settings`, `/api/permissions`, `/api/meta`.

### Security Mechanism
#### Security Design
- The app uses a layered model: sandbox confinement + permission decision engine + destructive-command blocking.
- Safety behavior is enforced in runtime code, not only in UI prompts.

#### Layer 1: Sandbox Confinement
- Built-in tools are assigned sandbox roots in `agent/core/tool_loader.py`.
- File tools (`read/write/edit/append`) resolve paths through `resolve_path_for_tool` in `agent/core/sandbox.py`.
- Out-of-scope paths are rejected after normalization and realpath resolution.
- Relative traversal and invalid file/dir mode combinations are blocked by validation rules.

#### Layer 2: Permission Engine
- All tool calls go through `check_permission()` in `agent/core/permission_manager.py`.
- Delete operations are always confirmation-gated (`ask`), including in `auto` mode.
- Write/delete outside workspace is denied.
- For command-like operations, unsafe path forms are denied for write/delete scenarios:
- UNC paths (for example `\\\\server\\share\\...`)
- Dynamic path expressions (for example `` `...` ``, `$VAR`, `%VAR%`, `$(...)`)

#### Layer 3: Critical Command Blocking
- High-risk destructive patterns are hard-blocked before execution.
- Detection is implemented with pattern sets such as:
- `_CRITICAL_COMMAND_PATTERNS`
- `_DELETE_COMMAND_PATTERNS`
- `_WRITE_COMMAND_PATTERNS`

#### Security Configuration File
- Main config: `agent/core/permissions.json`
- Key sections:
- `mode`: default runtime mode (`ask` or `auto`)
- `permissions.deny`: hard deny rules (for example sensitive paths)
- `permissions.allow`: always-allow rules
- `permissions.ask`: approval-required rules
- `risk_levels` and `bash_risk_keywords`: risk annotation and command risk hints

Example rule categories used by default:
- Sensitive reads: `.env`, `.env.*`, `.ssh`, `**/secrets/**`
- System write deny targets: `/etc/**`, `/usr/**`, `/bin/**`
- Approval-required operations: file edits/writes, install commands, delete/move/copy commands

#### Approval Flow (UI + API)
- Tool layer raises `PermissionRequestError`.
- Chat API returns HTTP `409` with `permission_required`.
- Frontend opens approval modal and posts decision to `/api/permissions/confirm`.
- Agent resumes execution after approval (`allow_once` / `allow_session` / `retry_with_context`) or stops on deny.

#### Session-Scoped Authorization Behavior
- `pending_allow_once`: one-time signature approval.
- `session_allowed_tools`: allow by tool for current session.
- `session_denied`: signature-level deny list for current session.
- Delete requests cannot be permanently unlocked for a whole session; backend downgrades to per-request approval.

### Deployment

#### 1. Install Python dependencies
```bash
pip install -r requirements.txt
```

#### 2. Install frontend dependencies
```bash
cd frontend
npm install
```

#### 3. Install MCP dependencies
```bash
npm install --prefix ../mcp-servers/open-websearch
npm install --prefix ../mcp-servers/playwright
npm install --prefix ../mcp-servers/rednote
```

#### 4. Run in development
```bash
npm run electron:dev
```

#### 5. Build distributable app
```bash
npm run prepare:runtimes
npm run verify:runtimes
npm run electron:build
```

---

## License
MIT. See `LICENSE`.
