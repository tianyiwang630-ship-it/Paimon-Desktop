"""Agent manager for cached session agents."""

import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import sys

project_root = Path(__file__).parent.parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from agent.core.main import Agent


class AgentManager:
    """Keep per-session Agent instances with bounded cache and idle cleanup."""

    def __init__(
        self,
        max_active: int = 10,
        idle_timeout: int = 1800,
        mcp_manager=None,
        permission_mode: str = "auto",
    ):
        self.max_active = max_active
        self.idle_timeout = idle_timeout
        self._mcp_manager = mcp_manager
        self._permission_mode = permission_mode

        self._agents: OrderedDict[str, Agent] = OrderedDict()
        self._last_access: dict[str, float] = {}
        self._lock = threading.Lock()
        self._stop_event = threading.Event()

        self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        self._cleanup_thread.start()

    def _is_agent_running(self, agent: Agent) -> bool:
        lock = getattr(agent, "_execution_lock", None)
        if lock is None:
            return False
        try:
            return bool(lock.locked())
        except Exception:
            return False

    def get_or_create(self, session_id: str, project_id: Optional[str] = None) -> Agent:
        """Get existing session agent or create one."""
        with self._lock:
            existing = self._agents.get(session_id)
            if existing is not None:
                self._agents.move_to_end(session_id)
                self._last_access[session_id] = time.time()
                return existing

            while len(self._agents) >= self.max_active:
                evict_id: Optional[str] = None
                for sid, candidate in self._agents.items():
                    if not self._is_agent_running(candidate):
                        evict_id = sid
                        break

                if evict_id is None:
                    # Avoid killing active work. Allow temporary overflow.
                    print("AgentManager: all cached agents are running; allowing temporary overflow.")
                    break

                oldest_agent = self._agents.pop(evict_id)
                self._last_access.pop(evict_id, None)
                self._release_agent(oldest_agent)
                print(f"Released idle agent via LRU: {evict_id}")

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
        """Release a session agent from memory."""
        with self._lock:
            agent = self._agents.pop(session_id, None)
            self._last_access.pop(session_id, None)
            if agent:
                self._release_agent(agent)

    def get_agent(self, session_id: str) -> Optional[Agent]:
        """Get session agent if loaded."""
        with self._lock:
            agent = self._agents.get(session_id)
            if agent is not None:
                self._last_access[session_id] = time.time()
            return agent

    def session_count(self) -> int:
        with self._lock:
            return len(self._agents)

    def _release_agent(self, agent: Agent):
        """Release resources owned by an agent if needed."""
        try:
            if self._mcp_manager is None:
                mcp_mgr = agent.tool_loader.tool_executors.get("_mcp_manager")
                if mcp_mgr:
                    mcp_mgr.close_all()
        except Exception:
            pass

    def _cleanup_loop(self):
        while not self._stop_event.is_set():
            self._cleanup_idle()
            self._stop_event.wait(timeout=60)

    def _cleanup_idle(self):
        now = time.time()
        to_remove: list[str] = []
        with self._lock:
            for session_id, last_time in list(self._last_access.items()):
                agent = self._agents.get(session_id)
                if agent is not None and self._is_agent_running(agent):
                    # Keep active sessions warm and skip idle cleanup while running.
                    self._last_access[session_id] = now
                    continue
                if now - last_time > self.idle_timeout:
                    to_remove.append(session_id)

        for session_id in to_remove:
            self.release(session_id)
            print(f"Released idle agent: {session_id}")

    def close_all(self):
        """Stop cleanup thread and release all cached agents."""
        self._stop_event.set()
        self._cleanup_thread.join(timeout=5)

        with self._lock:
            for agent in list(self._agents.values()):
                self._release_agent(agent)
            self._agents.clear()
            self._last_access.clear()
