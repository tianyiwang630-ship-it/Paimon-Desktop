from __future__ import annotations

from typing import Optional

from agent.core.providers.types import NormalizedAssistantTurn
from agent.core.recovery.types import RecoveryIssue


_TIMEOUT_CLASS_NAME_HINTS = (
    "timeout",
    "timedout",
)


def _exception_name(exc: Exception) -> str:
    return f"{exc.__class__.__module__}.{exc.__class__.__name__}".lower()


def _exception_text(exc: Exception) -> str:
    return str(exc or "").strip().lower()


def is_timeout_exception(exc: Exception) -> bool:
    name = _exception_name(exc)
    text = _exception_text(exc)
    if any(hint in name for hint in _TIMEOUT_CLASS_NAME_HINTS):
        return True
    return "timed out" in text or "timeout" in text


def classify_exception(exc: Exception) -> Optional[RecoveryIssue]:
    if is_timeout_exception(exc):
        return RecoveryIssue(
            category="llm_timeout",
            message="Request timed out.",
            detail=str(exc or "").strip() or None,
        )
    return None


def classify_turn(turn: NormalizedAssistantTurn) -> Optional[RecoveryIssue]:
    protocol_flags = set(turn.protocol_flags or [])
    if "fake_textual_tool_call" in protocol_flags and not (turn.tool_calls or []):
        return RecoveryIssue(
            category="tool_protocol_failure",
            message="Provider returned a textual tool call instead of structured tool_calls.",
            detail=(turn.raw_content or turn.visible_content or "").strip() or None,
        )
    return None
