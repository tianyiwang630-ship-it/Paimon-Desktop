"""Debug-only API routes."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from agent.server.chat_debug import is_chat_debug_enabled, write_chat_debug_event

router = APIRouter(prefix="/api/debug", tags=["debug"])


class ChatDebugLogRequest(BaseModel):
    event: str
    layer: Optional[str] = "frontend"
    session_id: Optional[str] = None
    project_id: Optional[str] = None
    request_id: Optional[str] = None
    duration_ms: Optional[int] = None
    http_status: Optional[int] = None
    data: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None


@router.post("/chat-log")
def write_frontend_chat_log(body: ChatDebugLogRequest):
    enabled = is_chat_debug_enabled()
    if enabled:
        write_chat_debug_event(
            body.event,
            layer=body.layer or "frontend",
            session_id=body.session_id,
            project_id=body.project_id,
            request_id=body.request_id,
            duration_ms=body.duration_ms,
            http_status=body.http_status,
            data=body.data or {},
            error=body.error or {},
        )
    return {"ok": True, "enabled": enabled}
