"""Permission manager with workspace-aware safety rules."""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
from pathlib import Path
from typing import Any, Dict, Literal, Set, Union

from agent.core.paths import (
    get_asset_root,
    get_runtime_root,
    get_skills_root,
    get_playwright_browsers_root,
    get_node_root,
    get_python_root,
)

Decision = Literal["allow", "deny", "ask"]

_TERMINAL_TOOL_TOKENS = (
    "bash",
    "shell",
    "powershell",
    "pwsh",
    "cmd",
    "terminal",
    "exec",
    "execute",
    "run",
    "python",
    "node",
    "script",
    "cli",
    "command",
)

_TERMINAL_ARG_KEYS = {
    "command",
    "commands",
    "cmd",
    "script",
    "shell",
    "powershell",
    "command_line",
    "shell_command",
    "program",
    "cli",
    "bash_command",
    "terminal_command",
    "args",
    "argv",
}

_PATH_HINT_KEYS = (
    "path",
    "file",
    "dir",
    "folder",
    "target",
    "source",
    "destination",
    "output",
    "input",
    "workspace",
    "root",
    "cwd",
)

_DELETE_ARG_KEYS = {"action", "operation", "op", "method"}
_DELETE_KEYWORDS = (
    "delete",
    "remove",
    "unlink",
    "rmdir",
    "erase",
    "trash",
    "clean",
)

_WRITE_TOOL_NAMES = {"write", "append", "edit"}

_CRITICAL_COMMAND_PATTERNS = [
    re.compile(r"\bmkfs\S*\b", re.IGNORECASE),
    re.compile(r"\bmkswap\b", re.IGNORECASE),
    re.compile(r"\bfdisk\b", re.IGNORECASE),
    re.compile(r"\bsfdisk\b", re.IGNORECASE),
    re.compile(r"\bparted\b", re.IGNORECASE),
    re.compile(r"\bformat\b", re.IGNORECASE),
    re.compile(r"\bdiskpart\b[\s\S]*\bclean\b", re.IGNORECASE),
    re.compile(r"\bdd\b[^\n]*\bof=/dev/(?:sd|nvme)", re.IGNORECASE),
    re.compile(r"\bvssadmin\b[^\n]*\bdelete\b[^\n]*\bshadows\b", re.IGNORECASE),
    re.compile(r"\bwbadmin\b[^\n]*\bdelete\b", re.IGNORECASE),
    re.compile(r"\bcipher\b[^\n]*/w\b", re.IGNORECASE),
    re.compile(r"\bbcdedit\b", re.IGNORECASE),
    re.compile(r"\breg\s+delete\b", re.IGNORECASE),
]

_DELETE_COMMAND_PATTERNS = [
    re.compile(r"\brm\b", re.IGNORECASE),
    re.compile(r"\brmdir\b", re.IGNORECASE),
    re.compile(r"\bunlink\b", re.IGNORECASE),
    re.compile(r"\bfind\b[^\n]*\s-delete\b", re.IGNORECASE),
    re.compile(r"\bdel\b", re.IGNORECASE),
    re.compile(r"\berase\b", re.IGNORECASE),
    re.compile(r"\brd\b", re.IGNORECASE),
    re.compile(r"\bremove-item\b", re.IGNORECASE),
    re.compile(r"\bclear-item\b", re.IGNORECASE),
    re.compile(r"\bgit\s+rm\b", re.IGNORECASE),
    re.compile(r"\bgit\s+clean\b", re.IGNORECASE),
    re.compile(r"\bos\.remove\b", re.IGNORECASE),
    re.compile(r"\bos\.unlink\b", re.IGNORECASE),
    re.compile(r"\bshutil\.rmtree\b", re.IGNORECASE),
    re.compile(r"\bpathlib\.[A-Za-z0-9_]*\.unlink\b", re.IGNORECASE),
    re.compile(r"\bfs\.rm(?:Sync)?\b", re.IGNORECASE),
    re.compile(r"\bSystem\.IO\.[A-Za-z0-9_]*::Delete\b", re.IGNORECASE),
]

_WRITE_COMMAND_PATTERNS = [
    re.compile(r">|>>"),
    re.compile(r"\btee\b", re.IGNORECASE),
    re.compile(r"\bset-content\b", re.IGNORECASE),
    re.compile(r"\badd-content\b", re.IGNORECASE),
    re.compile(r"\bout-file\b", re.IGNORECASE),
    re.compile(r"\bnew-item\b", re.IGNORECASE),
    re.compile(r"\bcopy\b", re.IGNORECASE),
    re.compile(r"\bmove\b", re.IGNORECASE),
    re.compile(r"\bcp\b", re.IGNORECASE),
    re.compile(r"\bmv\b", re.IGNORECASE),
    re.compile(r"\bmkdir\b", re.IGNORECASE),
    re.compile(r"\btouch\b", re.IGNORECASE),
    re.compile(r"\bnpm\s+install\b", re.IGNORECASE),
    re.compile(r"\bpip\s+install\b", re.IGNORECASE),
]

_UNRESOLVED_PATTERNS = [
    re.compile(r"\$\("),
    re.compile(r"`"),
    re.compile(r"%[^%]+%"),
    re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*"),
]

_REDIRECT_PATTERN = re.compile(r"(?:>|>>|2>|2>>|1>|1>>)\s*([^\s|;&]+)")
_POWERSHELL_PATH_ARG_PATTERN = re.compile(
    r"-(?:Path|LiteralPath|Destination|OutFile|Include|Exclude)\s+([^\s|;&]+)",
    re.IGNORECASE,
)


class PermissionManager:
    """Evaluate tool permissions with workspace safety constraints."""

    def __init__(self, config_path: Path | None = None):
        if config_path is None:
            config_path = Path(__file__).parent / "permissions.json"

        self.config_path = config_path
        self.config = self._load_config()
        self.mode = self.config.get("mode", "default")

        self.workspace_root = get_runtime_root().resolve()
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.skills_root = get_skills_root().resolve()
        self.playwright_browsers_root = get_playwright_browsers_root().resolve()
        self.node_root = get_node_root().resolve()
        self.python_root = get_python_root().resolve()
        self.allowed_write_roots = self._get_allowed_write_roots()
        self.sensitive_write_roots = self._get_sensitive_write_roots()

        self.mcp_registry = self._load_mcp_registry()

        self.session_allowed: Set[str] = set()
        self.session_denied: Set[str] = set()
        self.session_allowed_tools: Set[str] = set()
        self.pending_allow_once: Set[str] = set()

        self._last_decision: Dict[str, Any] = {
            "decision": "allow",
            "reason": "initialized",
            "tool": "",
            "args": {},
        }

    def _load_config(self) -> Dict[str, Any]:
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Failed to load permission config: {e}")
            return {
                "mode": "default",
                "permissions": {
                    "deny": [],
                    "allow": [],
                    "ask": [],
                },
            }

    def _load_mcp_registry(self) -> Dict[str, Dict[str, Any]]:
        try:
            registry_path = get_asset_root() / "mcp-servers" / "registry.json"
            if registry_path.exists():
                with open(registry_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return {k: v for k, v in data.items() if not k.startswith("_")}
            return {}
        except Exception as e:
            print(f"Failed to load MCP registry: {e}")
            return {}

    def get_last_decision(self) -> Dict[str, Any]:
        return dict(self._last_decision)

    def _record_decision(
        self,
        decision: Decision,
        tool: str,
        args: Dict[str, Any],
        reason: str,
        **extra: Any,
    ) -> Decision:
        payload: Dict[str, Any] = {
            "decision": decision,
            "tool": tool,
            "args": args,
            "reason": reason,
        }
        payload.update(extra)
        self._last_decision = payload
        return decision

    def check_permission(
        self,
        tool: str,
        args: Dict[str, Any],
        mode: str | None = None,
    ) -> Decision:
        tool = self._normalize_tool_name(tool)
        args = args or {}

        if mode is None:
            mode = self.mode

        signature = self._get_signature(tool, args)
        is_delete = self._is_delete_operation(tool, args)
        is_write = self._is_write_operation(tool, args)
        sensitive_info = self._find_sensitive_write_target(tool, args) if (is_write or is_delete) else None

        if signature in self.pending_allow_once:
            self.pending_allow_once.discard(signature)
            return self._record_decision("allow", tool, args, "allowed once by user")

        if signature in self.session_denied:
            # Delete operations are always confirmation-based in web UI.
            # A previous deny should not permanently suppress ask prompts.
            if is_delete or sensitive_info is not None:
                self.session_denied.discard(signature)
            else:
                return self._record_decision("deny", tool, args, "denied in current session")

        if not is_delete and sensitive_info is None:
            if tool in self.session_allowed_tools:
                return self._record_decision("allow", tool, args, "allowed for this session (tool)")
            if signature in self.session_allowed:
                return self._record_decision("allow", tool, args, "allowed for this session (signature)")

        critical = self._contains_critical_command(tool, args)
        if critical:
            return self._record_decision(
                "deny",
                tool,
                args,
                "critical destructive command is blocked",
                blocked_command=critical,
            )

        if is_write or is_delete:
            outside_info = self._find_outside_workspace_target(tool, args)
            if outside_info is not None:
                return self._record_decision(
                    "deny",
                    tool,
                    args,
                    "write/delete target is outside writable roots",
                    blocked_path=outside_info.get("path"),
                    blocked_command=outside_info.get("command"),
                    detail=outside_info.get("detail"),
                )

            if sensitive_info is not None:
                return self._record_decision(
                    "ask",
                    tool,
                    args,
                    "write/delete in sensitive runtime root requires per-command confirmation",
                    blocked_path=sensitive_info.get("path"),
                    detail=sensitive_info.get("detail"),
                    sensitive_root=sensitive_info.get("root"),
                )

            if is_delete:
                return self._record_decision("ask", tool, args, "delete operation requires confirmation")

            return self._record_decision("allow", tool, args, "write operation inside writable roots")

        permissions = self.config.get("permissions", {})
        for pattern in permissions.get("deny", []):
            if self._match_rule(pattern, tool, args):
                return self._record_decision("deny", tool, args, f"matched deny rule: {pattern}")

        if mode == "auto":
            return self._record_decision("allow", tool, args, "auto mode default")

        for pattern in permissions.get("allow", []):
            if self._match_rule(pattern, tool, args):
                return self._record_decision("allow", tool, args, f"matched allow rule: {pattern}")

        for pattern in permissions.get("ask", []):
            if self._match_rule(pattern, tool, args):
                return self._record_decision("ask", tool, args, f"matched ask rule: {pattern}")

        return self._record_decision(
            self._get_default_permission(tool, mode),
            tool,
            args,
            f"default mode decision: {mode}",
        )

    def _get_signature(self, tool: str, args: Dict[str, Any]) -> str:
        tool = self._normalize_tool_name(tool)

        if tool == "bash":
            return f"bash:{args.get('command', '')}"
        if tool in ["read", "write", "edit", "append"]:
            return f"{tool}:{args.get('file_path', '')}"
        if tool in ["glob", "grep"]:
            return f"{tool}:{args.get('pattern', '')}"
        if tool == "tool_search":
            return tool
        if tool.startswith("skill__") or tool.startswith("skill_"):
            return tool
        if tool.startswith("mcp__"):
            parts = tool.split("__")
            if len(parts) >= 2:
                server_name = parts[1]
                category = self.mcp_registry.get(server_name, {}).get("category", "searchable")
                if category == "core":
                    return f"mcp__{server_name}"
                return tool
            return tool
        if tool == "fetch":
            return tool

        return f"{tool}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"

    def _normalize_tool_name(self, tool: str) -> str:
        normalized = (tool or "").strip()
        if normalized.startswith("skill"):
            normalized = re.sub(r"_+", "_", normalized)
        return normalized

    def allow_tool_for_session(self, tool: str) -> str:
        normalized = self._normalize_tool_name(tool)
        if normalized:
            self.session_allowed_tools.add(normalized)
        return normalized

    def can_allow_session(self, tool: str, args: Dict[str, Any]) -> bool:
        normalized = self._normalize_tool_name(tool)
        payload = args or {}
        if self._is_delete_operation(normalized, payload):
            return False
        if self._is_write_operation(normalized, payload):
            if self._find_sensitive_write_target(normalized, payload) is not None:
                return False
        return True

    def is_delete_request(self, tool: str, args: Dict[str, Any]) -> bool:
        return self._is_delete_operation(self._normalize_tool_name(tool), args or {})

    def _match_rule(self, pattern: str, tool: str, args: Dict[str, Any]) -> bool:
        if ":" not in pattern:
            return fnmatch.fnmatch(tool, pattern)

        rule_tool, rule_pattern = pattern.split(":", 1)
        if not fnmatch.fnmatch(tool, rule_tool):
            return False

        actual_value = self._get_value_for_tool(tool, args)
        return fnmatch.fnmatch(actual_value, rule_pattern)

    def _get_value_for_tool(self, tool: str, args: Dict[str, Any]) -> str:
        if tool == "bash":
            return str(args.get("command", ""))
        if tool in ["read", "write", "edit", "append"]:
            return str(args.get("file_path", ""))
        if tool in ["glob", "grep"]:
            return str(args.get("pattern", ""))
        if tool == "fetch":
            return str(args.get("url", ""))
        return json.dumps(args, sort_keys=True, ensure_ascii=False)

    def _get_default_permission(self, tool: str, mode: str) -> Decision:
        if mode == "ask":
            if (
                tool in ["read", "glob", "grep", "fetch", "tool_search"]
                or tool.startswith("skill__")
                or tool.startswith("skill_")
            ):
                return "allow"
            if tool in ["write", "edit", "append"]:
                return "ask"
            if tool == "bash":
                return "allow"
            return "ask"

        if mode == "auto":
            return "allow"

        if mode == "default":
            return self._get_default_permission(tool, "ask")
        if mode == "permissive":
            return self._get_default_permission(tool, "auto")

        return self._get_default_permission(tool, "ask")

    def ask_user(self, tool: str, args: Dict[str, Any]) -> Union[bool, Dict[str, str]]:
        is_delete = self._is_delete_operation(tool, args or {})
        risk_level = self._get_risk_level(tool, args or {})

        print("\n" + "-" * 70)
        print("Permission request")
        print("-" * 70)
        print(f"Tool: {tool}")
        if tool == "bash":
            print(f"Command: {args.get('command', '')}")
        elif tool in ["read", "write", "edit", "append"]:
            print(f"Path: {args.get('file_path', '')}")
        elif tool in ["glob", "grep"]:
            print(f"Pattern: {args.get('pattern', '')}")
        elif tool == "fetch":
            print(f"URL: {args.get('url', '')}")
        else:
            print(json.dumps(args, ensure_ascii=False, indent=2))

        print(f"Risk: {risk_level}")
        print("-" * 70)

        if is_delete:
            print("[A] Allow once")
            print("[N] Deny")
            print("[E] Retry with extra instruction")
        else:
            print("[A] Allow once")
            print("[Y] Allow this session")
            print("[N] Deny")
            print("[D] Deny this request signature")
            print("[E] Retry with extra instruction")
            print("[S] Switch to auto mode")

        while True:
            choice = input("Choice: ").strip().upper()

            if choice == "A":
                return True

            if choice == "N":
                return False

            if choice == "E":
                extra_instruction = input("Extra instruction: ").strip()
                if not extra_instruction:
                    print("Extra instruction cannot be empty.")
                    continue
                return {"retry_with_context": extra_instruction}

            if is_delete:
                print("Invalid choice. Use A/N/E.")
                continue

            if choice == "Y":
                self.allow_tool_for_session(tool)
                return True

            if choice == "D":
                signature = self._get_signature(tool, args or {})
                self.session_denied.add(signature)
                return False

            if choice == "S":
                self.mode = "auto"
                return True

            print("Invalid choice.")

    def _get_risk_level(self, tool: str, args: Dict[str, Any]) -> str:
        if self._is_delete_operation(tool, args):
            return "high"

        risk_levels = self.config.get("risk_levels", {})
        tool_risk = risk_levels.get(tool)
        if tool_risk and tool_risk != "auto":
            return str(tool_risk)

        if tool == "bash":
            command = str(args.get("command", ""))
            keywords = self.config.get("bash_risk_keywords", {})
            for keyword in keywords.get("high", []):
                if keyword in command:
                    return "high"
            for keyword in keywords.get("medium", []):
                if keyword in command:
                    return "medium"
            return "low"

        return "medium"

    def set_mode(self, mode: Literal["ask", "auto"]):
        if mode not in ["ask", "auto"]:
            raise ValueError(f"Invalid mode: {mode}. Must be 'ask' or 'auto'")
        self.mode = mode

    def clear_session_cache(self):
        self.session_allowed.clear()
        self.session_denied.clear()
        self.session_allowed_tools.clear()
        self.pending_allow_once.clear()

    def _get_allowed_write_roots(self) -> list[Path]:
        roots: list[Path] = []
        for root in (
            self.workspace_root,
            self.skills_root,
            self.playwright_browsers_root,
            self.node_root,
            self.python_root,
        ):
            if root not in roots:
                roots.append(root)
        return roots

    def _get_sensitive_write_roots(self) -> list[Path]:
        roots: list[Path] = []
        for root in (self.node_root, self.python_root):
            if root not in roots:
                roots.append(root)
        return roots

    def _is_terminal_operation(self, tool: str, args: Dict[str, Any]) -> bool:
        normalized = self._normalize_tool_name(tool).lower()
        if any(token in normalized for token in _TERMINAL_TOOL_TOKENS):
            return True

        for key in args.keys():
            if str(key).lower() in _TERMINAL_ARG_KEYS:
                return True

        return False

    def _extract_command_texts(self, args: Dict[str, Any]) -> list[str]:
        commands: list[str] = []

        def visit(key: str, value: Any) -> None:
            key_l = key.lower()
            if isinstance(value, str):
                if key_l in _TERMINAL_ARG_KEYS:
                    text = value.strip()
                    if text:
                        commands.append(text)
                return

            if isinstance(value, list):
                if key_l in _TERMINAL_ARG_KEYS:
                    text_parts = [str(item) for item in value]
                    text = " ".join(text_parts).strip()
                    if text:
                        commands.append(text)
                for item in value:
                    visit(key, item)
                return

            if isinstance(value, dict):
                for child_key, child_val in value.items():
                    visit(str(child_key), child_val)

        for k, v in args.items():
            visit(str(k), v)

        return commands

    def _contains_critical_command(self, tool: str, args: Dict[str, Any]) -> str | None:
        if not self._is_terminal_operation(tool, args):
            return None

        for command in self._extract_command_texts(args):
            for pattern in _CRITICAL_COMMAND_PATTERNS:
                if pattern.search(command):
                    return command

        return None

    def _contains_delete_command(self, text: str) -> bool:
        return any(pattern.search(text) for pattern in _DELETE_COMMAND_PATTERNS)

    def _contains_write_command(self, text: str) -> bool:
        return any(pattern.search(text) for pattern in _WRITE_COMMAND_PATTERNS)

    def _is_delete_operation(self, tool: str, args: Dict[str, Any]) -> bool:
        normalized = self._normalize_tool_name(tool).lower()

        if any(token in normalized for token in _DELETE_KEYWORDS):
            return True

        for key in _DELETE_ARG_KEYS:
            value = args.get(key)
            if isinstance(value, str) and any(word in value.lower() for word in _DELETE_KEYWORDS):
                return True

        if not self._is_terminal_operation(normalized, args):
            return False

        return any(self._contains_delete_command(command) for command in self._extract_command_texts(args))

    def _is_write_operation(self, tool: str, args: Dict[str, Any]) -> bool:
        normalized = self._normalize_tool_name(tool).lower()

        if normalized in _WRITE_TOOL_NAMES:
            return True

        if not self._is_terminal_operation(normalized, args):
            return False

        commands = self._extract_command_texts(args)
        for command in commands:
            if self._contains_delete_command(command):
                return True
            if self._contains_write_command(command):
                return True

        return False

    def _find_outside_workspace_target(self, tool: str, args: Dict[str, Any]) -> Dict[str, str] | None:
        if self._is_terminal_operation(tool, args):
            return self._find_outside_workspace_in_command_args(args)
        return self._find_outside_workspace_in_structured_args(args)

    def _find_outside_workspace_in_structured_args(self, args: Dict[str, Any]) -> Dict[str, str] | None:
        for key, path_text in self._extract_path_like_values(args):
            outside, detail = self._is_path_outside_workspace(path_text)
            if outside:
                return {"path": path_text, "detail": f"arg:{key} {detail}".strip()}
        return None

    def _find_outside_workspace_in_command_args(self, args: Dict[str, Any]) -> Dict[str, str] | None:
        commands = self._extract_command_texts(args)

        for command in commands:
            command_lower = command.lower()
            needs_guard = self._contains_delete_command(command) or self._contains_write_command(command)
            if not needs_guard:
                continue

            for unresolved in _UNRESOLVED_PATTERNS:
                if unresolved.search(command):
                    return {
                        "command": command,
                        "detail": "dynamic path expression is not allowed for write/delete commands",
                    }

            for candidate in self._extract_path_candidates_from_command(command):
                outside, detail = self._is_path_outside_workspace(candidate)
                if outside:
                    return {
                        "command": command,
                        "path": candidate,
                        "detail": detail,
                    }

            if "\\\\" in command or command_lower.strip().startswith("\\\\"):
                return {
                    "command": command,
                    "detail": "UNC network path is not allowed for write/delete commands",
                }

        return None

    def _find_sensitive_write_target(self, tool: str, args: Dict[str, Any]) -> Dict[str, str] | None:
        if self._is_terminal_operation(tool, args):
            return self._find_sensitive_write_in_command_args(args)
        return self._find_sensitive_write_in_structured_args(args)

    def _find_sensitive_write_in_structured_args(self, args: Dict[str, Any]) -> Dict[str, str] | None:
        for key, path_text in self._extract_path_like_values(args):
            resolved, detail = self._resolve_candidate_path(path_text)
            if resolved is None:
                continue
            sensitive_root = self._find_matching_sensitive_root(resolved)
            if sensitive_root is not None:
                return {
                    "path": str(resolved),
                    "detail": f"arg:{key} {detail}".strip(),
                    "root": str(sensitive_root),
                }
        return None

    def _find_sensitive_write_in_command_args(self, args: Dict[str, Any]) -> Dict[str, str] | None:
        commands = self._extract_command_texts(args)

        for command in commands:
            needs_guard = self._contains_delete_command(command) or self._contains_write_command(command)
            if not needs_guard:
                continue

            for candidate in self._extract_path_candidates_from_command(command):
                resolved, detail = self._resolve_candidate_path(candidate)
                if resolved is None:
                    continue
                sensitive_root = self._find_matching_sensitive_root(resolved)
                if sensitive_root is not None:
                    return {
                        "command": command,
                        "path": str(resolved),
                        "detail": detail,
                        "root": str(sensitive_root),
                    }
        return None

    def _find_matching_sensitive_root(self, candidate: Path) -> Path | None:
        for root in self.sensitive_write_roots:
            if self._is_within_allowed_root(candidate, root):
                return root
        return None

    def _extract_path_like_values(self, data: Any, parent_key: str = "") -> list[tuple[str, str]]:
        results: list[tuple[str, str]] = []

        if isinstance(data, dict):
            for key, value in data.items():
                key_str = str(key)
                key_lower = key_str.lower()

                if isinstance(value, str) and self._is_path_key(key_lower):
                    value_text = value.strip()
                    if value_text:
                        results.append((key_str, value_text))
                else:
                    results.extend(self._extract_path_like_values(value, parent_key=key_str))
            return results

        if isinstance(data, list):
            for index, item in enumerate(data):
                next_key = f"{parent_key}[{index}]" if parent_key else str(index)
                results.extend(self._extract_path_like_values(item, parent_key=next_key))
            return results

        return results

    def _is_path_key(self, key: str) -> bool:
        return any(hint in key for hint in _PATH_HINT_KEYS)

    def _extract_path_candidates_from_command(self, command: str) -> list[str]:
        candidates: list[str] = []

        for match in _REDIRECT_PATTERN.finditer(command):
            target = match.group(1).strip().strip("\"'")
            if target:
                candidates.append(target)

        for match in _POWERSHELL_PATH_ARG_PATTERN.finditer(command):
            target = match.group(1).strip().strip("\"'")
            if target:
                candidates.append(target)

        try:
            tokens = shlex.split(command, posix=(os.name != "nt"))
        except Exception:
            tokens = command.split()

        for idx, raw_token in enumerate(tokens):
            token = raw_token.strip().strip("\"'")
            if not token:
                continue

            lowered = token.lower()
            if lowered in {"rm", "rmdir", "del", "erase", "rd", "unlink", "remove-item", "clear-item", "mkdir", "cp", "mv", "copy", "move", "touch", "git", "clean", "status", "add", "commit", "push", "pull", "checkout", "switch", "python", "python3", "node", "npm", "pip", "bash", "pwsh", "powershell", "cmd", "/c", "-c"}:
                continue

            if token.startswith("-"):
                continue

            if lowered.startswith("http://") or lowered.startswith("https://"):
                continue

            if self._looks_path_token(token):
                candidates.append(token)
                continue

            if idx > 0:
                prev = tokens[idx - 1].strip().lower()
                if prev in {"cd", "-path", "-literalpath", "-destination", "-outfile"}:
                    candidates.append(token)

        deduped: list[str] = []
        seen = set()
        for item in candidates:
            if item in seen:
                continue
            seen.add(item)
            deduped.append(item)

        return deduped

    def _looks_path_token(self, token: str) -> bool:
        if not token:
            return False
        if token in {".", ".."}:
            return True
        if token.startswith("~"):
            return True
        if token.startswith("/"):
            return True
        if "\\" in token or "/" in token:
            return True
        if re.match(r"^[A-Za-z]:", token):
            return True
        if token.startswith("."):
            return True
        if "*" in token:
            return True
        return False

    def _resolve_candidate_path(self, raw_path: str) -> tuple[Path | None, str]:
        value = str(raw_path).strip().strip("\"'")
        if not value:
            return None, ""

        if value.lower().startswith(("http://", "https://")):
            return None, ""

        for unresolved in _UNRESOLVED_PATTERNS:
            if unresolved.search(value):
                return None, "dynamic path expression is not allowed"

        if value.startswith("\\\\"):
            return None, "UNC path is outside writable roots"

        mapped = self._map_windows_msys_path(value)
        candidate_text = mapped if mapped else value

        try:
            candidate_path = Path(candidate_text).expanduser()

            if candidate_path.is_absolute():
                resolved = candidate_path.resolve()
            else:
                if ".." in candidate_path.parts:
                    return None, "relative parent traversal is not allowed"
                resolved = (self.workspace_root / candidate_path).resolve()
            return resolved, ""
        except Exception:
            return None, "path escapes writable roots"

    def _is_path_outside_workspace(self, raw_path: str) -> tuple[bool, str]:
        resolved, detail = self._resolve_candidate_path(raw_path)
        if resolved is None:
            if detail:
                return True, detail
            return False, ""

        if any(self._is_within_allowed_root(resolved, root) for root in self.allowed_write_roots):
            return False, ""
        return True, "path escapes writable roots"

    def _map_windows_msys_path(self, value: str) -> str | None:
        if os.name != "nt":
            return None

        match = re.match(r"^/([A-Za-z])/(.*)$", value)
        if not match:
            return None

        drive = match.group(1).upper()
        tail = match.group(2).replace("/", "\\")
        return f"{drive}:\\{tail}"

    @staticmethod
    def _is_within_allowed_root(path: Path, root: Path) -> bool:
        try:
            path.resolve().relative_to(root.resolve())
            return True
        except Exception:
            return False


