"""Application-level metadata and guide endpoints."""

import json
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter

from agent.core.paths import get_asset_root, get_runtime_root
from agent.core.tool_loader import ToolLoader

router = APIRouter(prefix="/api/meta", tags=["meta"])

_asset_root = get_asset_root().resolve()
_runtime_root = get_runtime_root().resolve()
_builtin_skills_root = (_asset_root / "skills").resolve()
_runtime_skills_root = (_runtime_root / "skills").resolve()


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


def _collect_skills() -> List[str]:
    names: List[str] = []
    skill_dirs = [_runtime_skills_root, _builtin_skills_root]

    for skills_dir in skill_dirs:
        if not skills_dir.exists():
            continue

        # Scan only skill manifests to avoid traversing unrelated markdown files.
        manifests = list(skills_dir.rglob("SKILL.md")) + list(skills_dir.rglob("skill.md"))
        seen_manifest_paths = set()

        for md_file in sorted(manifests, key=lambda p: str(p).lower()):
            key = str(md_file).lower()
            if key in seen_manifest_paths:
                continue
            seen_manifest_paths.add(key)

            name = ""
            try:
                content = md_file.read_text(encoding="utf-8").lstrip("\ufeff")
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        for line in parts[1].splitlines():
                            line = line.strip()
                            if line.lower().startswith("name:"):
                                name = line.split(":", 1)[1].strip()
                                break
            except Exception:
                # Fall back to folder name when manifest cannot be parsed.
                pass

            if not name:
                name = md_file.parent.name

            if name:
                names.append(name)

    return sorted(set(names), key=str.lower)


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
        for name in skills:
            lines.append(f"  - {name}")
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
    lines.append(f"  - Builtin skills (read-only): {_builtin_skills_root}")
    lines.append(f"  - Runtime skills (install target): {_runtime_skills_root}")
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
