"""Read Tool - read text files with line numbers."""

from pathlib import Path
from typing import Dict, Any

from agent.tools.base_tool import BaseTool
from agent.core.sandbox import SandboxViolation, resolve_path_for_tool


class ReadTool(BaseTool):
    """Read file content similar to `cat -n`."""

    @property
    def name(self) -> str:
        return "read"

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a file with line numbers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the file to read"
                        },
                        "offset": {
                            "type": "integer",
                            "description": "Start line offset (0-based)",
                            "default": 0
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum lines to read",
                            "default": 2000
                        }
                    },
                    "required": ["file_path"]
                }
            }
        }

    def execute(self, **kwargs) -> str:
        file_path = kwargs.get("file_path")
        offset = kwargs.get("offset", 0) or 0
        limit = kwargs.get("limit", 2000) or 2000

        try:
            path = resolve_path_for_tool(
                self,
                raw_path=file_path,
                for_write=False,
                must_exist=True,
                allow_directory=False,
            )

            try:
                content = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                try:
                    content = path.read_text(encoding="gbk")
                except Exception:
                    return f"Error: file cannot be decoded as utf-8 or gbk: {file_path}"
            except PermissionError:
                return f"Error: permission denied: {file_path}"

            if not content:
                return f"File is empty: {file_path}"

            lines = content.splitlines()
            total_lines = len(lines)
            start = offset
            end = min(offset + limit, total_lines)

            if start >= total_lines:
                return f"Offset {start} exceeds total line count {total_lines}"

            selected_lines = lines[start:end]
            max_line_num = start + len(selected_lines)
            num_width = len(str(max_line_num))

            result_lines = []
            for i, line in enumerate(selected_lines, start=start + 1):
                if len(line) > 2000:
                    line = line[:2000] + "... (line truncated)"
                line_num_str = str(i).rjust(num_width)
                result_lines.append(f"{line_num_str}{line}")

            header = f"# File: {path}\n# Lines: {start + 1}-{end} / {total_lines}\n"
            footer = ""
            if end < total_lines:
                footer = f"\n\n... {total_lines - end} more lines. Use offset={end}"

            return header + "\n".join(result_lines) + footer

        except SandboxViolation as e:
            return f"Error: {str(e)}"
        except Exception as e:
            return f"Error: {str(e)}"


if __name__ == "__main__":
    tool = ReadTool()
    print(tool.execute(file_path=__file__, offset=0, limit=20))