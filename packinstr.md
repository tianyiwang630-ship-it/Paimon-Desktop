# Paimon Desktop 打包与发版说明

## 1. 这份文档是干什么的

这份文档只说明一件事：

- 以后开发时，怎样更新版本
- 怎样触发 GitHub 上的 mac 安装包打包
- 怎样判断打包是否成功
- 出错时先看哪里

当前 mac 打包的原则是：

- 在 Windows 本地改代码、改版本、提交代码
- 在 GitHub Actions 上打包 mac 安装包
- 不依赖用户本机是否安装 Python 或 Node.js
- 安装包发布前，GitHub 会自动做构建检查和安装烟测

## 2. 当前 mac 打包流程总览

当前仓库里的 mac 打包 workflow 是：

- `.github/workflows/build-macos.yml`

它支持两种触发方式：

1. 手动触发
- 在 GitHub 的 `Actions` 页面里手动点击运行 `Build macOS Installer`

2. 推送版本 tag 触发
- 本地推送形如 `v1.0.3` 这样的 tag
- 只要 tag 格式是 `v*`，workflow 就会自动运行

注意：

- 只 `git push` 代码，不会自动触发这个 workflow
- 只会在 `workflow_dispatch` 或 `push tag` 时触发

## 3. 版本号改哪里

版本号以这里为准：

- `frontend/package.json`

例如：

```json
"version": "1.0.3"
```

如果你这次准备发布 `1.0.4`，就要先把这里改成：

```json
"version": "1.0.4"
```

然后再提交代码。

## 4. 推荐发版方式

推荐以后都按下面这套顺序做。

### 第一步：修改版本号

修改：

- `frontend/package.json`

把 `version` 改成你要发的版本，例如 `1.0.4`。

### 第二步：提交代码

示例：

```powershell
git add frontend/package.json
git add .
git commit -m "release: v1.0.4"
```

如果这次发版还包含别的功能改动，也一并提交。

### 第三步：推送代码

```powershell
git push
```

这一步只是把代码推上去，不会自动开始 mac 打包。

### 第四步：创建并推送版本 tag

如果版本号是 `1.0.4`，对应的 tag 必须是：

```powershell
git tag v1.0.4
git push origin v1.0.4
```

这一步之后，GitHub Actions 会自动开始 mac 打包 workflow。

## 5. 为什么 tag 必须和版本号一致

workflow 会先读取：

- `frontend/package.json` 里的 `version`

然后自动计算出期望 tag：

- `v<version>`

例如：

- `version = 1.0.4`
- 那么期望 tag 就必须是 `v1.0.4`

如果你推的是：

- `frontend/package.json` 里是 `1.0.4`
- 但你推送了 `v1.0.3`

那么 workflow 会直接失败。

## 6. GitHub Actions 会自动跑哪些阶段

当你成功推送 tag 之后，workflow 会按顺序自动运行下面几个 job。

### 6.1 prepare-release

作用：

- 识别应用目录
- 读取 `frontend/package.json` 里的版本号
- 检查 tag 和版本号是否一致

如果这里失败，后面的 mac 打包不会继续。

### 6.2 build-macos

作用：

- 在 GitHub 的 mac runner 上安装依赖
- 准备 mac 专用 bundled runtimes
- 校验 runtime
- 构建 Electron app
- 分别打包两个架构：
  - `x64`
  - `arm64`
- 对最终 `.app` 做强校验

这里的强校验包括：

- packaged Python 可执行
- packaged Node 可执行
- packaged Playwright Chromium 可启动
- packaged backend 健康检查通过

### 6.3 smoke-test-macos

作用：

- 下载上一步生成的 dmg
- 挂载 dmg
- 把 `Paimon.app` 从 dmg 里复制出来
- 再对这个复制出来的 app 重跑 packaged 校验

这一步是在模拟用户真正拿到 dmg 后的安装结果。

也就是说：

- `build-macos` 验证“构建出来的 app 能不能用”
- `smoke-test-macos` 验证“用户从 dmg 里拿出来的 app 能不能用”

### 6.4 release-macos

只有前面都成功，才会执行这一步。

作用：

- 上传并发布最终产物
- 包括：
  - `.dmg`
  - `.sha256` 校验文件
  - build summary
  - smoke summary

## 7. 以后最常用的实际操作命令

假设这次要发 `1.0.4`，最常用流程就是：

```powershell
git add .
git commit -m "release: v1.0.4"
git push
git tag v1.0.4
git push origin v1.0.4
```

前提是你已经先把：

- `frontend/package.json` 里的 `version`

改成了：

- `1.0.4`

## 8. 手动触发方式

如果你不想本地推 tag，也可以手动触发。

方法：

1. 先把代码和版本号推到 GitHub
2. 打开 GitHub 仓库的 `Actions`
3. 选择 `Build macOS Installer`
4. 点击 `Run workflow`

当前 workflow 在手动触发时会：

- 读取当前提交对应的 `frontend/package.json` 版本号
- 自动检查远端是否已经有对应 tag
- 如果没有，就创建对应 tag

但是平时建议仍然优先使用“本地推 tag”这套方式，因为更直观，也更容易回溯。

## 9. 怎样判断打包是否成功

看 GitHub Actions 页面时，可以按下面理解：

1. `prepare-release` 成功
- 说明版本号和 tag 基本没有问题

2. `build-macos` 成功
- 说明两个架构的 app 都打出来了
- 并且最终 `.app` 的 Python / Node / Playwright / backend 校验通过

3. `smoke-test-macos` 成功
- 说明从 dmg 中复制出来的 app 也通过了再次校验

4. `release-macos` 成功
- 说明 release 资产已经上传完成

只有这四步都成功，才算这次 mac 发版完成。

## 10. 常见错误和对应处理

### 错误 1：只 push 了代码，没有触发 workflow

原因：

- 你只是 `git push`
- 没有推 tag
- 也没有手动点 `Run workflow`

处理：

- 推送正确的版本 tag
- 或者手动触发 workflow

### 错误 2：tag 和 `package.json` 版本号不一致

例如：

- `frontend/package.json` 是 `1.0.4`
- 你推送的是 `v1.0.3`

处理：

- 改正版本号或重新创建正确 tag

### 错误 3：tag 已经存在

例如你之前已经推过：

```powershell
git push origin v1.0.4
```

这时再次发同一个 tag，会冲突。

处理原则：

- 不要重复使用同一个版本号
- 需要重新发版时，改成新版本，例如 `1.0.5`

### 错误 4：只看到第一个 job，以为后面不会继续

这是正常现象。

workflow 会按依赖顺序自动继续：

- `prepare-release`
- `build-macos`
- `smoke-test-macos`
- `release-macos`

前一个 job 成功后，后一个 job 会自动开始。

### 错误 5：build 过了，但 smoke test 失败

这表示：

- 构建目录里的 `.app` 能用
- 但从 dmg 拿出来再次校验时失败了

这类错误要重点看：

- dmg 挂载后的 app 内容是否完整
- packaged runtime 是否真的只依赖 app 内资源

## 11. 发版前最少检查项

每次发版前，至少确认下面几点：

1. `frontend/package.json` 的版本号已经改对
2. 本地提交的代码就是你要发布的代码
3. 推送的 tag 形如 `v1.0.4`
4. tag 和 `frontend/package.json` 的版本完全一致
5. GitHub Actions 里四个 job 都成功

## 12. 这套流程的目标

这套流程的目标不是“保证所有 Mac 用户 100% 双击必开”，因为当前没有 Apple 开发者账号，也没有做签名和公证。

这套流程能做到的是：

- 把安装包自身的大部分技术性问题前移到 GitHub CI 中发现
- 在发布前校验：
  - app 能否构建
  - backend 能否启动
  - Node / Playwright Chromium 能否启动
  - dmg 解包后的 app 能否再次通过校验

所以以后你可以把它理解成：

- `GitHub Actions 全部通过 = 安装包本身大概率没有明显技术故障`

但仍然不等于：

- `所有用户机器一定完全无阻碍打开`

## 13. 当前文档适用范围

这份文档当前主要针对：

- GitHub Actions 上的 macOS dmg 发版流程

不再描述旧的 Windows EXE 手工打包流程。

如果以后 Windows 发版流程也要长期维护，建议单独写一份文档，不要和 mac 发版说明混在一起。
