"""
MCP Scanner -  MCP servers
"""

import json
from pathlib import Path
from typing import Dict, Any


class MCPScanner:
    """ mcp-servers  MCP server"""

    def __init__(self, servers_dir: str = "mcp-servers"):
        self.servers_dir = Path(servers_dir)
        self.servers_dir.mkdir(exist_ok=True)

    def scan(self) -> Dict[str, Dict[str, Any]]:
        """
         MCP server 

        Returns:
            {server_name: server_config}
        """
        discovered_servers = {}

        if not self.servers_dir.exists():
            print(f"  : {self.servers_dir}")
            return discovered_servers

        for server_dir in self.servers_dir.iterdir():
            if not server_dir.is_dir() or server_dir.name.startswith('.'):
                continue

            server_name = server_dir.name
            config = self._detect_server_type(server_dir)

            if config:
                discovered_servers[server_name] = config
                print(f"  MCP server: {server_name} ({config.get('type', 'unknown')})")
            else:
                print(f"  : {server_name}")

        return discovered_servers

    def _detect_server_type(self, server_dir: Path) -> Dict[str, Any] | None:
        """
         server 

        :
        1. mcp.config.json ()
        2. package.json (Node.js)
        3. pyproject.toml (Python)
        4. 
        """

        # 1. 
        config_file = server_dir / "mcp.config.json"
        if config_file.exists():
            return self._load_custom_config(config_file)

        # 2.  Node.js 
        package_json = server_dir / "package.json"
        if package_json.exists():
            return self._detect_nodejs_server(package_json, server_dir)

        # 3.  Python 
        pyproject_toml = server_dir / "pyproject.toml"
        if pyproject_toml.exists():
            return self._detect_python_server(pyproject_toml, server_dir)

        # 4. 
        return self._detect_executable_server(server_dir)

    def _load_custom_config(self, config_file: Path) -> Dict[str, Any] | None:
        """ mcp.config.json Claude Desktop """
        try:
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)

            #  Claude Desktop 
            if 'mcpServers' in config:
                #  server 
                servers = config['mcpServers']
                if not servers:
                    print(f"   mcpServers : {config_file.parent.name}")
                    return None

                #  server
                server_name = list(servers.keys())[0]
                server_config = servers[server_name]

                print(f"    Claude Desktop  server: {server_name}")

                # 
                config = {
                    'enabled': True,  # 
                    'type': 'stdio',  #  stdio server_config  type 
                    **server_config   #  server 
                }

            # 
            if not config.get('enabled', True):
                print(f"    : {config_file.parent.name}")
                return None

            server_type = config.get('type', 'stdio')

            # 
            if server_type == 'http':
                # HTTP  url  headers
                if 'url' not in config:
                    print(f"   HTTP  url: {config_file.parent.name}")
                    return None

                return {
                    'type': 'http',
                    'url': config['url'],
                    'headers': config.get('headers', {}),
                    'description': config.get('description', ''),
                    'auto_start': config.get('auto_start', {}),  #  auto_start 
                    'source': 'custom'
                }
            else:
                # stdio  command
                if 'command' not in config:
                    print(f"   stdio  command: {config_file.parent.name}")
                    return None

                return {
                    'type': 'stdio',
                    'command': config['command'],
                    'args': config.get('args', []),
                    'env': config.get('env', {}),
                    'cwd': str(config_file.parent.resolve()),
                    'description': config.get('description', ''),
                    'source': 'custom'
                }
        except Exception as e:
            print(f"   : {e}")
            return None

    def _detect_nodejs_server(self, package_json: Path, server_dir: Path) -> Dict[str, Any] | None:
        """ Node.js MCP server"""
        try:
            with open(package_json, 'r', encoding='utf-8') as f:
                pkg = json.load(f)

            #  MCP server
            keywords = pkg.get('keywords', [])
            if 'mcp' not in keywords and 'mcp-server' not in keywords:
                #  dependencies
                deps = {**pkg.get('dependencies', {}), **pkg.get('devDependencies', {})}
                if not any('mcp' in dep.lower() for dep in deps.keys()):
                    return None

            package_name = pkg.get('name', server_dir.name)

            return {
                'type': 'stdio',
                'command': 'npx',
                'args': ['-y', package_name],
                'env': {},
                'description': pkg.get('description', ''),
                'source': 'nodejs',
                'version': pkg.get('version', 'unknown')
            }
        except Exception as e:
            print(f"   Node.js : {e}")
            return None

    def _detect_python_server(self, pyproject_toml: Path, server_dir: Path) -> Dict[str, Any] | None:
        """ Python MCP server"""
        try:
            #  toml 
            content = pyproject_toml.read_text(encoding='utf-8')

            #  mcp 
            if 'mcp' not in content.lower():
                return None

            # 
            package_name = server_dir.name

            return {
                'type': 'stdio',
                'command': 'uvx',
                'args': [package_name],
                'env': {},
                'description': f'Python MCP server: {package_name}',
                'source': 'python'
            }
        except Exception as e:
            print(f"   Python : {e}")
            return None

    def _detect_executable_server(self, server_dir: Path) -> Dict[str, Any] | None:
        """"""
        # 
        for pattern in ['mcp-server*', 'server*', '*.exe']:
            for exe_file in server_dir.glob(pattern):
                if exe_file.is_file() and (exe_file.suffix in ['.exe', ''] or exe_file.stat().st_mode & 0o111):
                    return {
                        'type': 'stdio',
                        'command': str(exe_file),
                        'args': [],
                        'env': {},
                        'description': f'Executable MCP server: {exe_file.name}',
                        'source': 'executable'
                    }

        return None

    def save_config(self, servers: Dict[str, Dict[str, Any]], output_file: str = ".auto-config.json"):
        """


         MCP server 
        """
        saved_configs = []
        failed_configs = []

        for server_name, server_config in servers.items():
            #  server
            config = {
                "_comment": " MCP Scanner ",
                "name": server_name,
                **server_config
            }

            #  server 
            server_dir = self.servers_dir / server_name
            config_path = server_dir / "auto-config.json"

            try:
                server_dir.mkdir(parents=True, exist_ok=True)
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(config, f, indent=2, ensure_ascii=False)
                saved_configs.append(str(config_path))
            except Exception as e:
                failed_configs.append((str(config_path), str(e)))

        if saved_configs:
            print(f"\n :")
            for path in saved_configs:
                print(f"   - {path}")

        if failed_configs:
            print("\n  Warning: failed to write auto-config files:")
            for path, error in failed_configs:
                print(f"   - {path}: {error}")

        return saved_configs


if __name__ == "__main__":
    # 
    scanner = MCPScanner()
    servers = scanner.scan()

    if servers:
        scanner.save_config(servers)
        print(f"\n  {len(servers)}  MCP servers")
    else:
        print("\n   MCP servers")
        print(" MCP server  mcp-servers/ ")
