import json
import shutil
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.core.tool_loader import ToolLoader
from agent.server.routes import meta


class _FakeMCPManager:
    def get_tools_by_server(self):
        return {
            "playwright": {
                "description": "Browser automation",
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "mcp__playwright__navigate",
                            "description": "Navigate a page",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    }
                ],
            },
            "rednote": {
                "description": "Social content",
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "mcp__rednote__search",
                            "description": "Search content",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    }
                ],
            },
        }


def _write_registry(project_root: Path, payload: dict) -> None:
    mcp_root = project_root / "mcp-servers"
    mcp_root.mkdir(parents=True, exist_ok=True)
    (mcp_root / "registry.json").write_text(
        json.dumps(payload, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )


def _make_case_root(name: str) -> Path:
    case_root = PROJECT_ROOT / "temp" / name
    if case_root.exists():
        shutil.rmtree(case_root)
    case_root.mkdir(parents=True, exist_ok=True)
    return case_root


class MCPRegistryUseFlagTests(unittest.TestCase):
    def test_disabled_mcp_server_is_skipped_by_tool_loader(self):
        project_root = _make_case_root("test-mcp-registry-use-loader")
        _write_registry(
            project_root,
            {
                "playwright": {"category": "core", "use": "off"},
                "rednote": {"category": "searchable", "use": "on"},
            },
        )

        loader = ToolLoader(
            project_root=project_root,
            enable_permissions=False,
            mcp_manager=_FakeMCPManager(),
        )

        loader._load_mcp_tools()

        tool_names = [tool["function"]["name"] for tool in loader.tools]
        self.assertNotIn("mcp__playwright__navigate", tool_names)
        self.assertIn("tool_search", tool_names)
        self.assertNotIn("playwright", loader._searchable_servers)
        self.assertIn("rednote", loader._searchable_servers)

    def test_guide_marks_disabled_mcp_servers_but_keeps_them_visible(self):
        project_root = _make_case_root("test-mcp-registry-use-guide")
        mcp_root = project_root / "mcp-servers"
        playwright_dir = mcp_root / "playwright"
        playwright_dir.mkdir(parents=True, exist_ok=True)
        (playwright_dir / "mcp.config.json").write_text('{"type":"stdio"}', encoding="utf-8")

        crawler_dir = mcp_root / "crawler"
        crawler_dir.mkdir(parents=True, exist_ok=True)
        (crawler_dir / "mcp.config.json").write_text('{"type":"stdio"}', encoding="utf-8")

        _write_registry(
            project_root,
            {
                "playwright": {"category": "core", "use": "off"},
            },
        )

        old_asset_root = meta._asset_root
        try:
            meta._asset_root = project_root.resolve()
            servers = meta._collect_mcp_servers()
            guide = meta._build_guide_text()
        finally:
            meta._asset_root = old_asset_root

        by_name = {item["name"]: item for item in servers}
        self.assertEqual("false", by_name["playwright"]["enabled"])
        self.assertEqual("true", by_name["crawler"]["enabled"])
        self.assertIn("[core] playwright (disabled) [stdio]", guide)
        self.assertIn("[searchable] crawler [stdio]", guide)


if __name__ == "__main__":
    unittest.main()
