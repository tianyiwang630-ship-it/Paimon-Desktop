"""Grep Tool - search by ripgrep."""

import subprocess
from pathlib import Path
from typing import Dict, Any

from agent.tools.base_tool import BaseTool
from agent.core.sandbox import SandboxViolation, resolve_directory_for_tool


class GrepTool(BaseTool):
    @property
    def name(self) -> str:
        return "grep"

    def __init__(self):
        self.rg_available = self._check_ripgrep()

    def _check_ripgrep(self) -> bool:
        try:
            result = subprocess.run(["rg", "--version"], capture_output=True, timeout=5)
            return result.returncode == 0
        except Exception:
            return False

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search text using ripgrep.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Search regex/pattern"},
                        "path": {"type": "string", "description": "Search root directory"},
                        "glob": {"type": "string", "description": "File filter, e.g. *.py"},
                        "output_mode": {
                            "type": "string",
                            "enum": ["content", "files_with_matches", "count"],
                            "default": "files_with_matches",
                        },
                        "case_insensitive": {"type": "boolean", "default": False},
                        "show_line_numbers": {"type": "boolean", "default": True},
                        "context_after": {"type": "integer"},
                        "context_before": {"type": "integer"},
                        "context": {"type": "integer"},
                    },
                    "required": ["pattern"],
                },
            },
        }

    def execute(self, **kwargs) -> str:
        pattern = kwargs.get("pattern", "")
        path = kwargs.get("path")
        glob = kwargs.get("glob")
        output_mode = kwargs.get("output_mode", "files_with_matches")
        case_insensitive = kwargs.get("case_insensitive", False)
        show_line_numbers = kwargs.get("show_line_numbers", True)
        context_after = kwargs.get("context_after")
        context_before = kwargs.get("context_before")
        context = kwargs.get("context")

        if not self.rg_available:
            return "Error: ripgrep (rg) is not installed or not available in PATH."

        try:
            search_root: Path | None = None
            if path:
                search_root = resolve_directory_for_tool(self, raw_path=path, for_write=False, must_exist=True)
            elif getattr(self, "sandbox_root", None):
                search_root = resolve_directory_for_tool(self, raw_path=None, for_write=False, must_exist=True)

            cmd = ["rg"]
            if output_mode == "files_with_matches":
                cmd.append("-l")
            elif output_mode == "count":
                cmd.append("-c")

            if case_insensitive:
                cmd.append("-i")

            if output_mode == "content" and show_line_numbers:
                cmd.append("-n")

            if context is not None and output_mode == "content":
                cmd.extend(["-C", str(context)])
            else:
                if context_after is not None and output_mode == "content":
                    cmd.extend(["-A", str(context_after)])
                if context_before is not None and output_mode == "content":
                    cmd.extend(["-B", str(context_before)])

            if glob:
                cmd.extend(["-g", glob])

            cmd.append(pattern)
            if search_root is not None:
                cmd.append(str(search_root))

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

            if result.returncode == 0:
                output = result.stdout.strip()
                header = f"# Search pattern: '{pattern}'"
                if search_root is not None:
                    header += f" in '{search_root}'"
                if glob:
                    header += f" (filter: {glob})"
                header += f"\n# Mode: {output_mode}\n"
                return header + output

            if result.returncode == 1:
                msg = f"No matches found for pattern: '{pattern}'"
                if search_root is not None:
                    msg += f" in '{search_root}'"
                if glob:
                    msg += f" (filter: {glob})"
                return msg

            return f"Error: ripgrep failed with code {result.returncode}\n{result.stderr.strip()}"

        except SandboxViolation as e:
            return f"Error: {str(e)}"
        except subprocess.TimeoutExpired:
            return "Error: Search timed out (>30 seconds)"
        except Exception as e:
            return f"Error: {str(e)}"


if __name__ == "__main__":
    tool = GrepTool()
    print(tool.execute(pattern="def ", path="agent", glob="*.py"))