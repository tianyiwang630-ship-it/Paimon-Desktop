"""
Agent 


-  session  Agent 
- LRU  max_active 
- idle_timeout
-  MCPManager MCP 
"""

import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional

#  Python 
import sys
project_root = Path(__file__).parent.parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from agent.core.main import Agent
from agent.core.database import Database


class AgentManager:
    """Agent """

    def __init__(
        self,
        max_active: int = 10,
        idle_timeout: int = 1800,  # 30 
        mcp_manager=None,
        permission_mode: str = "auto",
    ):
        self.max_active = max_active
        self.idle_timeout = idle_timeout
        self._mcp_manager = mcp_manager
        self._permission_mode = permission_mode

        # session_id  Agent OrderedDict  LRU 
        self._agents: OrderedDict[str, Agent] = OrderedDict()
        # session_id  
        self._last_access: dict[str, float] = {}
        self._lock = threading.Lock()

        # 
        self._stop_event = threading.Event()

        # 
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop, daemon=True
        )
        self._cleanup_thread.start()

    #   

    def get_or_create(self, session_id: str, project_id: str = None) -> Agent:
        """
         Agent 

        -  LRU 
        -  max_active 
        """
        with self._lock:
            if session_id in self._agents:
                self._agents.move_to_end(session_id)
                self._last_access[session_id] = time.time()
                return self._agents[session_id]

            # 
            while len(self._agents) >= self.max_active:
                oldest_id, oldest_agent = self._agents.popitem(last=False)
                self._last_access.pop(oldest_id, None)
                self._release_agent(oldest_agent)
                print(f"  Agent LRU: {oldest_id}")

            # 
            agent = Agent(
                session_id=session_id,
                mcp_manager=self._mcp_manager,
                project_id=project_id,
                permission_mode=self._permission_mode,
            )
            self._agents[session_id] = agent
            self._last_access[session_id] = time.time()
            return agent

    def release(self, session_id: str):
        """ session  Agent """
        with self._lock:
            agent = self._agents.pop(session_id, None)
            self._last_access.pop(session_id, None)
            if agent:
                self._release_agent(agent)

    def get_agent(self, session_id: str) -> Agent:
        """ Agent  None"""
        with self._lock:
            return self._agents.get(session_id)

    def session_count(self) -> int:
        with self._lock:
            return len(self._agents)

    #   

    def _release_agent(self, agent: Agent):
        """ Agent  MCPManager"""
        try:
            #  Agent  MCPManager
            if self._mcp_manager is None:
                mcp_mgr = agent.tool_loader.tool_executors.get("_mcp_manager")
                if mcp_mgr:
                    mcp_mgr.close_all()
        except Exception:
            pass

    def _cleanup_loop(self):
        """ 60  Agent """
        while not self._stop_event.is_set():
            self._cleanup_idle()
            #  wait  sleep
            self._stop_event.wait(timeout=60)

    def _cleanup_idle(self):
        now = time.time()
        to_remove = []
        with self._lock:
            for session_id, last_time in list(self._last_access.items()):
                if now - last_time > self.idle_timeout:
                    to_remove.append(session_id)

        for session_id in to_remove:
            self.release(session_id)
            print(f"  Agent : {session_id}")

    def close_all(self):
        """"""
        # 1. 
        self._stop_event.set()
        # 2.  5 
        self._cleanup_thread.join(timeout=5)
        # 3.  Agent 
        with self._lock:
            for agent in list(self._agents.values()):
                self._release_agent(agent)
            self._agents.clear()
            self._last_access.clear()
