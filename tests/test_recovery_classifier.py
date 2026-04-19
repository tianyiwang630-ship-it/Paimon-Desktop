import sys
import types
from pathlib import Path

import httpx


if "openai" not in sys.modules:
    sys.modules["openai"] = types.SimpleNamespace(OpenAI=object)
if "tiktoken" not in sys.modules:
    sys.modules["tiktoken"] = types.SimpleNamespace(
        get_encoding=lambda _name: types.SimpleNamespace(encode=lambda text: list(str(text or "")))
    )

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

from agent.core.providers.types import NormalizedAssistantTurn
from agent.core.recovery.classifier import classify_exception, classify_turn


def test_classify_exception_detects_llm_timeout():
    issue = classify_exception(httpx.ReadTimeout("upstream timed out"))

    assert issue is not None
    assert issue.category == "llm_timeout"
    assert issue.message == "Request timed out."


def test_classify_turn_detects_fake_textual_tool_call():
    turn = NormalizedAssistantTurn(
        provider="minimax",
        visible_content="[TOOL_CALL]{\"name\":\"search\"}[/TOOL_CALL]",
        raw_content="[TOOL_CALL]{\"name\":\"search\"}[/TOOL_CALL]",
        tool_calls=[],
        protocol_flags=["fake_textual_tool_call"],
    )

    issue = classify_turn(turn)

    assert issue is not None
    assert issue.category == "tool_protocol_failure"
    assert "textual tool call" in issue.message.lower()


def test_classify_turn_ignores_normal_assistant_content():
    turn = NormalizedAssistantTurn(
        provider="openai",
        visible_content="All good",
        raw_content="All good",
        tool_calls=[],
        protocol_flags=[],
    )

    assert classify_turn(turn) is None
