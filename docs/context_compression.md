# 上下文压缩功能说明

## 📋 功能概述

Agent 现在支持自动上下文压缩，当对话历史超过 token 限制时，会自动将旧的对话压缩成结构化摘要，保留最近的对话，确保能够持续进行长时间对话。

## 🎯 核心特性

1. **自动检测**: 每次对话开始时自动检查 token 使用量
2. **智能压缩**: 压缩旧对话，保留最近 10 轮完整对话
3. **结构化摘要**: 使用 6 字段 JSON 结构，确保关键信息不丢失
4. **无缝恢复**: 压缩后可以无缝继续对话

## 📊 配置参数

在 `Agent.__init__()` 中可以配置以下参数：

```python
self.max_context_tokens = 70000      # 总上下文限制（tokens）
self.keep_recent_turns = 10          # 保留最近 N 轮对话
```

### Token 预算分配

```
总上下文 (70k) = System Prompt + Tools + History
                    ↓             ↓        ↓
                 ~500 tokens  ~10k tokens  动态
```

**实际可用于 History 的 Token:**
```
available_for_history = 70000 - system_tokens - tools_tokens
```

## 🔄 压缩流程

### 1. 检测阶段
每次 `run()` 开始时：
```python
if self._should_compress():
    self._compress_history()
```

### 2. 压缩逻辑
```
History: [消息1, 消息2, ..., 消息50]
         ↓
分离: [旧消息: 1-40] + [最近: 41-50]
         ↓
调用 LLM 生成摘要 (JSON)
         ↓
JSON → Markdown 格式
         ↓
重组: [摘要消息] + [最近: 41-50]
```

### 3. 摘要结构（6 个字段）

#### ① task_timeline（任务时间线）
按因果关系记录关键步骤：
```json
{
  "step": 1,
  "user_request": "用户请求",
  "action": "执行的操作",
  "result": "成功/失败",
  "key_output": "关键输出",
  "note": "备注"
}
```

#### ② skill_deltas（关键工具调用）
只保留有影响的工具调用：
- ✅ 保留: write, edit, bash(非查询), 创建/修改/删除
- ❌ 废弃: ls, pwd, cat, read, git status

```json
{
  "tool": "write",
  "action": "创建 main.py",
  "impact": "项目入口文件",
  "timestamp_relative": "第 3 轮"
}
```

#### ③ important_files（重要文件清单）
```json
{
  "path": "/完整/路径/file.py",
  "tool": "write",
  "created_by": "对应步骤",
  "status": "created/modified/deleted"
}
```

#### ④ current_state（当前状态）
```json
{
  "just_finished": "刚完成什么",
  "interrupted_at": "被打断在做什么",
  "next_step": "下一步做什么",
  "waiting_for": "等待用户什么"
}
```

#### ⑤ error_memory（错误记忆）
记录失败-纠正-成功链路：
```json
{
  "error": "错误信息",
  "context": "导致错误的操作",
  "correction": "如何纠正",
  "success": "纠正后结果",
  "lesson": "教训（具体规则）"
}
```

#### ⑥ critical_user_intents（关键用户意图）
只保留需求转折点：
```json
{
  "turn": 3,
  "intent": "核心意图",
  "reason": "为什么重要"
}
```

## 📝 Markdown 格式示例

压缩后的摘要会转换为 Markdown 格式，作为 `user` 消息插入 history：

```markdown
# 📋 历史对话摘要

## 🎯 任务时间线
1. **用户请求**：创建 Python 项目
   **操作**：创建目录结构
   **结果**：成功
   **输出**：`/home/user/my_project/`

## 🔧 关键工具调用
- `write` → 创建 main.py → 项目入口文件

## 📁 重要文件
- `/home/user/my_project/main.py` (created)

## 📍 当前状态
- ✅ 刚完成：创建项目结构
- 📋 下一步：添加依赖配置

## ⚠️ 错误记忆
- **错误**：ImportError: No module named 'xxx'
  **纠正**：安装了缺失的包
  **教训**：检查依赖是否安装

## 💡 关键用户意图
- (轮1) 创建可维护的项目结构
```

## 🧪 测试

运行测试脚本：
```bash
python test_context_compression.py
```

测试内容：
1. Token 计数功能
2. JSON 转 Markdown
3. 压缩阈值检查
4. 配置信息展示

## 📈 性能指标

**压缩率**: 通常可以达到 **90%+** 的压缩率

示例：
- 压缩前: 50 条消息, 65,000 tokens
- 压缩后: 1 条摘要, 3,000 tokens
- 压缩率: 95.4%

## ⚙️ 技术细节

### Token 计算
使用 `tiktoken` 库的 `cl100k_base` 编码：
```python
import tiktoken
encoding = tiktoken.get_encoding("cl100k_base")
tokens = len(encoding.encode(text))
```

### 只计算以下内容的 Token
- `user` 消息的 `content`
- `assistant` 消息的 `content` 和 `tool_calls`
- `tool` 消息的 `content`

### 不计算
- `system` 消息（单独计算固定成本）
- `tools` 定义（单独计算固定成本）

## 🔍 日志输出

### 启动时
```
📊 上下文配置:
   - 总限制: 70,000 tokens
   - System: 450 tokens
   - Tools: 12,350 tokens
   - History 可用: 57,200 tokens
```

### 触发压缩时
```
⚠️  上下文即将超限: 58,500 / 57,200 tokens

🗜️  开始压缩对话历史...
   - 压缩前: 45 条消息, 55,000 tokens
   - 正在生成摘要...
   - 压缩后: 1 条摘要, 3,200 tokens
   - 压缩率: 94.2%
✅ 压缩完成，保留最近 10 轮
```

## 🎛️ 自定义配置

如果需要调整配置，修改 `Agent.__init__()`:

```python
# 更激进的压缩策略
self.max_context_tokens = 50000      # 降低总限制
self.keep_recent_turns = 5           # 只保留 5 轮

# 更宽松的压缩策略
self.max_context_tokens = 100000     # 提高总限制
self.keep_recent_turns = 20          # 保留 20 轮
```

## ⚠️ 注意事项

1. **首次压缩**: 需要调用 LLM，会消耗额外的 API 调用
2. **保留轮次**: `keep_recent_turns` 不宜太小（建议 ≥ 5），否则上下文连续性差
3. **依赖 tiktoken**: 需要安装 `pip install tiktoken`
4. **LLM 质量**: 摘要质量取决于 LLM 的理解能力

## 🚀 未来优化方向

- [ ] 支持多级压缩（摘要的摘要）
- [ ] 支持自定义摘要模板
- [ ] 支持压缩历史持久化
- [ ] 支持压缩失败时的降级策略
