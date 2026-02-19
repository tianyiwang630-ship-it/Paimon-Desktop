# MCP Servers 目录

此目录存放所有 MCP (Model Context Protocol) server，Agent 启动时会自动扫描并加载。

## 当前已安装的 MCP Servers

| 目录 | 说明 | 启动方式 | 需要登录 |
|------|------|----------|----------|
| `open-websearch/` | 多引擎网页搜索（DuckDuckGo 等） | npx 远程包 | 否 |
| `playwright/` | 浏览器自动化，支持 JS 渲染页面 | npx 远程包 | 否 |
| `rednote/` | 小红书内容浏览（搜索/笔记/评论） | 本地 node 项目 | 是（Cookie） |
| `ytb/` | YouTube 视频字幕摘要 | npx 远程包 | 否 |

---

## 一、如何添加新的 MCP Server

### 方式 A：npx 远程包（最简单）

适用于已发布到 npm 的 MCP server，无需下载源码。

1. 创建目录：

```bash
mkdir mcp-servers/my-server
```

2. 在目录下创建 `mcp.config.json`：

```json
{
  "enabled": true,
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "包名@latest"],
  "env": {},
  "description": "简要说明"
}
```

完成，Agent 启动后自动可用。

3. **可选**：在 `registry.json` 中声明分类和别名（见下文 **分类管理** 章节）

### 方式 B：克隆 GitHub 项目（本地构建）

适用于需要定制或未发布到 npm 的项目。

```bash
# 1. 克隆到 mcp-servers 目录
cd mcp-servers
git clone https://github.com/xxx/your-mcp-server my-server

# 2. 安装依赖并构建
cd my-server
npm install
npm run build

# 3. 如果项目依赖 Playwright，还需安装浏览器
npx playwright install chromium
```

然后创建 `mcp.config.json`：

```json
{
  "enabled": true,
  "type": "stdio",
  "command": "node",
  "args": ["dist/index.js", "--stdio"],
  "env": {},
  "description": "简要说明"
}
```

> **注意**：`args` 中是否需要 `--stdio` 取决于具体项目，查看项目文档确认。

### 方式 C：Python MCP Server

```json
{
  "enabled": true,
  "type": "stdio",
  "command": "uvx",
  "args": ["包名"],
  "env": {},
  "description": "简要说明"
}
```

### 自动识别规则

如果不创建 `mcp.config.json`，Scanner 也会尝试自动识别：

- 检测到 `package.json` 且含 `mcp` 关键字 → 按 Node.js 项目处理
- 检测到 `pyproject.toml` 且含 `mcp` 关键字 → 按 Python 项目处理
- 检测到可执行文件 → 直接运行

但建议始终手动创建 `mcp.config.json`，配置更可控。

### 配置字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `enabled` | 否 | 是否启用，默认 `true`。设为 `false` 可临时禁用 |
| `type` | 是 | 传输类型：`stdio`（标准输入输出）或 `http` |
| `command` | 是 | 启动命令，如 `node`、`npx`、`uvx`、`python` |
| `args` | 否 | 命令参数数组 |
| `env` | 否 | 环境变量，支持 `${VAR_NAME}` 引用系统变量 |
| `description` | 否 | 简要说明 |

### 验证是否生效

```python
from agent.discovery.mcp_scanner import MCPScanner

scanner = MCPScanner()
servers = scanner.scan()       # 应显示新 server
scanner.save_config(servers)   # 生成 auto-config.json
```

---

## 二、MCP Server 维护说明

### open-websearch

- **维护难度**：无需维护
- 通过 `npx -y open-websearch@latest` 启动，自动使用最新版本
- 默认搜索引擎为 DuckDuckGo，可在 `mcp.config.json` 的 `env.DEFAULT_SEARCH_ENGINE` 中修改

### playwright

- **维护难度**：低
- 通过 `npx @playwright/mcp@latest` 启动，自动使用最新版本
- 如果浏览器版本过旧导致页面渲染异常，运行：
  ```bash
  npx playwright install chromium
  ```

### rednote（小红书）

- **维护难度**：中 — 需要定期维护 Cookie 登录状态
- **来源**：https://github.com/iFurySt/RedNote-MCP

#### Cookie 过期处理

小红书的 Cookie 会定期过期（通常几天到几周），过期后工具调用会报 `Not logged in` 错误。

**重新登录步骤：**

```bash
cd mcp-servers/rednote
node dist/cli.js init
```

这会打开浏览器窗口，用手机扫码登录小红书，登录成功后 Cookie 自动保存到：

```
~/.mcp/rednote/cookies.json
Windows 路径: C:\Users\<用户名>\.mcp\rednote\cookies.json
```

如果需要更长的扫码等待时间（默认 10 秒），可以指定超时：

```bash
node dist/cli.js init 60    # 等待 60 秒
```

#### 更新版本

```bash
cd mcp-servers/rednote
git pull
npm install
npm run build
```

#### 提供的工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `search_notes` | 按关键词搜索笔记 | `keywords`（必填）、`limit`（可选，默认 10） |
| `get_note_content` | 获取单篇笔记完整内容 | `url`（笔记链接或分享文本） |
| `get_note_comments` | 获取笔记评论列表 | `url`（笔记链接） |
| `login` | 在 Agent 会话中触发重新登录 | 无 |

#### 查看日志

```bash
cd mcp-servers/rednote
node dist/cli.js open-logs
```

### ytb（YouTube）

- **维护难度**：无需维护
- 通过 `npx -y youtube-video-summarizer-mcp` 启动，自动使用最新版本
- 仅支持有字幕的视频

---

## 三、MCP 分类管理（Tool Search）

从 2026 年开始，Agent 支持 **Tool Search** 机制：将 MCP 分为两类，避免工具定义占用过多 token。

### 分类方式

编辑 `mcp-servers/registry.json`：

```json
{
  "_comment": "MCP 分类管理。category: core(常驻上下文) / searchable(按需搜索)。alias: 中文别名（可选）。",
  "playwright":      { "category": "core" },
  "open-websearch":  { "category": "core" },
  "rednote":         { "category": "searchable", "alias": "小红书" },
  "ytb":             { "category": "searchable", "alias": "YouTube" }
}
```

### 分类说明

| 分类 | 说明 | 何时使用 | Token 占用 |
|------|------|---------|----------|
| `core` | 常驻工具，每次对话都会加载到 Agent 上下文 | 频繁使用的基础能力（网页、搜索） | 每轮 ~4000 tokens |
| `searchable` | 垂直工具，仅当用户查询相关时自动加载 | 专用工具（社交媒体、视频、等） | 仅用时 ~200 tokens |

**自动分类**：不在 `registry.json` 中的 server 默认为 `searchable`

### 工作原理

1. **首次启动**：Agent 扫描所有 MCP server 并按分类加载
   - core 工具定义直接注入上下文
   - searchable 工具定义隐藏，替换为 `tool_search` 工具

2. **用户查询**：提及相关 server 或工具名称时
   ```
   用户: "帮我搜一下小红书上的化妆品推荐"
   → Agent 识别到 "小红书"，调用 tool_search
   → tool_search 自动加载 rednote 工具
   → Agent 调用 rednote 工具完成搜索
   ```

3. **查询支持**：
   - server 中文别名（如 "小红书" → rednote）
   - server 英文名（如 "rednote"）
   - 工具名称（如 "search_notes"）

### 添加新 MCP 时的步骤

以添加 "my-server" 为例：

1. **创建配置**：
   ```bash
   mkdir mcp-servers/my-server
   # 创建 mcp.config.json（见上文方式 A/B/C）
   ```

2. **注册分类**：
   ```json
   // mcp-servers/registry.json
   {
     "my-server": { "category": "searchable", "alias": "我的工具" }
   }
   ```

3. **完成**：Agent 重启后自动可用，无需改动其他文件

> **提示**：如果只做了第 1 步，第 2 步会自动按 `searchable` 处理，也能正常工作。

---

## 四、常见问题

### 我应该选择 core 还是 searchable？

- **core**：频率高、基础能力
  - playwright（网页操作）
  - open-websearch（通用搜索）

- **searchable**：垂直领域、偶尔使用
  - rednote（仅需搜小红书时）
  - ytb（仅需处理 YouTube 时）
  - 其他专用工具

不确定时，默认设为 `searchable` 是安全的，不占用 token。

### Server 未被 Scanner 识别？

确认以下几点：
1. 目录下存在 `mcp.config.json`
2. `enabled` 不是 `false`
3. `command` 字段存在

### 如何临时禁用某个 Server？

修改其 `mcp.config.json`：

```json
{
  "enabled": false
}
```

### 如何传递环境变量？

在 `mcp.config.json` 中使用 `${VAR_NAME}` 引用系统变量：

```json
{
  "env": {
    "API_KEY": "${MY_API_KEY}"
  }
}
```

---

## 更多资源

- [Model Context Protocol 官方文档](https://modelcontextprotocol.io/)
- [MCP Servers 列表](https://github.com/modelcontextprotocol/servers)
- [Awesome MCP Servers（社区）](https://github.com/punkpeye/awesome-mcp-servers)
