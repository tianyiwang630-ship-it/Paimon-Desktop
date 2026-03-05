"""Write Tool - atomically write content to file."""

import os
import tempfile
from pathlib import Path
from typing import Dict, Any

from agent.tools.base_tool import BaseTool
from agent.core.sandbox import SandboxViolation, resolve_path_for_tool


class WriteTool(BaseTool):
    @property
    def name(self) -> str:
        return "write"

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "write",
                "description": "Write content to a file (overwrite if exists).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the target file"
                        },
                        "content": {
                            "type": "string",
                            "description": "Full content to write"
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

            temp_fd, temp_path = tempfile.mkstemp(
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
            )

            try:
                with os.fdopen(temp_fd, "w", encoding="utf-8") as f:
                    f.write(content)

                Path(temp_path).replace(path)

                file_size = path.stat().st_size
                lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)

                return {
                    "success": True,
                    "message": f"File written: {file_path}",
                    "details": {
                        "file_path": str(path),
                        "size_bytes": file_size,
                        "lines": lines,
                    },
                }

            except Exception as e:
                try:
                    Path(temp_path).unlink()
                except Exception:
                    pass
                raise e

        except SandboxViolation as e:
            return {"success": False, "error": f"Sandbox violation: {str(e)}"}
        except PermissionError:
            return {"success": False, "error": f"Permission denied: {file_path}"}
        except OSError as e:
            return {"success": False, "error": f"OS error: {str(e)}"}
        except Exception as e:
            return {"success": False, "error": f"Unexpected error: {str(e)}"}


if __name__ == "__main__":
    tool = WriteTool()
    print(tool.execute(file_path="workspace/temp/test_write.txt", content="hello\n"))