"""Application-level metadata and guide endpoints."""

import json
import logging
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter
import yaml

from agent.core.paths import (
    get_asset_root,
    get_runtime_root,
    get_skills_root,
    get_node_root,
    get_python_root,
)
from agent.core.tool_loader import ToolLoader

router = APIRouter(prefix="/api/meta", tags=["meta"])
logger = logging.getLogger("agent")

_asset_root = get_asset_root().resolve()
_runtime_root = get_runtime_root().resolve()
_skills_root = get_skills_root().resolve()
_node_root = get_node_root().resolve()
_python_root = get_python_root().resolve()
_legacy_runtime_skills_root = (_runtime_root / "skills").resolve()
_legacy_runtime_skills_logged = False


def _read_json(path: Path) -> Dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _detect_server_type(server_dir: Path) -> str:
    config_paths = [
        server_dir / "mcp.config.json",
        server_dir / "auto-config.json",
    ]
    for cfg in config_paths:
        if not cfg.exists():
            continue
        data = _read_json(cfg)
        if "mcpServers" in data and isinstance(data["mcpServers"], dict):
            first = next(iter(data["mcpServers"].values()), {})
            return str(first.get("type", "stdio"))
        return str(data.get("type", "stdio"))
    return "stdio"


def _discover_manifests(root: Path) -> List[Path]:
    skip_dirs = {"node_modules", "__pycache__", ".git", "venv", ".venv"}

    if not root.exists() or not root.is_dir():
        return []

    manifests: List[Path] = []
    queue: List[tuple[Path, int]] = [(root, 0)]
    visited: set[str] = set()
    max_depth = 2

    while queue:
        current, depth = queue.pop(0)
        key = str(current.resolve()).lower()
        if key in visited:
            continue
        visited.add(key)

        for name in ("SKILL.md", "skill.md"):
            manifest = current / name
            if manifest.exists() and manifest.is_file():
                manifests.append(manifest)

        if depth >= max_depth:
            continue

        try:
            children = sorted(current.iterdir(), key=lambda p: p.name.lower())
        except Exception:
            continue

        for child in children:
            if not child.is_dir() or child.name.startswith("."):
                continue
            if child.name.lower() in skip_dirs:
                continue
            queue.append((child, depth + 1))

    return manifests


def _log_legacy_runtime_skills() -> None:
    global _legacy_runtime_skills_logged
    if _legacy_runtime_skills_logged:
        return

    manifests = _discover_manifests(_legacy_runtime_skills_root)
    if not manifests:
        return

    logger.warning(
        "Legacy runtime skills directory is deprecated and ignored: %s (%d manifest(s))",
        _legacy_runtime_skills_root,
        len(manifests),
    )
    _legacy_runtime_skills_logged = True


def _collect_mcp_servers() -> List[Dict[str, str]]:
    registry = ToolLoader._load_registry_static(_asset_root)
    servers_dir = _asset_root / "mcp-servers"
    items: List[Dict[str, str]] = []

    if not servers_dir.exists():
        return items

    for server_dir in sorted(servers_dir.iterdir(), key=lambda x: x.name.lower()):
        if not server_dir.is_dir() or server_dir.name.startswith("."):
            continue
        name = server_dir.name
        entry = registry.get(name, {})
        items.append(
            {
                "name": name,
                "type": _detect_server_type(server_dir),
                "category": str(entry.get("category", "searchable")),
                "alias": str(entry.get("alias", "")),
            }
        )
    return items


def _read_skill_metadata(md_file: Path) -> Dict[str, str]:
    metadata: Dict[str, str] = {
        "name": md_file.parent.name,
        "description": "",
    }

    try:
        content = md_file.read_text(encoding="utf-8").lstrip("\ufeff")
    except Exception:
        return metadata

    if not content.startswith("---"):
        return metadata

    parts = content.split("---", 2)
    if len(parts) < 3:
        return metadata

    try:
        parsed = yaml.safe_load(parts[1]) or {}
    except Exception:
        return metadata

    if not isinstance(parsed, dict):
        return metadata

    name = str(parsed.get("name") or "").strip()
    description = str(parsed.get("description") or "").strip()
    if name:
        metadata["name"] = name
    if description:
        metadata["description"] = description
    return metadata


def _collect_skills() -> List[Dict[str, str]]:
    skills: List[Dict[str, str]] = []
    _log_legacy_runtime_skills()

    seen_manifest_paths = set()
    for md_file in _discover_manifests(_skills_root):
        key = str(md_file).lower()
        if key in seen_manifest_paths:
            continue
        seen_manifest_paths.add(key)

        metadata = _read_skill_metadata(md_file)
        name = str(metadata.get("name") or "").strip()
        if not name:
            continue

        skills.append(
            {
                "name": name,
                "description": str(metadata.get("description") or "").strip(),
            }
        )

    deduped: Dict[str, Dict[str, str]] = {}
    for item in skills:
        deduped[item["name"].lower()] = item
    return sorted(deduped.values(), key=lambda item: item["name"].lower())


def _collect_builtin_tools() -> List[str]:
    names: List[str] = []
    for _, class_name, _ in ToolLoader.BUILTIN_TOOLS:
        normalized = class_name[:-4] if class_name.endswith("Tool") else class_name
        names.append(normalized.lower())
    return names


def _build_guide_text() -> str:
    mcp_servers = _collect_mcp_servers()
    skills = _collect_skills()
    builtins = _collect_builtin_tools()

    core_count = sum(1 for s in mcp_servers if s["category"] == "core")
    searchable_count = len(mcp_servers) - core_count

    lines: List[str] = []
    lines.append("=" * 70)
    lines.append("Agent Application Guide")
    lines.append("=" * 70)
    lines.append("")
    lines.append("MCP Servers:")
    if not mcp_servers:
        lines.append("  (none discovered)")
    else:
        for s in mcp_servers:
            alias = f" ({s['alias']})" if s["alias"] else ""
            lines.append(f"  - [{s['category']}] {s['name']}{alias} [{s['type']}]")
    lines.append(f"  Total: {len(mcp_servers)} ({core_count} core + {searchable_count} searchable)")
    lines.append("")
    lines.append("Skills:")
    if not skills:
        lines.append("  (none discovered)")
    else:
        for skill in skills:
            lines.append(f"  - {skill['name']}")
            description = str(skill.get("description") or "").strip()
            if description:
                for line in description.splitlines():
                    lines.append(f"    {line}")
    lines.append(f"  Total: {len(skills)}")
    lines.append("")
    lines.append("Built-in Tools:")
    for name in builtins:
        lines.append(f"  - {name}")
    lines.append(f"  Total: {len(builtins)}")
    lines.append("")
    lines.append("Workspace Paths (application-level):")
    lines.append(f"  - Asset root: {_asset_root}")
    lines.append(f"  - Runtime root: {_runtime_root}")
    lines.append(f"  - Session workspaces root: {_runtime_root / 'sessions'}")
    lines.append(f"  - Project workspaces root: {_runtime_root / 'projects'}")
    lines.append(f"  - Logs: {_runtime_root / 'workspace' / 'logs'}")
    lines.append(f"  - MCP servers: {_asset_root / 'mcp-servers'}")
    lines.append(f"  - Active skills directory: {_skills_root}")
    lines.append(f"  - Bundled Node runtime (sensitive write root): {_node_root}")
    lines.append(f"  - Bundled Python runtime (sensitive write root): {_python_root}")
    lines.append("")
    lines.append("Basic Operations:")
    lines.append("  - Start a new chat from the left sidebar.")
    lines.append("  - Use Files button to manage input/output/temp artifacts.")
    lines.append("  - During generation, Send switches to Interrupt.")
    lines.append("  - Use Config to edit LLM base URL, API key, and model name.")
    lines.append("  - Use Guide to review available MCP/skills and workspace rules.")
    lines.append("")
    return "\n".join(lines)


@router.get("/guide")
def get_guide():
    return {"guide": _build_guide_text()}


@router.get("/skills")
def get_skills():
    return {"skills": _collect_skills()}

