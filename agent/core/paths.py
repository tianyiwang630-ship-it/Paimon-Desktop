"""Shared path helpers for asset and runtime roots."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_ASSET_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_WINDOWS_DATA_ROOT = Path("D:/PaimonData")
_DEFAULT_MACOS_DATA_ROOT = Path.home() / "PaimonData"


def _resolve_path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def _resolve_executable_parent(value: str) -> Path:
    candidate = Path(value).expanduser()
    name = candidate.name.lower()
    if name in {"python", "python3", "python.exe", "node", "node.exe"}:
        parent = candidate.parent
        if parent.name.lower() in {"bin", "scripts"}:
            return parent.parent.resolve()
        return parent.resolve()
    if candidate.suffix.lower() in {".exe", ".bin"}:
        return candidate.parent.resolve()
    return candidate.resolve()


def _warn_path_fallback(message: str) -> None:
    print(f"[paths] {message}")


def _normalize_windows_data_root_candidate(raw: str | None) -> Path:
    candidate = (raw or "").strip()
    if not candidate:
        return _DEFAULT_WINDOWS_DATA_ROOT

    if candidate.startswith("\\\\"):
        _warn_path_fallback(f"Reject UNC data root override outside D drive: {candidate}")
        return _DEFAULT_WINDOWS_DATA_ROOT

    parsed = Path(candidate).expanduser()
    if not parsed.is_absolute():
        _warn_path_fallback(f"Reject relative data root override outside D drive: {candidate}")
        return _DEFAULT_WINDOWS_DATA_ROOT

    drive = parsed.drive.upper() if parsed.drive else ""
    if drive != "D:":
        _warn_path_fallback(f"Reject non-D drive data root override: {candidate}")
        return _DEFAULT_WINDOWS_DATA_ROOT

    return parsed.resolve()


def _normalize_windows_runtime_root_candidate(raw: str | None, data_root: Path) -> Path:
    candidate = (raw or "").strip()
    if not candidate:
        return data_root / "workspace-root"

    if candidate.startswith("\\\\"):
        _warn_path_fallback(f"Reject UNC runtime root override outside D drive: {candidate}")
        return data_root / "workspace-root"

    parsed = Path(candidate).expanduser()
    if not parsed.is_absolute():
        _warn_path_fallback(f"Reject relative runtime root override outside D drive: {candidate}")
        return data_root / "workspace-root"

    resolved = parsed.resolve()
    try:
        resolved.relative_to(data_root)
    except ValueError:
        _warn_path_fallback(f"Reject runtime root override outside D drive data root: {candidate}")
        return data_root / "workspace-root"
    return resolved


def _normalize_macos_root_candidate(raw: str | None, default_root: Path) -> Path:
    candidate = Path((raw or "").strip()).expanduser() if raw else default_root
    normalized = candidate.resolve()
    allowed_root = default_root.resolve()
    try:
        normalized.relative_to(allowed_root)
    except ValueError:
        if normalized != allowed_root:
            _warn_path_fallback(f"Reject macOS override outside ~/PaimonData: {candidate}")
            normalized = allowed_root
    return normalized


def get_asset_root() -> Path:
    """Return read-only asset root (code, skills, mcp-servers)."""
    override = (os.environ.get("SKILLS_MCP_ASSET_ROOT") or "").strip()
    if override:
        return _resolve_path(override)
    return _ASSET_ROOT


def get_skills_root() -> Path:
    """Return the single active skills root under bundled assets."""
    return get_asset_root() / "skills"


def get_playwright_browsers_root() -> Path:
    """Return the active Playwright browsers root."""
    override = (os.environ.get("SKILLS_MCP_PLAYWRIGHT_BROWSERS") or "").strip()
    if override:
        return _resolve_path(override)
    return get_asset_root() / "playwright-browsers"


def get_node_root() -> Path:
    """Return the active Node runtime root."""
    override = (os.environ.get("SKILLS_MCP_NODE") or "").strip()
    if override:
        return _resolve_executable_parent(override)
    return get_asset_root() / "node"


def get_python_root() -> Path:
    """Return the active Python runtime root."""
    override = (os.environ.get("SKILLS_MCP_PYTHON") or "").strip()
    if override:
        return _resolve_executable_parent(override)
    return get_asset_root() / "python"


def _resolve_windows_data_root() -> Path:
    root = _normalize_windows_data_root_candidate(os.environ.get("SKILLS_MCP_DATA_ROOT"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve_macos_data_root() -> Path:
    normalized = _normalize_macos_root_candidate(os.environ.get("SKILLS_MCP_DATA_ROOT"), _DEFAULT_MACOS_DATA_ROOT)
    normalized.mkdir(parents=True, exist_ok=True)
    return normalized


def get_runtime_root() -> Path:
    """
    Return writable runtime root.

    Use SKILLS_MCP_RUNTIME_ROOT when provided (for packaged app/user data).
    On Windows, runtime root is forced under D:/PaimonData.
    """
    raw = (os.environ.get("SKILLS_MCP_RUNTIME_ROOT") or "").strip()

    if raw:
        if os.name == "nt":
            data_root = _resolve_windows_data_root()
            candidate = _normalize_windows_runtime_root_candidate(raw, data_root)
        elif sys.platform == "darwin":
            data_root = _resolve_macos_data_root()
            candidate = _normalize_macos_root_candidate(raw, data_root)
        else:
            candidate = Path(raw).expanduser().resolve()
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate

    if os.name == "nt":
        root = _resolve_windows_data_root() / "workspace-root"
        root.mkdir(parents=True, exist_ok=True)
        return root

    if sys.platform == "darwin":
        root = _resolve_macos_data_root() / "workspace-root"
        root.mkdir(parents=True, exist_ok=True)
        return root

    return get_asset_root()
