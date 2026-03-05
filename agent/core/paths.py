"""Shared path helpers for asset and runtime roots."""

from __future__ import annotations

import os
from pathlib import Path

_ASSET_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_WINDOWS_DATA_ROOT = Path("D:/PaimonData")


def get_asset_root() -> Path:
    """Return read-only asset root (code, skills, mcp-servers)."""
    return _ASSET_ROOT


def get_skills_root() -> Path:
    """Return the single active skills root under bundled assets."""
    return get_asset_root() / "skills"


def get_playwright_browsers_root() -> Path:
    """Return the bundled Playwright browsers root under assets."""
    return get_asset_root() / "playwright-browsers"


def get_node_root() -> Path:
    """Return the bundled Node runtime root under assets."""
    return get_asset_root() / "node"


def get_python_root() -> Path:
    """Return the bundled Python runtime root under assets."""
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
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate

    if os.name == "nt":
        root = _resolve_windows_data_root() / "workspace-root"
        root.mkdir(parents=True, exist_ok=True)
        return root

    return _ASSET_ROOT
