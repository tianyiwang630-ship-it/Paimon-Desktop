import json


def test_chat_debug_logger_is_disabled_by_default(monkeypatch, tmp_path):
    from agent.server import chat_debug

    monkeypatch.delenv("PAIMON_DEBUG_CHAT", raising=False)
    monkeypatch.setattr(chat_debug, "get_runtime_root", lambda: tmp_path)

    wrote = chat_debug.write_chat_debug_event(
        "chat_send_start",
        layer="frontend",
        session_id="session-1",
        data={"message": "hello"},
    )

    assert wrote is False
    assert not (tmp_path / "workspace" / "logs" / "chat-debug.log").exists()


def test_chat_debug_logger_redacts_and_truncates_when_enabled(monkeypatch, tmp_path):
    from agent.server import chat_debug

    monkeypatch.setenv("PAIMON_DEBUG_CHAT", "1")
    monkeypatch.setattr(chat_debug, "get_runtime_root", lambda: tmp_path)

    wrote = chat_debug.write_chat_debug_event(
        "llm_request_error",
        layer="backend",
        session_id="session-1",
        project_id="project-1",
        api_key="secret-key",
        data={
            "authorization": "Bearer secret-token",
            "message": "x" * 400,
            "nested": {"password": "secret-password"},
        },
    )

    assert wrote is True
    log_path = tmp_path / "workspace" / "logs" / "chat-debug.log"
    payload = json.loads(log_path.read_text(encoding="utf-8").strip())

    assert payload["event"] == "llm_request_error"
    assert payload["layer"] == "backend"
    assert payload["session_id"] == "session-1"
    assert payload["project_id"] == "project-1"
    assert payload["api_key"] == "[redacted]"
    assert payload["data"]["authorization"] == "[redacted]"
    assert payload["data"]["nested"]["password"] == "[redacted]"
    assert payload["data"]["message"].endswith("... [truncated]")
