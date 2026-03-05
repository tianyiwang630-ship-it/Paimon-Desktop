"""Append Tool - append content to file."""

from pathlib import Path
from typing import Dict, Any

from agent.tools.base_tool import BaseTool
from agent.core.sandbox import SandboxViolation, resolve_path_for_tool


class AppendTool(BaseTool):
    @property
    def name(self) -> str:
        return "append"

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "append",
                "description": "Append content to an existing file or create a new one.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the target file"
                        },
                        "content": {
                            "type": "string",
                            "description": "Content to append"
                        }
                    },
                    "required": ["file_path", "content"]
                }
            }
        }

    def execute(self, **kwargs) -> Dict[str, Any]:
        file_path = kwargs.get("file_path")
        content = kwargs.get("content", "")

        try:
            path = resolve_path_for_tool(
                self,
                raw_path=file_path,
                for_write=True,
                must_exist=False,
                allow_directory=False,
            )

            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(content)

            file_size = path.stat().st_size
            lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)

            return {
                "success": True,
                "message": f"Content appended to: {file_path}",
                "details": {
                    "file_path": str(path),
                    "appended_bytes": len(content.encode("utf-8")),
                    "total_size_bytes": file_size,
                    "appended_lines": lines,
                },
            }

        except SandboxViolation as e:
            return {"success": False, "error": f"Sandbox violation: {str(e)}"}
        except PermissionError:
            return {"success": False, "error": f"Permission denied: {file_path}"}
        except OSError as e:
            return {"success": False, "error": f"OS error: {str(e)}"}
        except Exception as e:
            return {"success": False, "error": f"Unexpected error: {str(e)}"}


if __name__ == "__main__":
    tool = AppendTool()
    print(tool.execute(file_path="workspace/temp/test_append.txt", content="hello\n"))