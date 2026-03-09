"""
 - MCP + Skills + 
"""

import json
import importlib
import logging
from pathlib import Path
from typing import List, Dict, Any

from agent.core.config import BASH_TOOL_TIMEOUT, DEFAULT_MCP_CATEGORY
from agent.core.bm25 import BM25Index
from agent.core.paths import (
    get_asset_root,
    get_runtime_root,
    get_skills_root,
    get_playwright_browsers_root,
    get_node_root,
    get_python_root,
)


logger = logging.getLogger("agent")


class PermissionRequestError(Exception):
    """ -  web """

    def __init__(self, tool: str, tool_args: Dict[str, Any], permission_manager):
        self.tool = tool
        self.tool_args = tool_args  #  Exception.args 
        self.permission_manager = permission_manager
        super().__init__(f"Permission request: {tool}")


class ToolLoader:
    """"""

    def __init__(
        self,
        project_root: Path = None,
        enable_permissions: bool = True,
        mcp_manager=None,
        permission_callback=None,
    ):
        """
        

        Args:
            project_root: 
            enable_permissions: 
            mcp_manager:  MCPManager 
                          MCPManager 
            permission_callback: web 
                                web  ask 
                                (tool, args)  True()/False()
        """
        if project_root is None:
            self.project_root = get_asset_root()
        else:
            self.project_root = Path(project_root)

        self._external_mcp_manager = mcp_manager  # 
        self.permission_callback = permission_callback  # web 

        self.resources_dir = self.project_root.resolve()
        self.builtin_skills_dir = get_skills_root()
        self.playwright_browsers_dir = get_playwright_browsers_root()
        self.node_dir = get_node_root()
        self.python_dir = get_python_root()
        self.runtime_root = get_runtime_root()
        self.legacy_runtime_skills_dir = self.runtime_root / "skills"
        self.skills_dir = self.builtin_skills_dir

        self.tools = []
        self.tool_executors = {}  #  -> 
        self.tool_instances = {}  #  -> 

        # Tool Search 
        self._searchable_servers = {}   # {server_name: {tools, alias, description}}
        self._bm25_index = None         # BM25Index
        self._injected_servers = set()  #  server

        # 
        self.enable_permissions = enable_permissions
        if enable_permissions:
            from agent.core.permission_manager import PermissionManager
            self.permission_manager = PermissionManager()
        else:
            self.permission_manager = None

    def load_all(self) -> List[Dict[str, Any]]:
        """
        

        Returns:
            OpenAI format
        """
        self.tools = []
        self.tool_executors = {}

        print("Loading tools...")

        # 1.  MCP 
        self._load_mcp_tools()

        # 2.  Skills
        self._load_skills()

        # 3. Bash
        self._load_builtin_tools()

        print(f"\nOK  {len(self.tools)} \n")

        return self.tools

    def _load_mcp_tools(self):
        """ MCP  registry.json core  / searchable """
        try:
            from agent.tools.mcp_manager import MCPManager

            print("\n  MCP ...")
            mcp_servers_dir = str(self.project_root / "mcp-servers")

            # 
            if self._external_mcp_manager is not None:
                manager = self._external_mcp_manager
            else:
                manager = MCPManager(servers_dir=mcp_servers_dir)

            #  server 
            servers = manager.get_tools_by_server()
            if not servers:
                print(f"   Warning:   MCP ")
                return

            # 
            registry = self._load_registry()

            core_count = 0
            searchable_count = 0

            for server_name, server_info in servers.items():
                entry = registry.get(server_name, {})
                category = entry.get('category', DEFAULT_MCP_CATEGORY)
                alias = entry.get('alias', '')
                tools = server_info.get('tools', [])

                if category == 'core':
                    self.tools.extend(tools)
                    core_count += len(tools)
                    print(f"   OK [core] {server_name}: {len(tools)} ")
                else:
                    self._searchable_servers[server_name] = {
                        'tools': tools,
                        'alias': alias,
                        'description': server_info.get('description', ''),
                    }
                    searchable_count += len(tools)
                    print(f"   OK [searchable] {server_name}: {len(tools)}  (deferred)")

            #  searchable servers tool_search
            if self._searchable_servers:
                self._build_search_index()
                search_tool_def = self._create_tool_search_definition()
                self.tools.append(search_tool_def)
                print(f"   tool_search {len(self._searchable_servers)}  searchable server{searchable_count} ")

            #  manager 
            self.tool_executors['_mcp_manager'] = manager

            total = core_count + searchable_count
            print(f"   OK MCP : {total}{core_count} core + {searchable_count} searchable")

        except Exception as e:
            print(f"   Error: MCP : {e}")
            import traceback
            traceback.print_exc()

    def _load_registry(self) -> Dict:
        """ mcp-servers/registry.json """
        return ToolLoader._load_registry_static(self.project_root)

    @staticmethod
    def _load_registry_static(project_root: Path) -> Dict:
        """ app.py"""
        registry_path = project_root / "mcp-servers" / "registry.json"
        if registry_path.exists():
            try:
                data = json.loads(registry_path.read_text(encoding='utf-8'))
                return {k: v for k, v in data.items() if isinstance(v, dict) and not k.startswith('_')}
            except Exception as e:
                print(f"   Warning: registry.json : {e}")
        return {}

    def _build_search_index(self):
        """ searchable servers  BM25 """
        self._bm25_index = BM25Index()

        for server_name, info in self._searchable_servers.items():
            text_parts = [server_name]

            if info.get('alias'):
                text_parts.append(info['alias'])
            if info.get('description'):
                text_parts.append(info['description'])

            for tool_def in info.get('tools', []):
                func = tool_def.get('function', {})
                text_parts.append(func.get('name', '').replace('__', ' ').replace('_', ' '))
                text_parts.append(func.get('description', ''))
                params = func.get('parameters', {})
                for param_name in params.get('properties', {}).keys():
                    text_parts.append(param_name)

            self._bm25_index.add_document(server_name, ' '.join(text_parts))

    @staticmethod
    def _format_alias(alias: str) -> str:
        parts = [part.strip() for part in str(alias or "").split("|") if part.strip()]
        return " | ".join(parts)

    def _format_searchable_server_label(self, name: str, info: Dict[str, Any]) -> str:
        alias = self._format_alias(info.get("alias", ""))
        line = f"- {name}"
        if alias:
            line += f" (alias: {alias})"
        return line

    def _format_searchable_server_details(self, name: str, info: Dict[str, Any]) -> str:
        lines = [f"- {name}"]
        alias = self._format_alias(info.get("alias", ""))
        if alias:
            lines.append(f"  Alias: {alias}")
        description = str(info.get("description", "") or "").strip()
        if description:
            lines.append(f"  描述: {description}")
        return "\n".join(lines)

    def _create_tool_search_definition(self) -> Dict[str, Any]:
        """ tool_search description  searchable server"""
        server_lines = []
        for name, info in self._searchable_servers.items():
            server_lines.append(self._format_searchable_server_details(name, info))

        servers_list = '\n'.join(server_lines)

        description = (
            "Discover which searchable MCP server should be loaded.\n"
            "Use this tool only for tool/platform/capability discovery, not for content search.\n"
            "Use the query for platform names, tool names, or capability names.\n"
            "Do not use content keywords, people names, topics, or article titles here.\n\n"
            "Good queries:\n"
            "- xiaohongshu\n"
            "- rednote\n"
            "- github\n"
            "- pdf extraction\n\n"
            "Bad queries:\n"
            "- Lei Jun\n"
            "- Elon Musk\n"
            "- a specific article title\n\n"
            f"Available searchable MCP servers ({len(self._searchable_servers)}):\n"
            f"{servers_list}"
        )

        return {
            "type": "function",
            "function": {
                "name": "tool_search",
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": (
                                "Platform name, tool name, or capability name. "
                                "Do not pass content keywords."
                            ),
                        }
                    },
                    "required": ["query"]
                }
            }
        }

    def _execute_tool_search(self, query: str) -> str:
        """ server  self.tools"""
        if not self._bm25_index:
            return ""

        normalized_query = str(query or "").strip()
        results = self._bm25_index.search(normalized_query, top_k=2)

        if not results:
            return (
                "tool_search failed: no searchable MCP server matched this query.\n\n"
                "tool_search is for finding MCP tools, not content keywords.\n\n"
                "Please call tool_search again with an MCP tool name, not a content keyword."
            )

        loaded_info = []
        for server_name, score in results:
            server_info = self._searchable_servers.get(server_name)
            if not server_info:
                continue

            if server_name not in self._injected_servers:
                tools = server_info['tools']
                self.tools.extend(tools)
                self._injected_servers.add(server_name)

            lines = [f"Matched searchable MCP server: {server_name}"]
            alias = self._format_alias(server_info.get("alias", ""))
            if alias:
                lines.append(f"Alias: {alias}")
            description = str(server_info.get("description", "") or "").strip()
            if description:
                lines.append(f"描述: {description}")
            loaded_info.append("\n".join(lines))

        return "\n" + "\n\n".join(loaded_info) + "\n\n"

    def _load_skills(self):
        """Load skills from the single bundled skills directory."""
        print("\n  Skills...")

        self._warn_legacy_runtime_skills()

        discovered_files: List[Path] = []
        if self.skills_dir.exists():
            discovered_files = sorted(self.skills_dir.rglob("*.md"), key=lambda p: str(p).lower())

        if not discovered_files:
            print(f"   Warning: no skills found in {self.skills_dir}")
            return

        loaded_by_tool: Dict[str, Dict[str, Any]] = {}

        for md_file in discovered_files:
            try:
                skill = self._parse_skill(md_file)
                if not skill:
                    continue

                tool_name = skill['tool_name']
                loaded_by_tool[tool_name] = skill
            except Exception as e:
                print(f"   Error loading skill {md_file.name}: {e}")

        if not loaded_by_tool:
            print("   Warning: no valid skills loaded")
            return

        for skill in loaded_by_tool.values():
            self.tools.append(skill['tool_def'])
            self.tool_executors[skill['tool_name']] = skill['executor']
            print(f"   OK {skill['name']} (builtin)")

        print(f"   Skills loaded: {len(loaded_by_tool)} (dir: {self.skills_dir})")

    def _parse_skill(self, md_file: Path) -> Dict[str, Any] | None:
        """
         Skill .md 

        :
        ---
        name: skill-name
        description: Skill description
        ---
        Full content...

        Returns:
             skill 
        """
        content = md_file.read_text(encoding='utf-8')

        #  YAML frontmatter
        if not content.startswith('---'):
            return None

        #  frontmatter
        parts = content.split('---', 2)
        if len(parts) < 3:
            return None

        frontmatter = parts[1].strip()
        full_content = parts[2].strip()

        #  YAML name  description
        metadata = {}
        for line in frontmatter.split('\n'):
            if ':' in line:
                key, value = line.split(':', 1)
                metadata[key.strip()] = value.strip()

        name = metadata.get('name')
        description = metadata.get('description', '')

        if not name:
            return None

        # skill__<name>
        tool_name = f"skill__{name.replace('-', '_')}"

        # 
        tool_def = {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": ""
                        }
                    },
                    "required": ["query"]
                }
            }
        }

        # 
        def skill_executor(query: str) -> str:
            """Skill  - """
            del query
            return (
                f"=== Skill: {name} ===\n"
                f"Skill manifest file: {md_file.resolve()}\n"
                f"Skill directory: {md_file.resolve().parent}\n"
                "Resolve any relative skill file paths from Skill directory.\n\n"
                f"{full_content}"
            )

        return {
            "name": name,
            "tool_name": tool_name,
            "tool_def": tool_def,
            "executor": skill_executor,
            "file": md_file
        }

    def _apply_sandbox_constraints(self, tool_instance):
        """Inject workspace sandbox boundaries into builtin tools."""
        try:
            sandbox_root = self.runtime_root.resolve()
            resources_root = self.resources_dir.resolve()
            skills_root = self.skills_dir.resolve()
            playwright_browsers_root = self.playwright_browsers_dir.resolve()
            node_root = self.node_dir.resolve()
            python_root = self.python_dir.resolve()
            setattr(tool_instance, "sandbox_root", sandbox_root)
            setattr(tool_instance, "sandbox_read_roots", [sandbox_root, resources_root])
            setattr(
                tool_instance,
                "sandbox_write_roots",
                [sandbox_root, skills_root, playwright_browsers_root, node_root, python_root],
            )
        except Exception:
            pass

    @staticmethod
    def _discover_skill_manifests(root: Path) -> List[Path]:
        manifests: List[Path] = []
        if not root.exists() or not root.is_dir():
            return manifests

        for pattern in ("SKILL.md", "skill.md"):
            manifests.extend(root.rglob(pattern))

        deduped: Dict[str, Path] = {}
        for manifest in manifests:
            deduped[str(manifest.resolve()).lower()] = manifest
        return sorted(deduped.values(), key=lambda p: str(p).lower())

    def _warn_legacy_runtime_skills(self) -> None:
        manifests = self._discover_skill_manifests(self.legacy_runtime_skills_dir)
        if not manifests:
            return

        logger.warning(
            "Legacy runtime skills directory is deprecated and ignored: %s (%d manifest(s))",
            self.legacy_runtime_skills_dir,
            len(manifests),
        )

    # (, , )
    BUILTIN_TOOLS = [
        ("agent.tools.bash_tool", "BashTool", {"timeout": BASH_TOOL_TIMEOUT}),
        ("agent.tools.read_tool", "ReadTool", {}),
        ("agent.tools.write_tool", "WriteTool", {}),
        ("agent.tools.append_tool", "AppendTool", {}),
        ("agent.tools.edit_tool", "EditTool", {}),
        ("agent.tools.glob_tool", "GlobTool", {}),
        ("agent.tools.grep_tool", "GrepTool", {}),
        ("agent.tools.fetch_tool", "FetchTool", {}),
    ]

    def _load_builtin_tools(self):
        """"""
        print("\n  ...")

        for module_path, class_name, init_kwargs in self.BUILTIN_TOOLS:
            try:
                module = importlib.import_module(module_path)
                tool_class = getattr(module, class_name)
                tool_instance = tool_class(**init_kwargs)
                self._apply_sandbox_constraints(tool_instance)

                self.tools.append(tool_instance.get_tool_definition())
                self.tool_executors[tool_instance.name] = tool_instance.execute
                self.tool_instances[tool_instance.name] = tool_instance
                print(f"   OK {tool_instance.name.capitalize()}")
            except Exception as e:
                print(f"   Error: {class_name} : {e}")

    def execute_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """
        

        Args:
            tool_name: 
            arguments: 

        Returns:
            
        """
        # ========================================
        # 
        # ========================================
        if self.enable_permissions and self.permission_manager:
            permission = self.permission_manager.check_permission(tool_name, arguments)

            # 
            if permission == "deny":
                decision = self.permission_manager.get_last_decision()
                reason = decision.get("reason") or "This operation is blocked by permission rules"
                blocked_command = decision.get("blocked_command")
                blocked_path = decision.get("blocked_path")

                return {
                    "error": "Permission denied",
                    "tool": tool_name,
                    "reason": reason,
                    "blocked_command": blocked_command,
                    "blocked_path": blocked_path,
                }

            if permission == "ask":
                # 
                # 
                # - CLI 
                # - Web yield 
                raise PermissionRequestError(
                    tool=tool_name,
                    tool_args=arguments,
                    permission_manager=self.permission_manager
                )

        # ========================================
        # 
        # ========================================

        # Tool Search
        if tool_name == "tool_search":
            return self._execute_tool_search(arguments.get('query', ''))

        # MCP  MCPManager 
        if tool_name.startswith("mcp__"):
            manager = self.tool_executors.get('_mcp_manager')
            if manager:
                return manager.call_tool(tool_name, arguments)
            return {"error": "MCP Manager not available"}

        # Skill  query 
        if tool_name.startswith("skill__"):
            executor = self.tool_executors.get(tool_name)
            if executor:
                return executor(arguments.get('query', ''))
            return {"error": f"Skill not found: {tool_name}"}

        #  **kwargs 
        executor = self.tool_executors.get(tool_name)
        if executor:
            return executor(**arguments)

        return {"error": f"Unknown tool: {tool_name}"}

    def get_tools(self) -> List[Dict[str, Any]]:
        """"""
        return self.tools


# ============================================
# 
# ============================================

if __name__ == "__main__":
    # Add project root to path
    import sys
    project_root = Path(__file__).parent.parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

    print("=" * 70)
    print("Tool Loader Test")
    print("=" * 70)

    loader = ToolLoader()
    tools = loader.load_all()

    print("\n" + "=" * 70)
    print("Tool List")
    print("=" * 70)

    # Group by type
    mcp_tools = [t for t in tools if t['function']['name'].startswith('mcp__')]
    skill_tools = [t for t in tools if t['function']['name'].startswith('skill__')]
    builtin_tools = [t for t in tools if not t['function']['name'].startswith(('mcp__', 'skill__'))]

    if mcp_tools:
        print(f"\nMCP Tools ({len(mcp_tools)}):")
        for tool in mcp_tools[:5]:
            print(f"   - {tool['function']['name']}")
        if len(mcp_tools) > 5:
            print(f"   ... and {len(mcp_tools) - 5} more")

    if skill_tools:
        print(f"\nSkills ({len(skill_tools)}):")
        for tool in skill_tools:
            name = tool['function']['name']
            desc = tool['function']['description'][:50]
            print(f"   - {name}: {desc}...")

    if builtin_tools:
        print(f"\nBuiltin Tools ({len(builtin_tools)}):")
        for tool in builtin_tools:
            print(f"   - {tool['function']['name']}")

    print(f"\nTotal: {len(tools)} tools loaded")

