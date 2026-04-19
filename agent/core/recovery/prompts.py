from __future__ import annotations

from agent.core.providers.types import NormalizedAssistantTurn
from agent.core.recovery.types import RecoveryIssue


def build_recovery_prompt(issue: RecoveryIssue, turn: NormalizedAssistantTurn | None = None) -> str:
    if issue.category == "tool_protocol_failure":
        broken_preview = ""
        if turn is not None:
            broken_preview = (turn.raw_content or turn.visible_content or "").strip()
        preview_line = f"\nPrevious malformed output:\n{broken_preview[:1200]}" if broken_preview else ""
        return (
            "Your previous response attempted a tool call in plain text instead of using the provider's "
            "structured tool_call field. Retry now. If you need a tool, emit a real structured tool call only. "
            "Do not wrap tool instructions in tags like [TOOL_CALL], XML, or markdown."
            f"{preview_line}"
        )
    return "Continue the task. If you need tools, use the provider's structured tool calling format exactly."
