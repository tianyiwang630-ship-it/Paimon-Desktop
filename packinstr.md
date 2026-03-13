# Paimon Desktop 打包与发版说明

## 1. 这份文档是干什么的

这份文档只解决一件事：

- 以后怎么从 Windows 本地发起一次 macOS 安装包发布
- GitHub Actions 会自动做哪些检查
- 出问题时先看哪里
- Playwright MCP 目录如果被清空，应该怎么恢复

当前约束不变：

- 开发和改代码在 Windows 本地完成
- macOS 安装包通过 GitHub Actions 构建
- 不依赖用户本机是否安装 Python 或 Node.js
- 打包链路优先保证鲁棒性，而不是依赖用户环境兜底

## 2. 当前发布入口

当前 macOS 打包 workflow 是：

- `.github/workflows/build-macos.yml`

它有两种触发方式：

1. 手动触发
- 去 GitHub 仓库的 `Actions`
- 选择 `Build macOS Installer`
- 点击 `Run workflow`

2. 推送版本 tag
- 本地创建形如 `v1.0.4` 的 tag
- 执行 `git push origin v1.0.4`
- workflow 会自动开始

注意：

- 只执行 `git push` 不会自动触发 mac 打包
- 必须是 `workflow_dispatch` 或 `push tag`

## 3. 版本号看哪里

版本号以这里为准：

- `frontend/package.json`

例如：

```json
"version": "1.0.4"
```

如果你这次要发 `1.0.5`，先改这里，再提交代码。

## 4. 推荐发布步骤

### 第一步：修改版本号

修改：

- `frontend/package.json`

把 `version` 改成你要发的版本，例如 `1.0.5`。

### 第二步：提交代码

```powershell
git add .
git commit -m "release: v1.0.5"
```

### 第三步：推送代码

```powershell
git push
```

这一步只是把代码推上去，还不会触发 mac 打包。

### 第四步：创建并推送 tag

```powershell
git tag v1.0.5
git push origin v1.0.5
```

这一步之后，GitHub Actions 会自动开始打包。

## 5. 为什么 tag 必须和版本号一致

workflow 会读取：

- `frontend/package.json` 里的 `version`

然后计算期望 tag：

- `v<version>`

例如：

- `version = 1.0.5`
- 期望 tag 就必须是 `v1.0.5`

如果版本号和 tag 不一致，workflow 会直接失败。

## 6. GitHub Actions 会自动跑什么

### 6.1 `prepare-release`

作用：

- 读取 `frontend/package.json`
- 解析版本号
- 检查 tag 和版本号是否一致

这里失败，后面的 mac 打包不会继续。

### 6.2 `build-macos`

作用：

- 安装前端依赖
- 安装 `mcp-servers` 里的 Node 依赖
- 准备 bundled Python / Node / Playwright 浏览器资源 / tools
- 校验运行时
- 构建 Electron app
- 按 `x64` 和 `arm64` 两个架构分别打包

这里会检查：

- packaged Python 能不能启动
- packaged Node 能不能启动
- packaged Playwright Chromium 能不能启动
- packaged backend 能不能启动

### 6.3 `smoke-test-macos`

作用：

- 下载上一步生成的 dmg
- 挂载 dmg
- 把 `Paimon.app` 复制出来
- 对复制出来的 app 再跑一次 packaged runtime 校验

这一步是在模拟用户真正拿到 dmg 之后的安装结果。

### 6.4 `release-macos`

只有前面都成功，才会执行。

作用：

- 上传最终产物
- 包括 `.dmg`
- 包括 `.sha256`
- 包括 build summary
- 包括 smoke summary

## 7. 以后最常用的一套命令

假设这次要发 `1.0.5`：

```powershell
git add .
git commit -m "release: v1.0.5"
git push
git tag v1.0.5
git push origin v1.0.5
```

前提是：

- `frontend/package.json` 已经改成 `1.0.5`

## 8. 怎样判断这次打包是否成功

需要看 GitHub Actions 里这四步是否都成功：

1. `prepare-release`
2. `build-macos`
3. `smoke-test-macos`
4. `release-macos`

只有这四步都成功，才算这次 mac 发布完成。

## 9. 常见错误

### 错误 1：只 push 了代码，没有触发 workflow

原因：

- 你只执行了 `git push`
- 没有推 tag
- 也没有手动点 `Run workflow`

处理：

- 推送正确的 tag
- 或者手动触发 workflow

### 错误 2：tag 和版本号不一致

例如：

- `frontend/package.json` 是 `1.0.5`
- 你推的是 `v1.0.4`

处理：

- 改正版本号
- 或重新创建正确 tag

### 错误 3：tag 已经存在

处理原则：

- 不要重复使用同一个版本号
- 需要重新发版时，改成新版本，例如 `1.0.6`

### 错误 4：`build-macos` 过了，但 `smoke-test-macos` 失败

这表示：

- 原始构建目录里的 app 基本可用
- 但从 dmg 复制出来以后，内容或运行时边界有问题

优先看：

- dmg 内 app 是否完整
- runtime 是否真的只依赖 app 内资源

## 10. Playwright MCP 现在的配置方式

Playwright MCP 现在是“两层配置”：

- `mcp-servers/playwright/mcp.config.json`
  - 这是项目自己的 MCP 启动壳
  - 只负责启动 `node_modules/@playwright/mcp/cli.js`
  - 再通过 `--config playwright.mcp.config.json` 把真实配置交给官方 Playwright MCP
- `mcp-servers/playwright/playwright.mcp.config.json`
  - 这是 Playwright MCP 自己的运行配置
  - 浏览器类型、是否持久化、快照模式等都写这里

当前默认策略是：

- 浏览器用 Playwright 自带 `chromium`
- 默认保持持久会话
- 不对某一个网站做特殊配置

## 11. 如果 `mcp-servers/playwright` 被清空了，怎么恢复

至少要恢复这些文件：

- `mcp-servers/playwright/package.json`
- `mcp-servers/playwright/package-lock.json`
- `mcp-servers/playwright/mcp.config.json`
- `mcp-servers/playwright/playwright.mcp.config.json`

然后在仓库根目录执行：

```powershell
npm install --prefix mcp-servers/playwright --save-exact @playwright/mcp@latest --no-audit --no-fund
```

这一步会：

- 把官方 Playwright MCP 装到 `mcp-servers/playwright/node_modules`
- 生成准确的 `package-lock.json`
- 恢复 `node_modules/@playwright/mcp/cli.js`
- 恢复 `node_modules/playwright/cli.js`

如果不做这一步，本地的 runtime 准备脚本会因为找不到 Playwright CLI 而直接失败。

## 12. GitHub Actions 和本地脚本对 Playwright 的要求

GitHub Actions 会自动在 `mcp-servers/playwright` 下安装依赖，所以：

- `node_modules` 不需要提交进 git
- 但 `package.json` 和 `package-lock.json` 必须存在

Windows 本地如果要跑打包前的 runtime 准备，也要先保证：

- `mcp-servers/playwright/package.json` 存在
- `mcp-servers/playwright/package-lock.json` 存在
- 本地已经跑过上面的 `npm install --prefix mcp-servers/playwright ...`

## 13. 关于“官方最新”的真实情况

这次按官方方式重建后，当前实际解析到的是：

- `@playwright/mcp = 0.0.68`
- `playwright = 1.59.0-alpha-1771104257000`
- `playwright-core = 1.59.0-alpha-1771104257000`

这说明一件事：

- 现在的“官方最新”不等于“稳定版”
- 当前官方包本身就依赖 alpha 浏览器链

所以以后如果要“刷新到官方最新”，要先接受这个现实：

- 刷新到的是官方最新，不是自动切到稳定浏览器线
- 发版前一定要看 `mcp-servers/playwright/package-lock.json` 里实际锁定到了什么版本

## 14. 这份文档的适用范围

这份文档当前主要针对：

- GitHub Actions 上的 macOS dmg 发布流程
- Windows 本地作为开发和发版发起端
- Playwright MCP 目录恢复与依赖准备

如果以后 Windows 发布链路也要长期维护，建议单独再写一份 Windows 发布说明，不要和 mac 说明混在一起。
