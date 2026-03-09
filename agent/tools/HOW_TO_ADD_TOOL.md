# 如何添加新工具

## 只需两步

### 第一步：创建工具类

在 `agent/tools/` 下新建 `xxx_tool.py`，继承 `BaseTool`：

```python
from typing import Dict, Any
from agent.tools.base_tool import BaseTool


class XxxTool(BaseTool):
    """工具描述"""

    @property
    def name(self) -> str:
        return "xxx"  # 工具名，必须与 tool_definition 中的 name 一致

    def get_tool_definition(self) -> Dict[str, Any]:
        """返回 OpenAI function calling 格式的工具定义"""
        return {
            "type": "function",
            "function": {
                "name": "xxx",
                "description": "工具功能描述（LLM 根据此描述决定是否调用）",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "param1": {
                            "type": "string",
                            "description": "参数1说明"
                        },
                        "param2": {
                            "type": "integer",
                            "description": "参数2说明（可选）",
                            "default": 10
                        }
                    },
                    "required": ["param1"]
                }
            }
        }

    def execute(self, **kwargs) -> Any:
        """执行工具"""
        param1 = kwargs.get('param1')
        param2 = kwargs.get('param2', 10)

        # 工具逻辑...

        return {"success": True, "result": "..."}
```

### 第二步：注册到 ToolLoader

在 `agent/core/tool_loader.py` 的 `BUILTIN_TOOLS` 列表中加一行：

```python
BUILTIN_TOOLS = [
    ("agent.tools.bash_tool", "BashTool", {"timeout": 300}),
    ("agent.tools.read_tool", "ReadTool", {}),
    # ...
    ("agent.tools.xxx_tool", "XxxTool", {}),  # <-- 加这一行
]
```

第三个参数是传给 `__init__` 的关键字参数，没有构造参数就传 `{}`。

完成。系统会自动加载工具、注册执行器、处理权限检查。

---

## 接口规范

| 方法 | 说明 |
|------|------|
| `name` (property) | 工具唯一标识，与 `tool_definition` 中的 `name` 字段保持一致 |
| `get_tool_definition()` | 返回 OpenAI function calling 格式的 JSON Schema |
| `execute(**kwargs)` | 接收 LLM 传来的参数（dict 解包），返回结果 |

## 注意事项

- `execute` 的参数名必须与 `get_tool_definition` 中 `properties` 的 key 一致
- 可选参数用 `kwargs.get('key', default)` 提取
- 如果工具需要构造参数（如 BashTool 的 timeout），在 `__init__` 中定义，注册时通过第三个参数传入
- 权限控制由 `ToolLoader` 统一处理，工具类本身不需要关心
