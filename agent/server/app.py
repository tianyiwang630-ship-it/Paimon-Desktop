"""
FastAPI 


  startup    DB   core MCP   AgentManager
  shutdown   Agent   MCP 
"""

import sys
import os
import logging
import threading
from pathlib import Path
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

#  Python 
asset_root = Path(__file__).parent.parent.parent
if str(asset_root) not in sys.path:
    sys.path.insert(0, str(asset_root))

# Windows  GBK emoji/Unicode  UnicodeEncodeError
#  UTF-8
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

logger = logging.getLogger("agent")
LOG_RETENTION_DAYS = 7
DEFAULT_BACKEND_HOST = "127.0.0.1"
DEFAULT_BACKEND_PORT = 8000
BACKEND_HOST_ENV_VAR = "SKILLS_MCP_BACKEND_HOST"
BACKEND_PORT_ENV_VAR = "SKILLS_MCP_BACKEND_PORT"
BACKEND_APP_ID_ENV_VAR = "SKILLS_MCP_BACKEND_APP_ID"
BACKEND_APP_VERSION_ENV_VAR = "SKILLS_MCP_BACKEND_APP_VERSION"
DEFAULT_BACKEND_APP_ID = "com.skills-mcp.desktop"
DEFAULT_BACKEND_APP_VERSION = "unknown"


def get_backend_host() -> str:
    value = (os.environ.get(BACKEND_HOST_ENV_VAR) or "").strip()
    return value or DEFAULT_BACKEND_HOST


def get_backend_port() -> int:
    raw = (os.environ.get(BACKEND_PORT_ENV_VAR) or "").strip()
    if not raw:
        return DEFAULT_BACKEND_PORT

    try:
        port = int(raw)
    except ValueError:
        logger.warning(f"Invalid {BACKEND_PORT_ENV_VAR}={raw!r}; fallback to {DEFAULT_BACKEND_PORT}")
        return DEFAULT_BACKEND_PORT

    if port <= 0 or port > 65535:
        logger.warning(f"Out-of-range {BACKEND_PORT_ENV_VAR}={raw!r}; fallback to {DEFAULT_BACKEND_PORT}")
        return DEFAULT_BACKEND_PORT

    return port


def get_backend_app_id() -> str:
    value = (os.environ.get(BACKEND_APP_ID_ENV_VAR) or "").strip()
    return value or DEFAULT_BACKEND_APP_ID


def get_backend_app_version() -> str:
    value = (os.environ.get(BACKEND_APP_VERSION_ENV_VAR) or "").strip()
    return value or DEFAULT_BACKEND_APP_VERSION


BACKEND_HOST = get_backend_host()
BACKEND_PORT = get_backend_port()
BACKEND_ORIGIN = f"http://{BACKEND_HOST}:{BACKEND_PORT}"
BACKEND_APP_ID = get_backend_app_id()
BACKEND_APP_VERSION = get_backend_app_version()


def cleanup_old_logs(log_dir: Path, retention_days: int = LOG_RETENTION_DAYS):
    """Delete log files older than retention period."""
    cutoff = datetime.now() - timedelta(days=retention_days)
    for entry in log_dir.iterdir():
        if not entry.is_file():
            continue
        try:
            mtime = datetime.fromtimestamp(entry.stat().st_mtime)
            if mtime < cutoff:
                entry.unlink(missing_ok=True)
        except Exception as e:
            logger.warning(f"Failed to cleanup log file {entry}: {e}")

from agent.core.database import Database
from agent.core.paths import get_asset_root, get_runtime_root
from agent.server.agent_manager import AgentManager
from agent.server.chat_tasks import ChatTaskManager
from agent.server.routes import sessions, chat, settings, files, projects, permissions, meta

runtime_root = get_runtime_root()
logs_dir = runtime_root / "workspace" / "logs"
logs_dir.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),  # 
        logging.FileHandler(logs_dir / "agent.log", encoding="utf-8"),  # 
    ],
)


#   

@asynccontextmanager
async def lifespan(app: FastAPI):
    """startup / shutdown """
    #  startup 
    logger.info("...")

    # Cleanup old logs on startup and periodically in background.
    cleanup_old_logs(logs_dir, LOG_RETENTION_DAYS)
    log_cleanup_stop = threading.Event()

    def _log_cleanup_loop():
        while not log_cleanup_stop.wait(timeout=3600):
            cleanup_old_logs(logs_dir, LOG_RETENTION_DAYS)

    log_cleanup_thread = threading.Thread(target=_log_cleanup_loop, daemon=True)
    log_cleanup_thread.start()

    # 1. 
    db = Database()
    app.state.db = db
    logger.info("")

    # 2.  core MCP searchable  Agent 
    mcp_manager = None
    try:
        from agent.tools.mcp_manager import MCPManager
        from agent.core.tool_loader import ToolLoader

        #  registry  core / searchable
        registry = ToolLoader._load_registry_static(get_asset_root())

        mcp_servers_dir = str(get_asset_root() / "mcp-servers")
        mcp_manager = MCPManager(
            servers_dir=mcp_servers_dir,
            auto_discover=True,
            connect_core_only=True,
            registry=registry,
        )
        logger.info("core MCP ")
    except Exception as e:
        logger.warning(f"MCP : {e}")

    # 3.  AgentManager
    agent_manager = AgentManager(
        max_active=10,
        idle_timeout=1800,
        mcp_manager=mcp_manager,
        permission_mode="auto",
    )
    chat_task_manager = ChatTaskManager(agent_manager=agent_manager)
    app.state.agent_manager = agent_manager
    app.state.chat_task_manager = chat_task_manager
    app.state.mcp_manager = mcp_manager
    logger.info("AgentManager ")
    logger.info(f" {BACKEND_ORIGIN}")
    logger.info(f": {logs_dir / 'agent.log'}")

    yield  # 

    #  shutdown 
    logger.info("...")
    log_cleanup_stop.set()
    log_cleanup_thread.join(timeout=2)
    chat_task_manager.close()
    agent_manager.close_all()
    if mcp_manager:
        try:
            mcp_manager.close_all()
        except Exception:
            pass
    logger.info("")


#   

app = FastAPI(
    title="Skills-MCP Agent API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#   

app.include_router(projects.router)
app.include_router(sessions.router)
app.include_router(chat.router)
app.include_router(settings.router)
app.include_router(files.router)
app.include_router(permissions.router)
app.include_router(meta.router)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "app_id": BACKEND_APP_ID,
        "app_version": BACKEND_APP_VERSION,
    }


#   

if __name__ == "__main__":
    uvicorn.run(
        "agent.server.app:app",
        host=BACKEND_HOST,
        port=BACKEND_PORT,
        reload=False,
    )
