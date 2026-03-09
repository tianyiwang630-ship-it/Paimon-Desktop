"""Glob Tool - find files by glob pattern."""

from pathlib import Path
from typing import Dict, Any

from agent.tools.base_tool import BaseTool
from agent.core.sandbox import SandboxViolation, resolve_directory_for_tool


class GlobTool(BaseTool):
    @property
    def name(self) -> str:
        return "glob"

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files using glob patterns like **/*.py or src/**/*.ts",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "Glob pattern"
                        },
                        "path": {
                            "type": "string",
                            "description": "Search root directory (optional)"
                        }
                    },
                    "required": ["pattern"]
                }
            }
        }

    def execute(self, **kwargs) -> str:
        pattern = kwargs.get("pattern", "")
        path = kwargs.get("path")

        try:
            root = resolve_directory_for_tool(
                self,
                raw_path=path,
                for_write=False,
                must_exist=True,
            )

            if pattern.startswith("**/"):
                matches = list(root.rglob(pattern[3:]))
            elif "**" in pattern:
                matches = list(root.glob(pattern))
            else:
                matches = list(root.glob(pattern))

            file_matches = [m for m in matches if m.is_file()]
            file_matches.sort(key=lambda x: x.stat().st_mtime, reverse=True)

            if not file_matches:
                return f"No files found matching pattern: {pattern}" + (f" in {path}" if path else "")

            result_lines = []
            for file_path in file_matches:
                try:
                    relative_path = file_path.relative_to(root)
                    result_lines.append(str(relative_path).replace("\\", "/"))
                except ValueError:
                    result_lines.append(str(file_path).replace("\\", "/"))

            header = f"# Found {len(result_lines)} file(s) matching '{pattern}'"
            if path:
                header += f" in '{path}'"
            header += "\n# Sorted by modification time (newest first)\n"
            return header + "\n".join(result_lines)

        except SandboxViolation as e:
            return f"Error: {str(e)}"
        except Exception as e:
            return f"Error: {str(e)}"


if __name__ == "__main__":
    tool = GlobTool()
    print(tool.execute(pattern="**/*.py"))