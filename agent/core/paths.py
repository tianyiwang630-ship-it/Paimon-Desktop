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
    raw = (os.environ.get("SKILLS_MCP_DATA_ROOT") or "").strip()
    candidate = Path(raw).expanduser() if raw else _DEFAULT_WINDOWS_DATA_ROOT

    drive = candidate.drive.upper() if candidate.drive else ""
    if drive and drive != "D:":
        candidate = _DEFAULT_WINDOWS_DATA_ROOT

    root = candidate.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve_macos_data_root() -> Path:
    raw = (os.environ.get("SKILLS_MCP_DATA_ROOT") or "").strip()
    candidate = Path(raw).expanduser() if raw else _DEFAULT_MACOS_DATA_ROOT
    normalized = candidate.resolve()
    allowed_root = _DEFAULT_MACOS_DATA_ROOT.resolve()

    try:
        normalized.relative_to(allowed_root)
    except ValueError:
        if normalized != allowed_root:
            normalized = allowed_root

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
        candidate = Path(raw).expanduser().resolve()
        if os.name == "nt":
            data_root = _resolve_windows_data_root()
            try:
                candidate.relative_to(data_root)
            except ValueError:
                candidate = data_root / "workspace-root"
        elif sys.platform == "darwin":
            data_root = _resolve_macos_data_root()
            try:
                candidate.relative_to(data_root)
            except ValueError:
                candidate = data_root / "workspace-root"
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
