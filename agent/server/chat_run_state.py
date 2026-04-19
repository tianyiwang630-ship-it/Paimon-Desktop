from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


ACTIVE_CHAT_RUN_STATUSES = {"running", "recovering"}


@dataclass(frozen=True)
class ChatTaskProgressUpdate:
    status: str
    response: Optional[str] = None
    error: Optional[str] = None


def is_active_status(status: str) -> bool:
    return str(status or "").strip().lower() in ACTIVE_CHAT_RUN_STATUSES


def normalize_final_status(status: str) -> str:
    value = str(status or "").strip().lower()
    if value == "error":
        return "failed"
    return value or "failed"


def build_progress_update(event_type: str, event_data: Any) -> Optional[ChatTaskProgressUpdate]:
    if event_type != "recovery":
        return None
    message = ""
    if isinstance(event_data, dict):
        message = str(event_data.get("message") or "").strip()
    else:
        message = str(event_data or "").strip()
    return ChatTaskProgressUpdate(status="recovering", response=message or "Recovering from a transient failure.")
