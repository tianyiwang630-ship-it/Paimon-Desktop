"""Sandbox helpers for path confinement and command execution policy."""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path
from typing import Iterable, Optional, Sequence, Set


class SandboxViolation(Exception):
    """Raised when path or command violates sandbox constraints."""


def _to_paths(values: Optional[Iterable[Path | str]]) -> list[Path]:
    paths: list[Path] = []
    if not values:
        return paths
    for value in values:
        try:
            paths.append(Path(value).expanduser().resolve())
        except Exception:
            continue
    return paths


def is_within(path: Path, base: Path) -> bool:
    """Return True when path is within base."""
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False


def _resolve_candidate(raw_path: str, default_root: Optional[Path]) -> Path:
    candidate = Path(str(raw_path)).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    if default_root is None:
        return candidate.resolve()
    return (default_root / candidate).resolve()


def resolve_path_for_tool(
    tool: object,
    raw_path: str,
    *,
    for_write: bool,
    must_exist: bool,
    allow_directory: bool,
) -> Path:
    """Resolve and validate a file path according to tool sandbox attributes."""
    if raw_path is None or str(raw_path).strip() == "":
        raise SandboxViolation("Path is required")

    sandbox_root_raw = getattr(tool, "sandbox_root", None)
    sandbox_root = Path(sandbox_root_raw).expanduser().resolve() if sandbox_root_raw else None

    read_roots = _to_paths(getattr(tool, "sandbox_read_roots", None))
    write_roots = _to_paths(getattr(tool, "sandbox_write_roots", None))

    resolved = _resolve_candidate(str(raw_path), sandbox_root)

    allowed_roots = write_roots if for_write else read_roots
    if sandbox_root and not allowed_roots:
        allowed_roots = [sandbox_root]

    if allowed_roots and not any(is_within(resolved, root) for root in allowed_roots):
        raise SandboxViolation(f"Path is outside sandbox: {raw_path}")

    if must_exist and not resolved.exists():
        raise SandboxViolation(f"Path does not exist: {raw_path}")

    if resolved.exists() and not allow_directory and resolved.is_dir():
        raise SandboxViolation(f"Path is a directory, expected file: {raw_path}")

    return resolved


def resolve_directory_for_tool(
    tool: object,
    raw_path: Optional[str],
    *,
    for_write: bool,
    must_exist: bool,
) -> Path:
    """Resolve and validate a directory path according to tool sandbox attributes."""
    sandbox_root_raw = getattr(tool, "sandbox_root", None)
    sandbox_root = Path(sandbox_root_raw).expanduser().resolve() if sandbox_root_raw else None

    if raw_path is None or str(raw_path).strip() == "":
        if sandbox_root is not None:
            resolved = sandbox_root
        else:
            resolved = Path.cwd().resolve()
    else:
        resolved = _resolve_candidate(str(raw_path), sandbox_root)

    read_roots = _to_paths(getattr(tool, "sandbox_read_roots", None))
    write_roots = _to_paths(getattr(tool, "sandbox_write_roots", None))
    allowed_roots = write_roots if for_write else read_roots
    if sandbox_root and not allowed_roots:
        allowed_roots = [sandbox_root]

    if allowed_roots and not any(is_within(resolved, root) for root in allowed_roots):
        raise SandboxViolation(f"Path is outside sandbox: {raw_path}")

    if must_exist and not resolved.exists():
        raise SandboxViolation(f"Path does not exist: {raw_path}")

    if resolved.exists() and not resolved.is_dir():
        raise SandboxViolation(f"Path is not a directory: {raw_path}")

    return resolved


DEFAULT_COMMAND_ALLOWLIST: Set[str] = {
    "bash", "sh", "cmd", "powershell", "pwsh",
    "python", "python3", "pip", "pip3", "uv", "pytest",
    "node", "npm", "npx", "yarn", "pnpm", "tsc", "vite",
    "git", "ls", "dir", "pwd", "cd", "cat", "type", "echo", "more",
    "rg", "grep", "find", "findstr", "head", "tail", "sed", "awk", "sort", "uniq", "wc",
    "cut", "tr", "xargs", "mkdir", "rmdir", "touch", "cp", "mv", "where", "which",
    "curl", "wget", "tar", "zip", "unzip",
    "make", "cmake", "ninja", "gcc", "g++", "clang", "clang++",
    "go", "cargo", "rustc", "java", "javac", "mvn", "gradle", "dotnet"
}

_BLOCKED_PATTERNS = [
    r"\brm\s+-rf\s+/$",
    r"\brm\s+-rf\s+\*$",
    r"\bdel\s+/[sq].*\\\*",
    r"\bformat\b",
    r"\bdiskpart\b",
    r"\bshutdown\b",
    r"\bpoweroff\b",
    r"\breboot\b",
]

_SPLIT_SEGMENTS = re.compile(r"\|\||&&|[|;]")


def _primary_command(segment: str) -> str:
    try:
        tokens = shlex.split(segment, posix=(os.name != "nt"))
    except Exception:
        tokens = segment.split()
    if not tokens:
        return ""

    idx = 0
    while idx < len(tokens) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=.*", tokens[idx]):
        idx += 1
    if idx >= len(tokens):
        return ""

    cmd = tokens[idx]
    if cmd in {"env", "sudo"} and idx + 1 < len(tokens):
        cmd = tokens[idx + 1]

    cmd = cmd.strip('"\'')
    return Path(cmd).name.lower()


def validate_shell_command(command: str, allowlist: Optional[Set[str]] = None) -> None:
    """Validate shell command against a whitelist and blocked patterns."""
    text = (command or "").strip()
    if not text:
        raise SandboxViolation("Command is empty")

    lowered = text.lower()
    for pattern in _BLOCKED_PATTERNS:
        if re.search(pattern, lowered):
            raise SandboxViolation("Command contains blocked operation")

    effective_allowlist = {c.lower() for c in (allowlist or DEFAULT_COMMAND_ALLOWLIST)}

    segments = [s.strip() for s in _SPLIT_SEGMENTS.split(text) if s.strip()]
    for segment in segments:
        cmd = _primary_command(segment)
        if not cmd:
            continue
        if cmd not in effective_allowlist:
            raise SandboxViolation(f"Command '{cmd}' is not allowed in sandbox")


def build_sandbox_env(base_env: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Build execution env with bundled runtimes preferred."""
    env = dict(base_env or os.environ)
    original_path = env.get("PATH", "")

    preferred: list[str] = []
    for key in ("SKILLS_MCP_PYTHON", "SKILLS_MCP_NODE"):
        value = (env.get(key) or "").strip()
        if value:
            preferred.append(str(Path(value).expanduser().resolve().parent))

    tools_paths = (env.get("SKILLS_MCP_TOOLS_PATHS") or "").strip()
    if tools_paths:
        for item in tools_paths.split(os.pathsep):
            candidate = item.strip()
            if candidate:
                preferred.append(str(Path(candidate).expanduser().resolve()))

    system_paths: list[str] = []
    if os.name == "nt":
        system_paths = [
            r"C:\Windows\System32",
            r"C:\Windows",
            r"C:\Windows\System32\WindowsPowerShell\v1.0",
        ]
    else:
        system_paths = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    merged: list[str] = []
    for item in preferred + system_paths + original_path.split(os.pathsep):
        if not item:
            continue
        normalized = str(Path(item).expanduser())
        if normalized not in merged:
            merged.append(normalized)

    env["PATH"] = os.pathsep.join(merged)
    env.setdefault("PYTHONNOUSERSITE", "1")
    return env
