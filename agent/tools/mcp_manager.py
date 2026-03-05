"""
MCP Manager -  FastMCP  MCP servers


-  MCP 
- 
-  STDIO  HTTP 
- STDIO wrapper  JSON-RPC 
"""

import asyncio
import json
import threading
import sys
import os
from pathlib import Path
from typing import Dict, List, Any

try:
    from fastmcp import Client
    FASTMCP_AVAILABLE = True
except ImportError:
    FASTMCP_AVAILABLE = False
    print("  fastmcp : pip install fastmcp")

from agent.discovery.mcp_scanner import MCPScanner


class MCPManager:
    """MCP  - """

    def __init__(
        self,
        servers_dir: str = "mcp-servers",
        auto_discover: bool = True,
        connect_core_only: bool = False,
        registry: dict = None,
    ):
        """
         MCP Manager

        Args:
            servers_dir:       MCP 
            auto_discover:     
            connect_core_only: True   core 
                               False  
            registry:          registry.json connect_core_only=True 
        """
        if not FASTMCP_AVAILABLE:
            raise ImportError("fastmcp ")

        self.servers_dir = servers_dir
        self.scanner = MCPScanner(servers_dir)
        self.servers = {}  # server 
        self._registry = registry or {}  # {server_name: {"category": "core"|"searchable"}}

        # 
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()

        # 
        self._clients = {}      # server_name -> Client 
        self._connected = {}    # server_name ->  Clientasync with 
        self._all_discovered = {}  #  searchable

        if auto_discover:
            if connect_core_only:
                self.discover_and_connect_core()
            else:
                self.discover_and_connect()

    def _run_coro(self, coro, timeout=60):
        """"""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    # ==========================================
    # 
    # ==========================================

    def discover_and_connect(self):
        """ MCP servers"""
        print("\n  MCP servers...")

        discovered = self.scanner.scan()
        if not discovered:
            print("   MCP servers")
            print(f"  MCP server  {self.servers_dir}/ ")
            return

        self._all_discovered = discovered
        self.scanner.save_config(discovered)

        print("\n  MCP servers...")
        for server_name, config in discovered.items():
            self._create_client(server_name, config)

        self._run_coro(self._connect_all(), timeout=120)

        connected = len(self._connected)
        total = len(self._clients)
        print(f"\n  {connected}/{total}  servers")

    def discover_and_connect_core(self):
        """
         core  MCP 
        searchable 
        """
        print("\n  MCP serverscore ...")

        discovered = self.scanner.scan()
        if not discovered:
            print("   MCP servers")
            return

        self._all_discovered = discovered
        self.scanner.save_config(discovered)

        core_servers = {}
        for server_name, config in discovered.items():
            entry = self._registry.get(server_name, {})
            category = entry.get("category", "searchable")
            if category == "core":
                core_servers[server_name] = config
            else:
                # searchable
                self.servers[server_name] = {
                    "config": config,
                    "status": "pending",
                    "tools": []
                }

        if core_servers:
            print("\n  core MCP servers...")
            for server_name, config in core_servers.items():
                self._create_client(server_name, config)
            self._run_coro(self._connect_all(), timeout=120)
        else:
            print("   ( core )")

        connected = len(self._connected)
        print(f"\n core : {connected} ")
        searchable_count = sum(
            1 for s in self.servers.values() if s.get("status") == "pending"
        )
        if searchable_count:
            print(f"   {searchable_count}  searchable ")

    def connect_server(self, server_name: str) -> bool:
        """
         searchable 

        Args:
            server_name: 

        Returns:
            True False 
        """
        if server_name in self._connected:
            return True  # 

        config = None
        if server_name in self._all_discovered:
            config = self._all_discovered[server_name]
        elif server_name in self.servers:
            config = self.servers[server_name].get("config")

        if not config:
            print(f"   : {server_name}")
            return False

        print(f"\n : {server_name}...")
        self._create_client(server_name, config)
        if server_name in self._clients:
            self._run_coro(self._connect_one_by_name(server_name), timeout=60)
            return server_name in self._connected
        return False

    async def _connect_one_by_name(self, server_name: str):
        """ client"""
        client = self._clients.get(server_name)
        if not client:
            return
        try:
            connected = await client.__aenter__()
            self._connected[server_name] = connected
            self.servers[server_name]["status"] = "connected"
            print(f"   {server_name} ")
        except Exception as e:
            self.servers[server_name]["status"] = "failed"
            self.servers[server_name]["error"] = str(e)
            print(f"   {server_name}: {e}")

    def _get_wrapper_path(self) -> str:
        """ stdio_wrapper.py """
        wrapper = Path(__file__).parent / "stdio_wrapper.py"
        return str(wrapper.resolve())

    def _create_client(self, server_name: str, config: Dict[str, Any]):
        """ FastMCP Client 

        STDIO  stdio_wrapper.py 
         JSON-RPC  stdout 
         MCP server 
        """
        try:
            server_type = config.get('type', 'stdio')

            if server_type == 'http':
                url = config['url']
                client = Client(url)
            else:
                # STDIO:  wrapper  stdout
                wrapper_path = self._get_wrapper_path()
                original_command = config['command']
                original_args = config.get('args', [])

                server_config = {
                    # Use the current interpreter to avoid relying on system "python" in PATH.
                    'command': sys.executable or 'python',
                    'args': [wrapper_path, original_command] + original_args,
                }
                merged_env = dict(os.environ)
                merged_env.update(config.get('env', {}))
                server_config['env'] = merged_env
                if config.get('cwd'):
                    server_config['cwd'] = config['cwd']

                wrapped_config = {
                    'mcpServers': {
                        server_name: server_config
                    }
                }
                client = Client(wrapped_config)

            self._clients[server_name] = client
            self.servers[server_name] = {
                'config': config,
                'status': 'pending',
                'tools': []
            }

        except Exception as e:
            self.servers[server_name] = {
                'config': config,
                'status': 'failed',
                'error': str(e)
            }
            print(f"   {server_name}: {e}")

    async def _connect_all(self):
        """ clients"""

        async def _connect_one(name, client):
            try:
                connected = await client.__aenter__()
                self._connected[name] = connected
                self.servers[name]['status'] = 'connected'
                server_type = self.servers[name]['config'].get('type', 'stdio')
                print(f"   {name} ({server_type})")
            except Exception as e:
                self.servers[name]['status'] = 'failed'
                self.servers[name]['error'] = str(e)
                print(f"   {name}: {e}")

        await asyncio.gather(*(
            _connect_one(name, client)
            for name, client in self._clients.items()
        ))

    # ==========================================
    # 
    # ==========================================

    def get_all_tools(self) -> List[Dict[str, Any]]:
        """ MCP OpenAI function calling """
        try:
            tools = self._run_coro(self._async_get_all_tools())
            print(f"\n : {len(tools)}")
            return tools
        except Exception as e:
            print(f" : {e}")
            import traceback
            traceback.print_exc()
            return []

    async def _async_get_all_tools(self) -> List[Dict[str, Any]]:
        """"""
        all_tools = []
        for server_name, client in self._connected.items():
            try:
                tools = await client.list_tools()
                for tool in tools:
                    tool_name = f"mcp__{server_name}__{tool.name}"
                    tool_def = {
                        'type': 'function',
                        'function': {
                            'name': tool_name,
                            'description': tool.description or '',
                            'parameters': tool.inputSchema or {
                                'type': 'object',
                                'properties': {}
                            }
                        }
                    }
                    all_tools.append(tool_def)
            except Exception as e:
                print(f"    {server_name} : {e}")
        return all_tools

    def get_tools_by_server(self) -> Dict[str, Dict[str, Any]]:
        """
         server  server 

        Returns:
            {server_name: {description, tools: [tool_def...]}}
        """
        try:
            return self._run_coro(self._async_get_tools_by_server())
        except Exception as e:
            print(f" : {e}")
            import traceback
            traceback.print_exc()
            return {}

    async def _async_get_tools_by_server(self) -> Dict[str, Dict[str, Any]]:
        """ server  pending """
        result = {}

        #  1.  
        for server_name, client in self._connected.items():
            server_info = self.servers.get(server_name, {})
            config = server_info.get('config', {})

            tools_list = []
            try:
                tools = await client.list_tools()
                for tool in tools:
                    tool_name = f"mcp__{server_name}__{tool.name}"
                    tool_def = {
                        'type': 'function',
                        'function': {
                            'name': tool_name,
                            'description': tool.description or '',
                            'parameters': tool.inputSchema or {
                                'type': 'object',
                                'properties': {}
                            }
                        }
                    }
                    tools_list.append(tool_def)
            except Exception as e:
                print(f"    {server_name} : {e}")

            result[server_name] = {
                'description': config.get('description', ''),
                'tools': tools_list
            }

        #  2. pending  
        #  connect_core_only=True  searchable  tool_search 
        pending = [
            (name, info) for name, info in self.servers.items()
            if info.get('status') == 'pending' and name not in result
        ]

        if pending:
            async def _connect_and_list(name, info):
                config = info.get('config')
                if not config:
                    return
                if name not in self._clients:
                    self._create_client(name, config)
                client = self._clients.get(name)
                if not client:
                    return
                try:
                    connected = await client.__aenter__()
                    self._connected[name] = connected
                    self.servers[name]['status'] = 'connected'

                    tools = await connected.list_tools()
                    tools_list = []
                    for tool in tools:
                        tool_name = f"mcp__{name}__{tool.name}"
                        tool_def = {
                            'type': 'function',
                            'function': {
                                'name': tool_name,
                                'description': tool.description or '',
                                'parameters': tool.inputSchema or {
                                    'type': 'object',
                                    'properties': {}
                                }
                            }
                        }
                        tools_list.append(tool_def)

                    result[name] = {
                        'description': config.get('description', ''),
                        'tools': tools_list
                    }
                    print(f"   {name} (on-demand, {len(tools_list)} tools)")
                except Exception as e:
                    self.servers[name]['status'] = 'failed'
                    self.servers[name]['error'] = str(e)
                    print(f"   {name}: {e}")

            await asyncio.gather(*[_connect_and_list(n, i) for n, i in pending])

        total = sum(len(s['tools']) for s in result.values())
        print(f"\n : {total}{len(result)}  servers")
        return result

    def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """ MCP """
        try:
            # : mcp__<server>__<tool_name>
            if not tool_name.startswith('mcp__'):
                return {'error': f'Invalid MCP tool name: {tool_name}'}

            parts = tool_name.split('__')
            if len(parts) < 3:
                return {'error': f'Invalid MCP tool name format: {tool_name}'}

            server_name = parts[1]
            actual_tool_name = '__'.join(parts[2:])

            client = self._connected.get(server_name)
            if not client:
                # searchable 
                if self.connect_server(server_name):
                    client = self._connected.get(server_name)
                if not client:
                    return {'error': f'Server not connected: {server_name}'}

            # 
            result = self._run_coro(
                client.call_tool(actual_tool_name, arguments),
                timeout=120
            )

            # 
            if hasattr(result, 'content'):
                content_parts = []
                for item in result.content:
                    if hasattr(item, 'text'):
                        content_parts.append(item.text)
                return '\n'.join(content_parts) if content_parts else str(result)
            else:
                return str(result)

        except Exception as e:
            import traceback
            import re
            #  ANSI Playwright  LLM API 
            error_msg = re.sub(r'\x1b\[[0-9;]*m', '', str(e))
            #  traceback  LLM token +  API 
            traceback.print_exc()  # 
            return {
                'error': error_msg,
                'tool': tool_name
            }

    # ==========================================
    # 
    # ==========================================

    def get_server_status(self) -> Dict[str, Any]:
        """ server """
        return {
            'total': len(self.servers),
            'connected': len(self._connected),
            'failed': len([s for s in self.servers.values() if s['status'] == 'failed']),
            'servers': self.servers
        }

    def reload(self):
        """"""
        print("\n  MCP servers...")
        self.close_all()
        self._clients = {}
        self._connected = {}
        self.servers = {}
        self.discover_and_connect()

    def close_all(self):
        """"""
        async def _close():
            for _, client in list(self._connected.items()):
                try:
                    await asyncio.wait_for(
                        client.__aexit__(None, None, None),
                        timeout=3
                    )
                except Exception:
                    pass
            self._connected.clear()

        try:
            self._run_coro(_close(), timeout=5)
        except Exception:
            pass

        # 
        try:
            self._loop.call_soon_threadsafe(self._loop.stop)
        except Exception:
            pass
        print("  MCP ")

    def __del__(self):
        """"""
        try:
            if self._connected:
                self.close_all()
            else:
                self._loop.call_soon_threadsafe(self._loop.stop)
        except Exception:
            pass


# 
if __name__ == "__main__":
    manager = MCPManager()

    status = manager.get_server_status()
    print(f"\n :")
    print(f"  : {status['total']}")
    print(f"  : {status['connected']}")
    print(f"  : {status['failed']}")

    tools = manager.get_all_tools()
    if tools:
        print(f"\n :")
        for tool in tools[:5]:
            print(f"  - {tool['function']['name']}: {tool['function']['description']}")
        if len(tools) > 5:
            print(f"  ...  {len(tools) - 5} ")
