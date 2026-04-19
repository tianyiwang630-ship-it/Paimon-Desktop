# OpenClaw 与 learn-claude-code 的多 Agent 机制分析

## 1. 这份分析在回答什么

这次不讨论“模型聪不聪明”，只讨论 harness engineering。

核心问题是：

1. `openclaw` 的多 agent 机制到底是怎么落地的。
2. `learn-claude-code` 的多 agent 机制到底是怎么分阶段搭起来的。
3. 两者在 agent 编排、运行时基础设施、入口、工作区、持久化、长期运行方式上，有什么本质差别。
4. 这些差别对 `agent-alpha` 这种正在做架构收敛的项目，有什么启发。

这次采用的是静态读代码和文档的方法，没有实际运行项目。

---

## 2. 一句话结论

如果只看多 agent 机制：

- `learn-claude-code` 更像一套“教学型分层演进模型”
- `openclaw` 更像一套“产品级长期运行 runtime”

更直白一点：

- `learn-claude-code` 解决的是：怎样把 Claude Code 风格的 harness 机制一层一层讲清楚
- `openclaw` 解决的是：怎样把 agent、session、gateway、cron、heartbeat、channel routing、workspace、delivery 全部放进一个长期运行系统里

所以这两个项目不是简单的“谁高级谁低级”关系，而是：

- `learn-claude-code` 强在抽象清晰、边界干净、教学意义强
- `openclaw` 强在控制面完整、状态持久化完整、生命周期处理完整

---

## 3. 总体判断

### 3.1 `learn-claude-code` 的多 agent 本质

它的基本思想是：

- agent loop 永远尽量简单
- 新能力不要改坏 loop 本身
- 多 agent 是在 loop 外面叠出来的 harness 机制

从 README 的编排就能直接看出来，它是按 session 渐进式构建的：

- `s04` 子 agent
- `s07` 任务系统
- `s08` 后台任务
- `s09` agent 团队
- `s10` 团队协议
- `s11` 自主 agent
- `s12` task + worktree 隔离

也就是说，它不是一开始就做“多 agent runtime”，而是先证明每一层机制为什么存在。

### 3.2 `openclaw` 的多 agent 本质

它的基本思想是：

- agent 不只是一次性的 REPL 进程
- agent 有身份、工作区、会话、路由、消息目标、状态存储、生命周期
- 子 agent 不是普通函数调用，而是受管 session run

所以 `openclaw` 的多 agent 不只是“spawn 一个子任务”，而是：

- 先通过 routing 找到 agent
- 再通过 gateway 和 session store 建立会话语义
- 再通过 subagent runtime、cron isolated runtime、heartbeat runner 等机制运行
- 最后通过 delivery、session lifecycle、announce、cleanup 回收

它的多 agent 是“系统级会话编排”，不是“工具级委派”。

---

## 4. 入口层：两边是怎么进入多 agent 世界的

## 4.1 `learn-claude-code` 的入口

它的入口非常直接，几乎是“每个阶段一个脚本”：

- [s04_subagent.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s04_subagent.py)
- [s07_task_system.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s07_task_system.py)
- [s09_agent_teams.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s09_agent_teams.py)
- [s11_autonomous_agents.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s11_autonomous_agents.py)
- [s12_worktree_task_isolation.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s12_worktree_task_isolation.py)
- [s_full.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s_full.py)

这种入口设计的特点是：

- 每个文件自带完整 demo
- 每个文件能单独运行
- 每个文件尽量只强调一个新机制

优点是非常利于理解。

缺点是：

- 控制面是分散的
- 不像产品 runtime 那样有统一调度层
- 很多状态和约束是“脚本内约定”，不是系统级服务

### 4.2 `openclaw` 的入口

`openclaw` 的入口是统一装配出来的。

关键文件：

- [build-program.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\program\build-program.ts)
- [register.agent.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\program\register.agent.ts)
- [run.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\gateway-cli\run.ts)
- [run-loop.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\gateway-cli\run-loop.ts)

它的入口层大致是这样：

1. `buildProgram()` 创建 CLI 程序上下文
2. 注册所有命令
3. `agent` 命令负责跑单次 agent turn
4. `agents` 命令负责管理隔离 agent
5. `gateway run` 负责启动长期运行服务
6. gateway 内部再承接 session、route、subagent、cron、heartbeat

这说明：

- `learn-claude-code` 是“脚本入口”
- `openclaw` 是“控制面入口”

这差别很大。

---

## 5. agent 编排：两边到底怎么组织多个 agent

## 5.1 `learn-claude-code` 的编排方式

### 第一阶段：子 agent

在 [s04_subagent.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s04_subagent.py) 里，子 agent 的核心机制非常朴素：

- parent 发现需要委派
- 调用 `task` 工具
- `run_subagent(prompt)` 新建一套全新的 `sub_messages`
- 子 agent 只拿到 fresh context
- 子 agent 共享文件系统
- 子 agent 完成后只返回 summary

这个设计很干净，核心思想就是：

`fresh messages[] = context isolation`

这是一种“临时 worker”模型。

### 第二阶段：任务系统

在 [s07_task_system.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s07_task_system.py) 里，任务系统被持久化到 `.tasks/*.json`。

作用不是调度线程，而是给 agent 一个“外部可见且可持久化的计划板”。

它解决的是：

- 任务跨压缩仍然存在
- 任务之间有依赖关系
- agent 可以读写任务状态

这一步很关键，因为后面的多 agent 协作都依赖任务板。

### 第三阶段：agent 团队

在 [s09_agent_teams.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s09_agent_teams.py) 里，编排开始升级：

- teammate 是持久命名成员，不再是一次性 subagent
- 每个 teammate 有自己的 thread
- 每个 teammate 有自己的 inbox
- leader 通过 mailbox 和 teammate 协作

也就是说，`s09` 从“临时委派”切到了“持久团队”。

### 第四阶段：自主协作

在 [s11_autonomous_agents.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s11_autonomous_agents.py) 里，agent 编排进一步变成：

- 有工作时进入 work phase
- 没工作时进入 idle phase
- idle 时轮询 inbox
- idle 时扫描 task board
- 找到无主任务就 claim
- 再回到 work phase

这个设计的重点不在复杂调度，而在“agent 自己找活”。

### 第五阶段：task + worktree 绑定

在 [s12_worktree_task_isolation.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s12_worktree_task_isolation.py) 里，编排被明确分成两层：

- task 是控制平面
- worktree 是执行平面

这是一个非常好的抽象。

因为它把两个常被混在一起的问题拆开了：

- 谁做什么
- 在哪里做

### 小结

`learn-claude-code` 的编排方式是：

从“子 agent 一次性委派”逐步演进到“带任务板、邮箱、自治和 worktree lane 的团队协作”。

它的优点是：

- 每层抽象都很清楚
- 每层能力都能单独理解
- 适合借鉴概念

它的不足是：

- 运行时基础设施偏轻
- 很多状态依赖文件和线程约定
- 没有强控制面的 session 路由和统一服务边界

## 5.2 `openclaw` 的编排方式

`openclaw` 的编排不是从 demo 演进出来的，而是直接建立在 session runtime 上。

关键文件：

- [sessions-spawn-tool.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\tools\sessions-spawn-tool.ts)
- [subagent-spawn.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\subagent-spawn.ts)
- [subagent-registry.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\subagent-registry.ts)
- [action-spawn.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\auto-reply\reply\commands-subagents\action-spawn.ts)

### 多 agent 的正式入口是 session tool

`sessions_spawn` 不是普通便捷工具，而是正式 runtime API。

它支持：

- `runtime=subagent|acp`
- `mode=run|session`
- `thread=true`
- `sandbox=inherit|require`
- `resumeSessionId`
- attachment 传递
- workspace 自动继承

这说明在 `openclaw` 里，spawn 已经被抽象成受控接口，而不是随便开个线程。

### subagent 是受管 run record

`subagent-registry.ts` 说明每个子 agent 运行都有 registry record。

它处理的东西包括：

- run id
- child session key
- requester session key
- started/ended timing
- outcome/status
- announce retry
- completion capture
- persistence to disk
- orphan recovery
- cleanup

这意味着：

- `openclaw` 的 subagent 不是“生成后就不管”
- 它是系统内可追踪、可恢复、可清理的运行单元

### route 先于 spawn

在 [resolve-route.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\routing\resolve-route.ts) 里，agent 并不是直接用名字硬调，而是先根据：

- channel
- account
- peer
- guild
- team
- role

解析到 agent route，然后再生成 session key。

所以 `openclaw` 的编排顺序是：

`route -> session key -> store -> runtime -> delivery`

这比 `learn-claude-code` 的“先有团队角色，再手工通信”重很多，但也稳定很多。

### 小结

`openclaw` 的编排方式是：

把多 agent 当成“基于 session 的受管运行体系”，而不是“多个线程和 mailbox 的组合”。

它的优点是：

- 可恢复
- 可路由
- 可治理
- 可长期运行

代价是：

- 更复杂
- 控制面和运行时耦合度更高
- 学起来明显比 `learn-claude-code` 难

---

## 6. 运行时基础设施：这是两边差异最大的地方

## 6.1 `learn-claude-code` 的运行时基础设施

它的运行时机制主要包括：

- 一个基础 agent loop
- 文件持久化
- 线程
- JSONL mailbox
- worktree index
- 简单后台任务队列

关键代表：

- `s04` fresh messages 形成上下文隔离
- `s07` `.tasks/` 形成持久任务状态
- `s09` `.team/config.json + inbox/*.jsonl` 形成团队状态
- `s11` idle polling 形成自治
- `s12` `.worktrees/index.json + events.jsonl` 形成隔离执行 lane
- `s_full` 把这些机制组合到一起

它的 runtime 风格是：

- 轻量
- 可读
- 本地文件为中心
- 尽量不用复杂基础设施

这非常适合“学习”和“验证机制”，但离产品级 runtime 还有明显距离。

## 6.2 `openclaw` 的运行时基础设施

`openclaw` 的 runtime 层明显厚得多。

### gateway 是长期运行中枢

看 [run.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\gateway-cli\run.ts) 和 [run-loop.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\gateway-cli\run-loop.ts)：

- 有端口锁
- 有 stale process 清理
- 有 force kill/free port
- 有启动失败恢复
- 有 graceful drain
- 有 in-process restart
- 有 full process restart

这不是 demo server，而是真正意义上的服务生命周期管理。

### heartbeat 是主动唤醒机制

看 [heartbeat-runner.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\infra\heartbeat-runner.ts)：

- heartbeat 是按 agent 维度解析的
- heartbeat 和 workspace、session、delivery target 都有关
- 它会尽量避免无效 heartbeat 污染 transcript
- 它会从 agent 配置、session 配置、active hours 等层面决定是否触发

这说明 `openclaw` 的 agent 不是“等你来问”，而是“系统会主动唤醒”。

### cron 是隔离执行机制

看 [cron isolated run](D:\files\demo\0312-newagent\learning proj\openclaw\src\cron\isolated-agent\run.ts)：

- cron job 会解析 agentId
- 会解析 workspaceDir 和 agentDir
- 会解析 model 和 fallback
- 会解析 sessionKey
- 会解析 delivery policy
- 会以 isolated agent turn 的方式执行

所以 cron 在 `openclaw` 里不是单独插件，而是 agent runtime 的另一个入口。

### session store 是统一状态底座

`openclaw` 几乎所有多 agent 能力都围绕 session store：

- spawn 时登记
- announce 时回写
- heartbeat 时读取
- cron 时读取
- route 时解析
- session lifecycle 时管理

这让它的运行时具备一个非常强的统一性：

所有 agent 运行单元最后都会落到 session 语义上。

### 小结

如果说 `learn-claude-code` 的 runtime 像“工具箱 + 文件夹”，  
那 `openclaw` 的 runtime 更像“控制塔 + 调度台 + 档案系统”。

---

## 7. 工作区模型：两边都重视 workspace，但重视的方式不同

## 7.1 `learn-claude-code` 的工作区

`learn-claude-code` 的工作区本质上是当前 repo 目录：

- `WORKDIR = Path.cwd()`
- 所有工具都以这个 cwd 为根
- 子 agent 共享文件系统
- 任务板在 `.tasks/`
- 团队在 `.team/`
- worktree 在 `.worktrees/`

到了 `s12`，它开始明确区分：

- repo root
- worktree path
- task 和 worktree 的绑定关系

但总的来说，它的 workspace 还是“本地目录语义优先”。

## 7.2 `openclaw` 的工作区

`openclaw` 的 workspace 不只是 cwd，而是正式 agent 资源根。

看 [workspace.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\workspace.ts)：

- 默认工作区在 `~/.openclaw/workspace`
- 可以有 profile 化 workspace
- 会 seed bootstrap files
- 有 workspace state
- 有 setup completed 状态
- 有 git 初始化辅助
- 有 boundary-safe 文件读取
- 会识别很多 agent 语义文件：
  - `AGENTS.md`
  - `SOUL.md`
  - `TOOLS.md`
  - `IDENTITY.md`
  - `USER.md`
  - `HEARTBEAT.md`
  - `BOOTSTRAP.md`
  - `MEMORY.md`

这意味着在 `openclaw` 里，workspace 是：

- agent 的人格容器
- bootstrap 入口
- 记忆和规则来源
- session 运行上下文的一部分

而且 `sessions_spawn` 明确规定：子 agent 自动继承父 workspace。

这点非常关键。

### 小结

两边都在用 workspace，但用途不同：

- `learn-claude-code`：workspace 更像当前工程目录
- `openclaw`：workspace 更像 agent 实例根目录

这是你做 `agent-alpha` 时非常该注意的差别。

---

## 8. 状态持久化：谁在磁盘上留下了什么

## 8.1 `learn-claude-code`

主要依赖下面这些文件系统对象：

- `.tasks/task_*.json`
- `.team/config.json`
- `.team/inbox/*.jsonl`
- `.worktrees/index.json`
- `.worktrees/events.jsonl`
- `.transcripts/*.jsonl`

特点是：

- 很直观
- 很可读
- 易于教学
- 但状态类型比较分散

## 8.2 `openclaw`

主要依赖：

- session store
- transcript files
- subagent registry persistence
- workspace state
- cron store
- route/binding config

特点是：

- 统一性更强
- 生命周期更清楚
- 可恢复性更强
- 但系统复杂度显著更高

---

## 9. 多 agent 通信方式：mailbox vs session event

## 9.1 `learn-claude-code`

通信主要依赖 mailbox：

- `send_message`
- `read_inbox`
- `broadcast`
- JSONL inbox per teammate

这是很典型的“文件邮箱”方案。

优点：

- 易懂
- 易调试
- 不依赖复杂服务

缺点：

- 并发约束弱
- 扩展到大量 agent 会吃力
- 需要自己约定协议

## 9.2 `openclaw`

通信更偏 session event / delivery / announce：

- subagent completion announce
- sessions_send
- gateway routed messaging
- channel delivery target
- session lifecycle events

这里的通信不只是“给另一个 agent 发文本”，而是和：

- session
- route
- delivery target
- thread binding
- channel plugin

绑在一起。

所以它比 mailbox 更重，但也更接近真实产品。

---

## 10. 为什么 `openclaw` 看起来更“像平台”

因为它把下面这些都正式工程化了：

1. 入口统一
2. session key 统一
3. route 统一
4. workspace 统一
5. session store 统一
6. long-running lifecycle 统一
7. subagent registry 统一
8. heartbeat/cron/delivery 统一接入 agent runtime

而 `learn-claude-code` 明确不追求这些，它追求的是：

1. 每个机制单独可理解
2. 每个脚本单独可运行
3. 先把思想讲明白，再谈产品化

所以：

- `learn-claude-code` 是“教学解剖图”
- `openclaw` 是“带控制面的运行系统”

---

## 11. 对 `agent-alpha` 的具体启发

这里最值得借的，不是某个具体函数，而是两边各自最强的那部分。

## 11.1 从 `learn-claude-code` 借什么

### 借抽象顺序

很值得学它的演进顺序：

1. 子 agent 上下文隔离
2. 任务持久化
3. 团队与异步消息
4. 自主领取任务
5. task 与 worktree 解耦

这条顺序非常适合 `agent-alpha`。

因为你现在最需要的，不是一步到位做产品级 gateway，而是先把抽象顺序梳理清楚。

### 借“task 是控制平面，worktree 是执行平面”

这是这两个项目里我认为最值得直接借到 `agent-alpha` 的一句话。

因为它会直接防止很多设计混乱：

- task 不等于 workspace
- workspace 不等于 session
- session 也不等于 agent 身份

### 借最小通信模型

如果 `agent-alpha` 后面要做轻量多 agent，完全可以先学：

- 明确 mailbox 协议
- 明确 task board
- 明确 autonomous claim

不用一上来就进入 `openclaw` 那种重量级控制面。

## 11.2 从 `openclaw` 借什么

### 借 session-first 思维

`openclaw` 很强的一点是：

它不是先想“怎么开子 agent”，而是先想“这个运行单元在系统里是什么 session”。

这会直接带来：

- 生命周期清晰
- 可恢复
- 可查询
- 可治理

这对 `agent-alpha` 后面做多 agent 编排非常重要。

### 借 workspace 作为 agent 实例根

`openclaw` 的 workspace 不只是 cwd。

这和你想做的目标高度一致：

- 每个 agent 可输入工作路径
- 自动识别人格文档
- 便于多 agent 编排

所以 `agent-alpha` 更应该学 `openclaw` 的是：

- workspace 是实例根
- workspace 里能自动发现 bootstrap/persona/memory files
- 子 agent 自动继承或受控继承 workspace

### 借 registry + cleanup + recovery

如果 `agent-alpha` 将来真的要做多 agent，不管最终是不是 gateway 架构，都建议尽早建立：

- run registry
- completion record
- orphan recovery
- cleanup policy

否则前期看起来简单，后期会越来越乱。

## 11.3 不建议直接照搬 `openclaw` 的部分

如果现在就把 `openclaw` 整套控制面搬到 `agent-alpha`，风险很大：

- 复杂度会猛增
- 很多能力和你当前阶段不匹配
- 你会重新掉回 `skill-mcp-agent` 那种过重状态

所以更合理的路线是：

1. 用 `learn-claude-code` 梳理抽象层次
2. 用 `openclaw` 学状态治理和生命周期治理
3. 按 `agent-alpha` 的目标做轻量实现

---

## 12. 一个很重要的本质区别

这两个项目最大的区别，不是语言，不是文件结构，而是“默认假设”。

### `learn-claude-code` 的默认假设

- 一次任务，一次会话
- 本地目录就是主要世界
- 文件和线程足够支撑多 agent 协作
- 教学清晰比运行时完备更重要

### `openclaw` 的默认假设

- agent 会一直活着
- agent 会跨 channel、跨线程、跨任务工作
- agent 需要被路由
- agent 需要被恢复
- agent 需要被治理
- agent 需要在不同执行入口下共享同一套 session 语义

所以：

- `learn-claude-code` 是“如何搭出多 agent 机制”
- `openclaw` 是“如何让多 agent 机制在真实系统里长期活着”

---

## 13. 最终结论

如果你的目标是研究“多 agent 机制怎么设计”，先看 `learn-claude-code` 更容易抓住本质。  
如果你的目标是研究“多 agent 机制怎么真正落进长期运行产品”，`openclaw` 才是更接近终局的样子。

对 `agent-alpha` 来说，最合理的借鉴组合不是二选一，而是：

- 用 `learn-claude-code` 定义抽象顺序
- 用 `openclaw` 定义 runtime 边界

最建议优先吸收的 3 条是：

1. `task = control plane`
2. `workspace = agent instance root`
3. `subagent run = managed lifecycle object`

如果这 3 条在 `agent-alpha` 里先立住，后面不管你是做轻量多 agent，还是做更完整的 orchestrator，都不会太容易走偏。

---

## 14. 本次主要参考文件

### OpenClaw

- [build-program.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\program\build-program.ts)
- [register.agent.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\program\register.agent.ts)
- [run.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\gateway-cli\run.ts)
- [run-loop.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\cli\gateway-cli\run-loop.ts)
- [workspace.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\workspace.ts)
- [resolve-route.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\routing\resolve-route.ts)
- [sessions-spawn-tool.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\tools\sessions-spawn-tool.ts)
- [subagent-spawn.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\subagent-spawn.ts)
- [subagent-registry.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\agents\subagent-registry.ts)
- [action-spawn.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\auto-reply\reply\commands-subagents\action-spawn.ts)
- [heartbeat-runner.ts](D:\files\demo\0312-newagent\learning proj\openclaw\src\infra\heartbeat-runner.ts)
- [cron isolated run](D:\files\demo\0312-newagent\learning proj\openclaw\src\cron\isolated-agent\run.ts)

### learn-claude-code

- [README.md](D:\files\demo\0312-newagent\learning proj\learn-claude-code\README.md)
- [s04_subagent.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s04_subagent.py)
- [s07_task_system.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s07_task_system.py)
- [s09_agent_teams.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s09_agent_teams.py)
- [s11_autonomous_agents.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s11_autonomous_agents.py)
- [s12_worktree_task_isolation.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s12_worktree_task_isolation.py)
- [s_full.py](D:\files\demo\0312-newagent\learning proj\learn-claude-code\agents\s_full.py)

