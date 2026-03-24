import asyncio
import sys
import types
from types import SimpleNamespace


if "openai" not in sys.modules:
    sys.modules["openai"] = types.SimpleNamespace(OpenAI=object)

from agent.server.chat_tasks import execute_chat_request, execute_pending_permission_request
from agent.server.models import ChatRequest
from agent.server.routes import permissions


class _EventIterator:
    def __init__(self, events):
        self._events = list(events)

    def __iter__(self):
        return iter(self._events)

    def close(self):
        return None


class _PermissionManagerStub:
    def __init__(self):
        self.pending_allow_once = set()
        self.session_denied = set()
        self.session_allowed_tools = set()
        self.mode = "ask"

    def _get_signature(self, tool, args):
        return f"{tool}:{args.get('command', '')}"

    def is_delete_request(self, tool, args):
        return "rm " in str((args or {}).get("command", ""))

    def allow_tool_for_session(self, tool):
        self.session_allowed_tools.add(tool)
        return tool


class _AgentStub:
    def __init__(self):
        self.history = []
        self.tool_loader = SimpleNamespace(permission_manager=_PermissionManagerStub())
        self.pending = {
            "request_id": "pending-1",
            "tool": "bash",
            "args": {"command": 'rm -rf "temp/agent-loop"'},
            "tool_call_id": "tool-1",
            "decision_action": None,
            "decision_extra_instruction": "",
        }
        self.recorded_decisions = []

    def run_events_locked(self, user_input, resume=False, user_persisted=False):
        return _EventIterator(
            [
                {
                    "type": "permission_request",
                    "data": {
                        "tool": "bash",
                        "args": {"command": 'rm -rf "temp/agent-loop"'},
                        "tool_call_id": "tool-1",
                        "pending_request_id": "pending-1",
                    },
                }
            ]
        )

    def run_pending_tool_events_locked(self, pending_request_id):
        assert pending_request_id == "pending-1"
        return _EventIterator([{"type": "done", "data": "finished"}])

    def get_pending_tool_request(self, pending_request_id):
        if pending_request_id != self.pending["request_id"]:
            return None
        return dict(self.pending)

    def record_pending_permission_decision(self, pending_request_id, action, extra_instruction=""):
        if pending_request_id != self.pending["request_id"]:
            raise KeyError(pending_request_id)
        self.pending["decision_action"] = action
        self.pending["decision_extra_instruction"] = extra_instruction
        self.recorded_decisions.append((action, extra_instruction))
        return dict(self.pending)

    def link_pending_tool_request_task(self, pending_request_id, chat_request_id):
        if pending_request_id != self.pending["request_id"]:
            raise KeyError(pending_request_id)
        self.pending["chat_request_id"] = chat_request_id
        return dict(self.pending)


class _AgentManagerStub:
    def __init__(self, agent):
        self.agent = agent

    def get_or_create(self, session_id, project_id=None):
        return self.agent

    def get_agent(self, session_id):
        return self.agent


class _ChatTaskManagerStub:
    def __init__(self):
        self.calls = []

    def start_pending_permission_task(self, session_id, pending_request_id):
        self.calls.append((session_id, pending_request_id))
        return SimpleNamespace(request_id="task-1", session_id=session_id)


def test_execute_chat_request_includes_pending_request_metadata():
    agent = _AgentStub()
    manager = _AgentManagerStub(agent)

    result = execute_chat_request(
        manager,
        ChatRequest(session_id="session-1", message="delete folder"),
    )

    assert result.status == "permission_required"
    assert result.permission_detail == {
        "code": "permission_required",
        "session_id": "session-1",
        "tool": "bash",
        "args": {"command": 'rm -rf "temp/agent-loop"'},
        "tool_call_id": "tool-1",
        "pending_request_id": "pending-1",
        "message": "Permission confirmation required",
    }


def test_execute_pending_permission_request_consumes_pending_tool_run():
    agent = _AgentStub()
    manager = _AgentManagerStub(agent)

    result = execute_pending_permission_request(manager, "session-1", "pending-1")

    assert result.status == "success"
    assert result.response == "finished"


def test_permission_routes_confirm_then_execute_pending_request():
    agent = _AgentStub()
    chat_task_manager = _ChatTaskManagerStub()

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                agent_manager=_AgentManagerStub(agent),
                chat_task_manager=chat_task_manager,
            )
        )
    )

    confirm_response = asyncio.run(
        permissions.confirm_permission(
            SimpleNamespace(
                session_id="session-1",
                pending_request_id="pending-1",
                tool="bash",
                args={"command": 'rm -rf "temp/agent-loop"'},
                action="allow_once",
                extra_instruction=None,
            ),
            request,
        )
    )

    assert confirm_response.success is True
    assert confirm_response.requires_execution is True
    assert agent.recorded_decisions == [("allow_once", "")]

    execute_response = asyncio.run(
        permissions.execute_pending_permission(
            SimpleNamespace(
                session_id="session-1",
                pending_request_id="pending-1",
            ),
            request,
        )
    )

    assert execute_response.request_id == "task-1"
    assert execute_response.session_id == "session-1"
    assert chat_task_manager.calls == [("session-1", "pending-1")]
