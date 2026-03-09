"""Bash tool implementation."""

from __future__ import annotations

import platform
import subprocess
from pathlib import Path
from typing import Any, Dict

from agent.core.paths import get_runtime_root
from agent.core.sandbox import build_sandbox_env
from agent.tools.base_tool import BaseTool


class BashTool(BaseTool):
    @property
    def name(self) -> str:
        return "bash"

    def __init__(self, timeout: int = 300):
        self.timeout = timeout
        self.default_cwd = get_runtime_root()
        self._detect_shell()

    def _detect_shell(self) -> None:
        system = platform.system()

        if system == "Windows":
            git_bash_paths = [
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\Program Files (x86)\Git\bin\bash.exe",
                "bash",
            ]

            for bash_path in git_bash_paths:
                try:
                    result = subprocess.run(
                        [bash_path, "-c", "echo test"],
                        capture_output=True,
                        timeout=5,
                    )
                    if result.returncode == 0:
                        self.shell = bash_path
                        shell_name = "Git Bash" if "Program Files" in bash_path else "bash"
                        print(f"Detected shell: {shell_name}")
                        return
                except Exception:
                    continue

            try:
                result = subprocess.run(
                    ["wsl", "bash", "-c", "echo test"],
                    capture_output=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    self.shell = "wsl"
                    print("Detected shell: WSL")
                    return
            except Exception:
                pass

            self.shell = "cmd"
            print("No bash/WSL detected, fallback shell: cmd")
            return

        self.shell = "bash"
        print("Detected shell: bash")

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute shell command.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Shell command string",
                        }
                    },
                    "required": ["command"],
                },
            },
        }

    def execute(self, **kwargs) -> Dict[str, Any]:
        command = kwargs.get("command", "")

        try:
            if self.shell == "cmd":
                cmd_args = ["cmd", "/c", command]
            elif self.shell == "wsl":
                cmd_args = ["wsl", "bash", "-c", command]
            elif self.shell.endswith(".exe") or "\\" in self.shell:
                cmd_args = [self.shell, "-c", command]
            else:
                cmd_args = ["bash", "-c", command]

            cwd = getattr(self, "sandbox_root", None) or self.default_cwd
            cwd_path = Path(cwd).expanduser().resolve()
            cwd_path.mkdir(parents=True, exist_ok=True)

            result = subprocess.run(
                cmd_args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout,
                cwd=str(cwd_path),
                env=build_sandbox_env(),
            )

            max_output_length = 50000
            stdout = result.stdout
            stderr = result.stderr

            if stdout and len(stdout) > max_output_length:
                stdout = stdout[:max_output_length] + f"\n... (truncated, original {len(result.stdout)} chars)"

            if stderr and len(stderr) > max_output_length:
                stderr = stderr[:max_output_length] + f"\n... (truncated, original {len(result.stderr)} chars)"

            return {
                "success": result.returncode == 0,
                "stdout": stdout,
                "stderr": stderr,
                "returncode": result.returncode,
                "command": command,
            }

        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": f"Command timed out after {self.timeout} seconds",
                "command": command,
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "command": command,
            }
