import sys
import types
from pathlib import Path


if "openai" not in sys.modules:
    sys.modules["openai"] = types.SimpleNamespace(OpenAI=object)

from agent.core.paths import (
    get_asset_root,
    get_playwright_browsers_root,
    get_skills_root,
    get_node_root,
    get_python_root,
)
from agent.core.permission_manager import PermissionManager
from agent.core.tool_loader import ToolLoader
from agent.tools.write_tool import WriteTool


def test_get_skills_root_is_under_asset_root():
    assert get_skills_root() == get_asset_root() / "skills"


def test_get_playwright_browsers_root_is_under_asset_root():
    assert get_playwright_browsers_root() == get_asset_root() / "playwright-browsers"


def test_get_node_root_is_under_asset_root():
    assert get_node_root() == get_asset_root() / "node"


def test_get_python_root_is_under_asset_root():
    assert get_python_root() == get_asset_root() / "python"


def test_tool_loader_loads_only_bundled_skills_and_exposes_manifest_paths(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    asset_root = repo_root
    skills_root = repo_root / "skills"
    playwright_browsers_root = repo_root / "playwright-browsers"
    node_root = repo_root / "node"
    python_root = repo_root / "python"
    runtime_root = repo_root / "workspace_runtime_test"

    monkeypatch.setattr("agent.core.tool_loader.get_asset_root", lambda: asset_root)
    monkeypatch.setattr("agent.core.tool_loader.get_skills_root", lambda: skills_root)
    monkeypatch.setattr("agent.core.tool_loader.get_playwright_browsers_root", lambda: playwright_browsers_root)
    monkeypatch.setattr("agent.core.tool_loader.get_node_root", lambda: node_root)
    monkeypatch.setattr("agent.core.tool_loader.get_python_root", lambda: python_root)
    monkeypatch.setattr("agent.core.tool_loader.get_runtime_root", lambda: runtime_root)

    loader = ToolLoader(enable_permissions=False)
    loader._load_skills()

    assert loader.skills_dir == skills_root
    assert "skill__pptx" in loader.tool_executors

    result = loader.tool_executors["skill__pptx"]("ignored")
    assert f"Skill manifest file: {(skills_root / 'pptx' / 'SKILL.md').resolve()}" in result
    assert f"Skill directory: {(skills_root / 'pptx').resolve()}" in result
    assert "Resolve any relative skill file paths from Skill directory." in result


def test_tool_loader_builtin_tools_get_runtime_and_skills_sandbox_roots(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    asset_root = repo_root
    skills_root = repo_root / "skills"
    playwright_browsers_root = repo_root / "playwright-browsers"
    node_root = repo_root / "node"
    python_root = repo_root / "python"
    runtime_root = repo_root / "workspace_runtime_test"

    monkeypatch.setattr("agent.core.tool_loader.get_asset_root", lambda: asset_root)
    monkeypatch.setattr("agent.core.tool_loader.get_skills_root", lambda: skills_root)
    monkeypatch.setattr("agent.core.tool_loader.get_playwright_browsers_root", lambda: playwright_browsers_root)
    monkeypatch.setattr("agent.core.tool_loader.get_node_root", lambda: node_root)
    monkeypatch.setattr("agent.core.tool_loader.get_python_root", lambda: python_root)
    monkeypatch.setattr("agent.core.tool_loader.get_runtime_root", lambda: runtime_root)

    loader = ToolLoader(enable_permissions=False)
    tool = WriteTool()
    loader._apply_sandbox_constraints(tool)

    assert tool.sandbox_root == runtime_root.resolve()
    assert tool.sandbox_read_roots == [runtime_root.resolve(), asset_root.resolve()]
    assert tool.sandbox_write_roots == [
        runtime_root.resolve(),
        skills_root.resolve(),
        playwright_browsers_root.resolve(),
        node_root.resolve(),
        python_root.resolve(),
    ]


def test_permission_manager_allows_skills_root_but_blocks_other_asset_paths(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    asset_root = repo_root
    skills_root = repo_root / "skills"
    playwright_browsers_root = repo_root / "playwright-browsers"
    node_root = repo_root / "node"
    python_root = repo_root / "python"
    runtime_root = repo_root / "workspace_runtime_test"

    monkeypatch.setattr("agent.core.permission_manager.get_asset_root", lambda: asset_root)
    monkeypatch.setattr("agent.core.permission_manager.get_runtime_root", lambda: runtime_root)
    monkeypatch.setattr("agent.core.permission_manager.get_skills_root", lambda: skills_root)
    monkeypatch.setattr(
        "agent.core.permission_manager.get_playwright_browsers_root",
        lambda: playwright_browsers_root,
    )
    monkeypatch.setattr("agent.core.permission_manager.get_node_root", lambda: node_root)
    monkeypatch.setattr("agent.core.permission_manager.get_python_root", lambda: python_root)

    manager = PermissionManager()

    allowed_skills = manager.check_permission(
        "write",
        {"file_path": str(skills_root / "pptx" / "new.txt"), "content": "ok"},
    )
    allowed_playwright = manager.check_permission(
        "write",
        {"file_path": str(playwright_browsers_root / "cache" / "new.txt"), "content": "ok"},
    )
    denied = manager.check_permission(
        "write",
        {"file_path": str(asset_root / "mcp-servers" / "new.txt"), "content": "no"},
    )
    denied_decision = manager.get_last_decision()
    ask_node = manager.check_permission(
        "write",
        {"file_path": str(node_root / "node_modules" / "pkg" / "index.js"), "content": "module.exports = 1"},
    )
    ask_python = manager.check_permission(
        "write",
        {"file_path": str(python_root / "Lib" / "site-packages" / "pkg.py"), "content": "x = 1"},
    )

    assert allowed_skills == "allow"
    assert allowed_playwright == "allow"
    assert denied == "deny"
    assert ask_node == "ask"
    assert ask_python == "ask"
    assert denied_decision["blocked_path"] == str(asset_root / "mcp-servers" / "new.txt")


def test_permission_manager_disables_session_allow_for_sensitive_write_roots(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    asset_root = repo_root
    skills_root = repo_root / "skills"
    playwright_browsers_root = repo_root / "playwright-browsers"
    node_root = repo_root / "node"
    python_root = repo_root / "python"
    runtime_root = repo_root / "workspace_runtime_test"

    monkeypatch.setattr("agent.core.permission_manager.get_asset_root", lambda: asset_root)
    monkeypatch.setattr("agent.core.permission_manager.get_runtime_root", lambda: runtime_root)
    monkeypatch.setattr("agent.core.permission_manager.get_skills_root", lambda: skills_root)
    monkeypatch.setattr(
        "agent.core.permission_manager.get_playwright_browsers_root",
        lambda: playwright_browsers_root,
    )
    monkeypatch.setattr("agent.core.permission_manager.get_node_root", lambda: node_root)
    monkeypatch.setattr("agent.core.permission_manager.get_python_root", lambda: python_root)

    manager = PermissionManager()
    manager.allow_tool_for_session("write")

    assert manager.can_allow_session(
        "write",
        {"file_path": str(node_root / "node_modules" / "pkg" / "index.js"), "content": "ok"},
    ) is False

    decision = manager.check_permission(
        "write",
        {"file_path": str(node_root / "node_modules" / "pkg" / "index.js"), "content": "ok"},
    )
    assert decision == "ask"
