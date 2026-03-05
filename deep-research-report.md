# Codex CLI 沙箱实现机制深度解析

## 执行摘要

本报告基于公开的一手资料（官方文档与源码）对“Codex CLI 如何实现沙箱、具体技术是什么”进行技术拆解与安全分析。这里的“Codex CLI”按你的指示**默认指代entity["organization","OpenAI","ai research org"]开源的 Codex CLI（仓库 `openai/codex`，npm 包 `@openai/codex`）**；若你指的是其他同名工具，则下述结论可能不适用（本报告在“未覆盖与假设”中列出关键假设与缺口）。citeturn7search0turn7search2

核心结论可以概括为：

Codex CLI 的“沙箱”并不是单一技术，而是“**OS 级强制访问控制（MAC）/内核隔离 + CLI 层的权限/审批策略 + 环境变量与工具链适配**”的组合：  
- **macOS**：通过 **Seatbelt**（`/usr/bin/sandbox-exec`）对被执行命令的**整个进程树**施加 SBPL 策略；策略默认“deny default”，按“可写根目录 + 只读子路径（如 `.git`、`.codex`）”细粒度放行，并按需要动态拼接网络策略（可走代理端口、可选 localhost 绑定）。citeturn22view0turn23view2turn25view0turn25view2  
- **Linux**：存在两条路径：默认的 **Landlock + seccomp（并可叠加 mount/命名空间）** 与可选的 **bubblewrap(bwrap) 管线**。bwrap 管线通过 `--ro-bind / /` 让根文件系统只读，再用 `--bind` 叠加“可写根目录”，并用 `--ro-bind` 重新压回 `.git`、`.codex` 等敏感子路径为只读，同时隔离 PID（`--unshare-pid`）与（在需要时）网络命名空间（`--unshare-net`），再在“内层阶段”安装 `PR_SET_NO_NEW_PRIVS` 与网络 seccomp 过滤器。citeturn5view0turn8view1turn26view2turn28view0  
- **Windows（原生）**：文档层面描述为“受限令牌 + capability SID + 网络禁用（环境变量/工具替身）”。源码显示其实现包含：  
  1) 以 **CreateRestrictedToken** 生成受限 token，并把 capability SID、Logon SID、Everyone SID 组装进 token；同时设置较宽松的 default DACL 以避免管道/IPC 报错；citeturn15view0  
  2) 以 ACL allow/deny 机制对“工作区可写、`.git/.codex/.agents` 只读”进行约束；citeturn19view0  
  3) 执行时可走“沙箱用户 + CreateProcessWithLogonW + 命名管道 + request 文件”的管线（并有 TODO 暗示未来会替换掉 request 文件 IPC）。citeturn20view3turn19view5  
  同时实现了“世界可写目录（Everyone 可写）的快速审计与缓解（对 capability deny ACE）”，并承认在 world-writable 目录里很难阻止写入。citeturn13view0turn10search2turn10search5  

在资源限制方面：Codex CLI 的主要“资源控制”是 **命令级超时（`timeout_ms`）** 与“进程随父进程退出”的治理（Linux 上通过 `prctl` 设置 parent-death signal 等）；但从公开源码看，未见通用的 CPU/内存 cgroup 限额或类似 Job Object 的强制统一限额（Windows 侧更多是权限/ACL 与网络封控）。citeturn32view0turn26view2turn31search10  

已公开安全事件方面：entity["organization","Check Point Research","security research team"]公开披露过 Codex CLI 的一项命令注入/执行链问题，并指出在 0.23.0 版本修复（阻止 `.env` 等机制把 `CODEX_HOME` 重定向到项目目录触发执行路径）。该披露未必对应公开 CVE（报告中未明确给出 CVE 编号），但属于实证的已披露漏洞案例。citeturn7search16  

## 研究范围与主要证据链

本报告优先使用三类资料，并尽量把“机制—代码入口—策略文本/参数—安全含义”串起来：

第一类：官方文档（安全与平台说明、Windows 沙箱说明、配置层与模式解释）。citeturn10search5turn10search2turn7search2turn10search9  

第二类：开源仓库源码（Rust）：  
- macOS Seatbelt：`codex-rs/core/src/seatbelt.rs` + `seatbelt_base_policy.sbpl` + `seatbelt_network_policy.sbpl`（SBPL policy 由代码动态拼接并通过 `sandbox-exec -p` 注入）。citeturn22view0turn23view0turn23view2  
- Linux：`codex-rs/linux-sandbox/*`（bwrap 组装、seccomp/PR_SET_NO_NEW_PRIVS、（legacy）Landlock 规则）。citeturn5view0turn8view1turn26view2turn28view0turn27view0  
- Windows：`codex-rs/windows-sandbox-rs/*`（token、ACL、allow/deny、审计、env 无网、setup orchestrator、elevated runner）。citeturn14view1turn15view0turn16view0turn19view0turn16view4turn20view3  
- 进程生成与环境变量治理：`codex-rs/core/src/spawn.rs`、`codex-rs/core/src/exec_env.rs`。citeturn32view0turn34view0  

第三类：权威安全/工程分析与缺陷跟踪（主要来自公开 issue 与安全研究文章，用于补充“现实边界/失败模式/潜在逃逸面”）。citeturn7search16turn31search10turn12search11turn12search20turn21search0  

为便于你复核源码，本报告在关键位置提供“文件路径 + 行号（基于 raw 源码视图）”，并在“源码链接”代码块中列出可直接打开的链接（按系统要求，URL 以代码块形式给出）。

## 总体架构概览

Codex CLI 的执行链可抽象为三层：

第一层：**交互与策略层**（TUI/非交互 `codex exec` 等）。官方文档明确其“本地运行、可读/改/跑代码，并默认关网”，并把安全控制描述为“OS 强制沙箱 + 审批策略”。citeturn7search2turn10search5turn34view0  

第二层：**沙箱策略对象（SandboxPolicy）与环境治理**：  
- `spawn_child_async` 会对每次 shell 工具调用构造一个“清理后的环境”（`env_clear()` + `create_env`），并在网络未全开放时注入 `CODEX_SANDBOX_NETWORK_DISABLED=1`。citeturn32view0turn34view0  
- `exec_env.rs` 显示默认会过滤疑似敏感环境变量：匹配 `*KEY*/*SECRET*/*TOKEN*` 的变量默认会被剔除，避免把凭据泄露给被执行进程。citeturn34view1turn34view3  

第三层：**平台沙箱执行器**：  
- macOS：`spawn_command_under_seatbelt` 以 `/usr/bin/sandbox-exec` 启动，并在子进程环境中设置 `CODEX_SANDBOX=seatbelt`；同时代码刻意只信任 `/usr/bin/sandbox-exec`，避免 PATH 劫持。citeturn22view0turn32view0  
- Linux：通过 `codex-linux-sandbox` 辅助程序（可由 `codex-exec`/`codex` 多工具分派），实现“bwrap 文件系统视图 + seccomp/no_new_privs +（可选）netns/pidns”。citeturn5view0turn26view2turn8view0turn27view0  
- Windows：通过 windows-sandbox-rs 的 restricted token/ACL/用户隔离与“denybin/代理环境变量”网络封控来实现。citeturn10search2turn15view0turn16view0turn20view3  

源码链接（便于逐行核对）：
```text
Repo: https://github.com/openai/codex

macOS Seatbelt:
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/seatbelt.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/seatbelt_base_policy.sbpl
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/seatbelt_network_policy.sbpl

Linux sandbox:
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/README.md
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/src/lib.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/src/linux_run_main.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/src/bwrap.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/src/landlock.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/src/vendored_bwrap.rs

Windows sandbox:
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/lib.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/token.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/env.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/allow.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/audit.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/setup_orchestrator.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/windows-sandbox-rs/src/elevated_impl.rs

Process spawn & env filtering:
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/spawn.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/exec_env.rs
```

## 沙箱模型与隔离机制

这一节按你指定维度拆解：进程隔离、容器/VM、seccomp/namespaces/chroot、user namespaces 等，并指出 Codex CLI 的“已用/未用”。

### macOS：Seatbelt（sandbox-exec）+ 动态 SBPL 组装

**入口与可信执行器**  
`seatbelt.rs` 明确只使用 `/usr/bin/sandbox-exec`，理由是避免攻击者通过 PATH 注入恶意 `sandbox-exec`；并在子进程环境标记 `CODEX_SANDBOX=seatbelt`。citeturn22view0turn32view0  

**策略形态（默认 deny）与进程树继承**  
`seatbelt_base_policy.sbpl` 的开头 `(deny default)` 表示“默认拒绝”；且注释指出子进程继承父进程策略（并显式允许 `process-exec`、`process-fork` 等）。citeturn23view2  

**文件系统策略：可写根目录 + 只读敏感子路径**  
`create_seatbelt_command_args_with_extensions` 会根据 `SandboxPolicy` 生成：  
- 若“全盘可写”，它使用更宽松的 file-write 规则；否则枚举 `writable_roots`，对每个 root 建参数 `WRITABLE_ROOT_i`，并对 `.git`、`.codex` 等 read-only 子路径生成 `(require-not (subpath ...))` 约束，从而实现“根目录可写但敏感子路径不可写”。citeturn22view0turn25view0turn25view2  

单元测试进一步验证了“在可写根目录中写 `.codex/config.toml` 与 `.git/hooks/*` 会被阻止，但写其他普通文件允许”。citeturn25view2turn25view4  

**网络策略：全关、全开、代理端口、可选本地绑定**  
- `dynamic_network_policy`：当检测到代理环境时，会把网络出站限制为 `localhost:<proxyPort>`；如果显式允许本地绑定，则额外允许 `network-bind`/`network-inbound`/`network-outbound` 的 localhost 范围；若“托管网络”要求存在但无法推导可用端口，则 fail-closed 返回空策略（等价于不启用网络放行）。citeturn22view0turn24view1  
- `seatbelt_network_policy.sbpl` 还放行了一些与系统网络服务相关的 mach-lookup 名称与安全 socket（参考 entity["organization","Chromium","open source browser project"] sandbox policy 链接），并允许写入 Darwin user cache 目录。citeturn23view0  

**使用到的“沙箱原语/机制”清单（macOS）**  
- 进程隔离：**否（不创建容器/VM）**；依赖 OS MAC 策略约束进程能力。citeturn23view2turn22view0  
- namespaces/seccomp/chroot：**不适用/未使用**（这些是 Linux 语境）。  
- 语言运行时隔离（V8 isolate / Python subinterpreter / WASM）：**未见使用**；沙箱粒度是 OS 进程/进程树。citeturn22view0turn7search2  

### Linux：seccomp + PR_SET_NO_NEW_PRIVS +（可选）Landlock + bubblewrap（bwrap）

Linux 沙箱在仓库中被描述为一个“Linux sandbox helper”，由 `codex-linux-sandbox` 负责；并明确指出当前既保留 legacy Landlock/mount 方案，也提供 bwrap 管线（通过 feature gate `use_linux_sandbox_bwrap`）。citeturn5view0turn8view0turn26view2  

**bwrap 管线：文件系统视图 + PID/NET 命名空间**  
`bwrap.rs` 注释给出设计目标：与 macOS Seatbelt 语义对齐：默认只读、显式可写根、敏感子路径保持只读。citeturn8view1  

关键实现点：  
- **只读根**：`--ro-bind / /`。citeturn8view1  
- **可写根目录叠加**：对每个 `writable_root` 加 `--bind <root> <root>`。citeturn8view1  
- **敏感子路径再只读**：再对 `.git`、`.codex` 等子路径 `--ro-bind`，并处理两类绕过：  
  - 若子路径链路中存在 symlink（且位于允许写的根内），会把 `/dev/null` `--ro-bind` 到该 symlink 位置；  
  - 若子路径不存在但在可写根内，会定位“第一个缺失组件”，然后把 `/dev/null` 绑定到该缺失组件，阻止创建整段路径。citeturn8view1  
- **命名空间隔离**：默认 `--unshare-pid`；当网络受限/代理模式（实现上 fail-closed 视为隔离）会 `--unshare-net`；并默认 `--proc /proc` 挂载新 proc（可在受限容器里 `--no-proc`）。citeturn8view1turn26view2  

**两阶段执行：先 bwrap，后 seccomp/no_new_privs，再 exec**  
`linux_run_main.rs` 明确了执行序列：  
1) 需要时先用 bwrap 构造文件系统视图；  
2) 再对“内层阶段”启用 `no_new_privs + seccomp`；  
3) 最后 `execvp` 进入用户命令。citeturn26view2  

之所以分两阶段，是因为部分 bwrap 部署依赖 setuid；而 `PR_SET_NO_NEW_PRIVS` 会影响 setuid，因此仅在需要 seccomp 或 legacy Landlock FS 方案时才打开 no_new_privs（并在 bwrap 完成后再 tighten）。citeturn8view2turn26view2  

**网络 seccomp：阻断大多数网络 syscalls，只允许 AF_UNIX**  
`landlock.rs` 的 `install_network_seccomp_filter_on_current_thread` 构造了规则：直接 deny `connect/bind/listen/sendto/...` 等，并对 `socket/socketpair` 加条件：当 domain != `AF_UNIX` 时触发 `EPERM`；同时还 deny `ptrace`、`io_uring_*` 等。citeturn28view0turn28view2  

这意味着在“网络禁用”模式下，即便进程试图创建 TCP/UDP socket，也会因 seccomp 返回 EPERM 失败；而 AF_UNIX 仍可用于本地 IPC。citeturn28view2  

**Landlock（legacy/备用）**  
源码说明 Landlock FS 规则目前“不是主路径”（因为 FS 由 bwrap 承担），但保留做 fallback：规则集默认给全盘 read-only（`"/"` read），并仅对 `/dev/null` 与 `writable_roots` 给写权限；若 Landlock 未 enforced 则返回错误 `LandlockRestrict`。citeturn28view0turn28view1  

**bubblewrap 的“vendoring”**  
`vendored_bwrap.rs` 说明构建时会编译 bubblewrap 的 C 源码并通过 FFI 暴露 `bwrap_main`，运行时直接调用（成功时会 `execve` 到目标程序，因此函数不返回）。citeturn27view0  

### Windows：受限 Token + ACL 能力域 + 网络封控（env + stub）+ 沙箱用户管线

官方 Windows 文档给出高层描述：  
- 在受限 token（源自 AppContainer profile）中启动；  
- 通过给 profile 附加 capability SIDs 授予特定文件系统能力；  
- 通过覆盖代理相关环境变量并插入常见网络工具的 stub 来禁用出站网络；  
- 主要限制：若目录对 Everyone SID 可写，沙箱无法阻止写入。citeturn10search2turn10search5  

源码细节补全如下（以 windows-sandbox-rs 为主）：

**Token 限权：CreateRestrictedToken + capability SID 注入**  
`token.rs` 使用 `CreateRestrictedToken`，并把“Capabilities… + Logon + Everyone”按顺序写入 token groups（并启用 `SeChangeNotifyPrivilege` 以保证基本文件通知能力）。同时显式设置 default DACL 为“对这些 SIDs 给 GENERIC_ALL”，以避免 PowerShell 管道/IPC 对象创建时遇到 ACCESS_DENIED。citeturn15view0  

**可写域/保护域：Allow/Deny 目录集合（包含 `.git/.codex/.agents`）**  
`allow.rs` 在 `workspace-write` 模式中：  
- allow：工作目录与额外 `writable_roots`；  
- deny：在这些可写根下的 `.git`、`.codex`、`.agents`（存在时）；  
- 可选把 TEMP/TMP 也加入 allow（除非明确排除）。citeturn19view0turn19view2  

**世界可写审计与缓解（对 capability deny ACE）**  
`audit.rs` 会在时间/数量上限内扫描候选目录（CWD、TEMP/TMP、USERPROFILE、PUBLIC、PATH、`C:/`、`C:/Windows` 等），检查 ACL 是否允许 world-write；若发现，将其纳入 “flagged”。之后 `apply_capability_denies_for_world_writable` 会对不属于 workspace roots 的 flagged 路径尝试写入“capability deny ACE”。citeturn13view0turn13view0turn13view0  

这与官方文档“world-writable 目录是主要限制，需要扫描提醒”的表述一致。citeturn10search2turn10search5  

**无网策略：代理变量 + denybin stub + PATH/PATHEXT 调整**  
`env.rs` 的 `apply_no_network_to_env`：  
- 把 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 设为不可用的 `127.0.0.1:9`，并设置 `NO_PROXY`；  
- 设置一系列离线/禁用开关（`PIP_NO_INDEX`、`NPM_CONFIG_OFFLINE`、`CARGO_NET_OFFLINE` 等）；  
- 用批处理脚本（`.bat/.cmd`）生成 denybin：对 `ssh/scp` 创建 stub；并重排 `PATHEXT` 让 `.BAT/.CMD` 优先，从而拦截常见网络工具调用。citeturn16view0  

**elevated/沙箱用户执行链：CreateProcessWithLogonW + Named Pipes + request 文件**  
`elevated_impl.rs` 说明其把命令 runner 以沙箱用户凭据通过 `CreateProcessWithLogonW` 启动；STDIO 通过命名管道传输；并把执行请求序列化成 JSON 写入 `.sandbox/requests/request-*.json` 供 runner 读取，源码里标注 TODO 未来将替换这种机制。citeturn20view3turn19view5turn20view3  

这带来一个明确的“残留面”：相关 issue 指出 request 文件可能未及时删除，可能包含命令参数、env map、路径等敏感信息。citeturn12search20turn20view3  

## 文件系统与网络限制的实现细节

### 文件系统：从“策略对象”到“内核约束”的落地路径

**macOS（Seatbelt）**  
文件策略被拼接成 SBPL，并通过 `sandbox-exec -p <policy>` 注入。策略中对每个 writable root 以 `-DWRITABLE_ROOT_i=<path>` 方式参数化，从而避免硬编码路径；并用 `(require-not (subpath ...))` 抑制只读子路径。citeturn22view0turn25view0  

**Linux（bwrap）**  
文件策略直接转化为 bubblewrap mount flags，核心顺序固定为：  
1) `--ro-bind / /`；  
2) `--bind root root`（每个可写根）；  
3) `--ro-bind` 把敏感子路径压回只读（并额外处理 symlink/缺失路径组件用 `/dev/null` 覆盖）；  
4) 保持 `/dev/null` 可用（`--dev-bind /dev/null /dev/null`）。citeturn8view1  

**Windows（ACL + capability 域）**  
Windows 侧不是 mount view，而是：  
- 通过 allow/deny 目录集合决定哪些路径对“workspace capability SID”授予写/读能力，哪些路径要 deny；  
- 并对 world-writable 目录做额外 deny ACE 修补，减少 Everyone 可写导致的逃逸面。citeturn19view0turn13view0turn18view0  

### 网络限制：OS 级阻断 + 环境级“软封控”

**默认关网与跨平台标记**  
`spawn.rs` 会在 `SandboxPolicy.has_full_network_access()` 为 false 时设置 `CODEX_SANDBOX_NETWORK_DISABLED=1`，这是一个跨平台的“执行期信号”，便于工具链自检/调试。citeturn32view0  

**macOS**  
- 若需要走代理，策略只允许出站到 `localhost:proxyPort`；  
- 若允许本地 binding，则新增 loopback bind/inbound/outbound 放行；  
- 否则网络策略为空（fail-closed）。citeturn22view0turn24view1  

**Linux**  
- 网络受限时：seccomp 直接阻断 socket/connect/bind 等关键 syscalls，并限制只允许 AF_UNIX；在 bwrap 管线下还会 `--unshare-net`，使其处于独立 netns（更强的隔离）。citeturn28view2turn8view1turn26view2  

**Windows**  
- “硬约束”主要来自受限 token + ACL（对网络本身不一定是内核强制隔离）；  
- “软封控”则通过代理环境变量、离线模式变量与 denybin stub 来拦截常见网络工具。citeturn16view0turn10search2  

## 权限模型、IPC、资源限制与生命周期

### 权限/能力模型：SandboxMode + 审批策略 + 额外能力请求

官方安全文档把本地安全表述为：OS 沙箱限制“通常仅限于当前 workspace”，并叠加审批策略控制“何时必须询问”。默认网络关闭；`workspace-write` 模式可通过配置打开网络。citeturn10search5turn10search9  

从代码视角，权限模型主要落在 `SandboxPolicy` 的三个关键维度上：  
- 磁盘读：是否全盘可读（Seatbelt 支持限制 read roots；Linux bwrap 对“restricted read-only access”尚不支持；Windows backend 也明确暂不支持受限只读）。citeturn8view1turn20view1turn16view1  
- 磁盘写：可写根目录与敏感只读子路径（macOS 与 Linux bwrap 与 Windows allow/deny 目标趋同）。citeturn25view0turn8view1turn19view0  
- 网络：全关/全开/代理受控（macOS 与 Linux 有 OS 级阻断，Windows 更多依赖工具封控）。citeturn22view0turn28view0turn16view0  

### IPC：为什么说它既是“功能需要”，也是“潜在攻击面”

macOS/Linux 路径下，沙箱执行器基本是“在同一父进程下 spawn 子进程”，IPC 主要是标准输入输出与必要的系统服务调用（例如 Seatbelt network policy 放行 `com.apple.SecurityServer` 等 mach-lookup）。citeturn32view0turn23view0  

Windows 路径下 IPC 更显式：  
- STDIO 通过 Named Pipe；citeturn20view2turn19view5  
- 任务请求通过 request JSON 文件传递，且源码标注未来要更换机制，这意味着目前方案在“落盘请求文件的清理与保护”上存在工程与安全权衡。citeturn20view3turn12search20  

### 资源限制：timeout 为主，缺少通用 CPU/内存强限额证据

**超时（timeout_ms）**  
社区 issue 与代码片段表明 shell 工具调用存在 `timeout_ms` 参数，但也出现过“只杀 shell wrapper 不杀子进程导致挂死”的问题，并提出需要 kill 整个进程组的修复路径（process group / setsid）。citeturn31search10turn31search1turn31search2  

**父死亡信号与 kill-on-drop**  
`spawn.rs` 展示了两个与生命周期强相关的机制：  
- `cmd.kill_on_drop(true)`：当 `Child` 被 drop 时尝试终止；citeturn32view0  
- Linux 上在 `pre_exec` 中通过 `prctl` 设置 “parent 退出则给子进程发 SIGTERM”（依赖 `set_parent_death_signal`），并可选择 detach from TTY。citeturn32view0  

**CPU/内存/系统调用额度**  
在已抓取的公开源码里：  
- Linux bwrap 管线未显示 cgroup 限额参数；  
- macOS Seatbelt policy 属于权限控制，不直接设置 CPU/内存；  
- Windows 管线偏权限域/ACL/网络封控，未见 Job Object 级统一资源限额的直接证据。  
因此，本报告只能严谨地说：**公开资料能直接确认的是“时间（timeout）+ 进程生命周期管理 + 系统调用/权限约束”，而不是完整的资源配额沙箱**。citeturn26view2turn32view0turn28view2  

### 沙箱生命周期：从命令触发到 teardown

下面用 mermaid 给出“单次 shell 命令执行”的生命周期（按 OS 分支），对应上面源码的真实分岔点与阶段划分：citeturn22view0turn26view2turn20view3turn32view0  

```mermaid
flowchart TD
  A[用户/模型产生 shell 工具调用] --> B[解析 ExecParams<br/>含 cwd / timeout_ms / 是否请求提权等]
  B --> C[构造 SandboxPolicy + ShellEnvironmentPolicy]
  C --> D[create_env: env_clear + 继承策略 + 默认剔除 *KEY/*SECRET/*TOKEN + 可选 include_only<br/>注入 CODEX_THREAD_ID]
  D --> E{平台选择}

  E -->|macOS| M1[seatbelt.rs: create_seatbelt_command_args<br/>拼接 base/file/network/unix-socket/extension policy]
  M1 --> M2[/usr/bin/sandbox-exec -p <SBPL> -D... -- <command...>]
  M2 --> M3[子进程树受 Seatbelt 约束<br/>输出/退出码回传]
  M3 --> Z[teardown: 进程退出即释放策略范围]

  E -->|Linux| L1[codex-linux-sandbox: run_main]
  L1 --> L2{use_bwrap_sandbox?}
  L2 -->|是| L3[外层: vendored bwrap<br/>--ro-bind / / + --bind writable roots<br/>--ro-bind 保护子路径<br/>--unshare-pid (+ --unshare-net 可选)<br/>--proc /proc 可探测失败回退]
  L3 --> L4[内层: apply seccomp + PR_SET_NO_NEW_PRIVS<br/>(thread-scope) 然后 execvp]
  L2 -->|否(legacy)| L5[legacy: Landlock(可选) + seccomp 然后 execvp]
  L4 --> L6[命令运行/退出<br/>stderr/stdout 回传]
  L6 --> Z

  E -->|Windows| W1[setup_orchestrator: 可选 setup refresh<br/>准备沙箱用户/ACL/allow/deny roots]
  W1 --> W2[env.rs: apply_no_network_to_env<br/>proxy env + denybin stubs + PATHEXT 重排]
  W2 --> W3[elevated_impl: 生成 request-*.json + named pipes<br/>CreateProcessWithLogonW 启动 runner]
  W3 --> W4[runner 读取 request 文件执行命令<br/>stdout/stderr 经 pipe 回传]
  W4 --> Z
```

## 逃逸向量、已知缺陷与缓解现状

这一节把“潜在逃逸面/失败模式”按“攻击者是谁、能控制什么”来梳理，并对照公开证据给出缓解强度。

### 威胁模型简化版

Codex CLI 的本地沙箱主要面向两类风险：

- **模型误用/被提示注入诱导**：模型生成危险命令（删库、外连、写敏感路径）或在工具输出中被注入恶意指令。官方定位是“默认关网 + OS 沙箱 + 审批”降低误用概率与破坏半径。citeturn10search5turn7search2  
- **不可信仓库/依赖**：用户在不可信代码库中运行 Codex，仓库内容（脚本、hook、配置）试图诱导/劫持执行路径。Seatbelt/Linux bwrap/Windows deny paths 对 `.git` 与 `.codex` 的保护属于对这类风险的直接响应（防止写 hook、改 Codex 配置）。citeturn25view2turn8view1turn19view0  

### 典型逃逸/破坏路径与 mitigations

**路径一：写入 `.git` hook 或修改 `.codex` 配置来持久化执行链**  
- macOS：测试证明 `.git` 与 `.codex` 子路径写入会被 Seatbelt 阻止。citeturn25view2turn25view4  
- Linux（bwrap）：明确会把 `.git`、解析后的 `gitdir:`、`.codex` 重新 ro-bind，并对 symlink/缺失路径组件做 `/dev/null` 覆盖，属于对“符号链接替换攻击”的明确缓解。citeturn5view0turn8view1  
- Windows：allow/deny 逻辑把 `.git/.codex/.agents` 放入 deny 集合（存在时），属于同类缓解。citeturn19view0  

**路径二：网络外连/数据外泄**  
- macOS：Seatbelt 通过网络 policy 控制到“全禁 / 代理端口 / 全开”，并在托管网络条件下 fail-closed。citeturn22view0turn24view1  
- Linux：seccomp 阻断非 AF_UNIX socket 与多种网络 syscalls；bwrap 可额外 unshare netns。citeturn28view2turn26view2  
- Windows：以环境变量/denybin 方式软阻断常见网络工具，但其强度取决于调用路径（例如程序直连 Winsock 可能不经过 `curl/wget/ssh`），官方也强调 Windows 沙箱仍有重要限制。citeturn16view0turn10search2turn10search5  

**路径三：通过 world-writable 目录突破“不可写”假设（Windows 尤其突出）**  
官方与源码一致承认：若目录对 Everyone 可写，沙箱难以阻止写入。Windows 侧的缓解是“快速扫描 + 尝试应用 capability deny ACE”，并提示用户修正权限。citeturn10search2turn13view0  

**路径四：IPC/落盘中间态泄露（Windows request 文件）**  
elevated runner 通过 request JSON 文件传参，且已有 issue 指出文件可能残留。此类残留会扩大“本地取证/恶意同机用户读取”的信息面。citeturn20view3turn12search20  

**路径五：超时/进程组治理不完整导致“卡死”与潜在资源耗尽**  
公开 issue 指出：超时触发时若只 kill wrapper（如 `bash -lc`），子进程仍可能存活并保持管道不关闭，从而把 Codex 卡在“工作中”；修复方向是 setsid/kill process group。citeturn31search10turn31search1  

### 已披露漏洞与 CVE 情况

entity["organization","Check Point Research","security research team"]披露过一项 Codex CLI 漏洞：其 PoC 展示了通过项目文件触发的执行链，并指出 entity["organization","OpenAI","ai research org"]在 0.23.0 修复（阻止项目本地的 `CODEX_HOME` 重定向等自动执行路径），并建议更新到 0.23.0+。该公开文章未明确给出 CVE 编号，因此本报告只能确认“存在公开披露与修复版本号”，不能严谨断言其 CVE 映射。citeturn7search16  

此外，仓库 issue 中存在多项“安全语义不符合用户预期”的报告（如默认 read-only 是否应允许全盘读取、不同平台行为差异等），但这些更多是“设计/产品语义争议或缺陷”，并非已标准化编号的 CVE。citeturn12search14turn12search17turn12search11  

## 技术对比表与未覆盖项

### 已实现技术 vs 可替代方案对比

| 维度 | Codex CLI 现实现（证据） | 替代方案（典型） | 优势 | 代价/局限 |
|---|---|---|---|---|
| macOS 沙箱 | Seatbelt：`/usr/bin/sandbox-exec` + SBPL 动态生成；默认 `(deny default)`，按 writable roots 放行；策略作用于进程树citeturn22view0turn23view2 | 运行在容器/VM（如 Lima/Colima、轻量 VM） | 与系统安全模型一致；对文件/网络细粒度 | sandbox-exec 已被 macOS 标注为 deprecated（生态层面风险）；策略可用性与兼容性受应用行为影响（如 Mach API 权限不足导致 `os.cpus()` 异常）citeturn21search0turn4search7 |
| Linux 沙箱 | seccomp + `PR_SET_NO_NEW_PRIVS`（线程级）+（可选）bwrap `--ro-bind`/`--unshare-pid`/`--unshare-net`；legacy Landlock 备用citeturn28view2turn26view2turn8view1turn28view1 | Docker/Podman 容器；gVisor；Firecracker/microVM；仅 chroot | 无需守护进程；对 FS/NET/PID 组合隔离；与 macOS 语义趋同 | 依赖内核特性（seccomp/Landlock/bwrap）；在受限环境（某些容器/WSL1/Lambda）可能不可用或需要降级citeturn4search6turn4search9turn10search5 |
| Windows 沙箱 | CreateRestrictedToken + capability SIDs + ACL allow/deny + world-writable 审计；网络以 proxy env + denybin stub 软封控；可走沙箱用户执行链citeturn15view0turn19view0turn13view0turn16view0turn19view5 | Job Object + 低完整性（Low IL）+ AppContainer 强隔离；Windows Sandbox/WSL2 容器 | 与原生 Windows API 兼容；可逐步增强（capability/ACL） | world-writable 目录难防；软封控难覆盖所有网络路径；IPC 落盘请求文件带来残留面citeturn10search2turn12search20 |
| 语言/运行时隔离 | 以 OS 进程沙箱为主；未见 V8 isolate / Python subinterpreter / WASM 作为主要隔离层citeturn7search2turn22view0turn26view2 | 把用户代码放入 WASM runtime、JS isolate、Py sandbox | 细粒度、跨平台一致 | 复杂度高；对真实构建/测试生态兼容性差 |
| 资源限额 | 主要是 `timeout_ms` + 生命周期治理（kill_on_drop、Linux prctl parent-death-signal 等）；未见通用 CPU/内存配额证据citeturn32view0turn31search10 | cgroups v2（CPU/mem/pids）、rlimit、Windows Job Object | 可防 DoS/挖矿/无限 fork | 跨平台工程复杂；对开发工具链可能产生大量兼容问题 |

### 未覆盖与假设清单

本报告严格基于公开资料；以下项若你希望进一步确认，需要额外的“源码全量检索/构建产物逆向/运行时实验”，但它们不在当前公开证据链可确定的范围内：

- **是否存在真正的“AppContainer token”创建链**：官方文档提到 AppContainer profile，但从目前抓取到的核心实现（CreateRestrictedToken + capability SID + 沙箱用户管线）尚不足以无歧义证明“命令执行 token 一定属于 AppContainer 类型”。citeturn10search2turn15view0turn19view5  
- **CPU/内存/磁盘 IO 的硬限额**：公开代码片段能确认 timeouts 与部分进程治理，但无法确认是否在别处（例如未抓取到的模块）对资源做了强配额。citeturn31search10turn32view0turn26view2  
- **受限“只读读权限”（restricted read roots）在 Linux/Windows 的完整落地**：Linux bwrap backend 明确提示 restricted read-only access 未支持；Windows backend 也提示类似信息；macOS seatbelt 具备 read roots 参数化能力，但跨平台一致性仍在演进。citeturn8view1turn20view1turn16view1turn22view0  

（完）