import sys
import types
from pathlib import Path


if "openai" not in sys.modules:
    sys.modules["openai"] = types.SimpleNamespace(OpenAI=object)
if "tiktoken" not in sys.modules:
    sys.modules["tiktoken"] = types.SimpleNamespace(
        get_encoding=lambda _name: types.SimpleNamespace(encode=lambda text: list(str(text or "")))
    )

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

from agent.server.chat_run_state import (
    build_progress_update,
    normalize_final_status,
)
from agent.server.chat_tasks import _consume_agent_events


def test_normalize_final_status_maps_legacy_error_to_failed():
    assert normalize_final_status("error") == "failed"
    assert normalize_final_status("success") == "success"


def test_build_progress_update_marks_recovery_events_as_recovering():
    update = build_progress_update(
        "recovery",
        {
            "category": "llm_timeout",
            "message": "Request timed out. Retrying.",
        },
    )

    assert update is not None
    assert update.status == "recovering"
    assert "retry" in (update.response or "").lower()


def test_consume_agent_events_emits_failed_for_error_event():
    result = _consume_agent_events(
        "session-1",
        iter([{"type": "error", "data": "Request timed out."}]),
        [],
    )

    assert result.status == "failed"
    assert result.error == "Request timed out."


def test_consume_agent_events_reports_recovery_progress():
    seen = []

    def capture(update):
        seen.append(update)

    result = _consume_agent_events(
        "session-1",
        iter(
            [
                {
                    "type": "recovery",
                    "data": {"category": "tool_protocol_failure", "message": "Repairing malformed tool call."},
                },
                {"type": "done", "data": "All fixed now."},
            ]
        ),
        [],
        progress_callback=capture,
    )

    assert result.status == "success"
    assert result.response == "All fixed now."
    assert len(seen) == 1
    assert seen[0].status == "recovering"
