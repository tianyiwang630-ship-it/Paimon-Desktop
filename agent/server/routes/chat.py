"""Chat API routes (non-streaming response with internal event handling)."""

import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request

from agent.server.models import (
    ChatInterruptRequest,
    ChatInterruptResponse,
    ChatRequest,
    ChatResponse,
)

router = APIRouter(prefix="/api", tags=["chat"])


def _build_permission_required_detail(session_id: str, event_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "code": "permission_required",
        "session_id": session_id,
        "tool": event_data.get("tool"),
        "args": event_data.get("args") or {},
        "tool_call_id": event_data.get("tool_call_id"),
        "message": "Permission confirmation required",
    }


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest, request: Request):
    """Run chat in non-stream mode; pause on permission requests with HTTP 409."""
    agent_manager = request.app.state.agent_manager
    start_time = time.time()

    print("\n" + "=" * 70)
    print(f"Session: {body.session_id} | Project: {body.project_id or '-'}")
    print(f"You: {body.message}")

    try:
        agent = agent_manager.get_or_create(body.session_id, project_id=body.project_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent creation failed: {e}")

    final_response: Optional[str] = None
    tool_calls_count = 0
    event_iter = None
    permission_detail: Optional[Dict[str, Any]] = None
    history_start_idx = len(agent.history)

    try:
        # Persisting user input happens inside run_events under the per-session
        # execution lock. This avoids race conditions between interrupt and a
        # follow-up send in the same session.
        event_iter = agent.run_events_locked(
            body.message,
            resume=body.resume,
            user_persisted=False,
        )
        for event in event_iter:
            event_type = event.get("type")
            event_data = event.get("data")

            if event_type == "tool_start":
                tool_calls_count += 1
                continue

            if event_type == "permission_request":
                permission_detail = _build_permission_required_detail(body.session_id, event_data or {})
                break

            if event_type == "error":
                raise RuntimeError(str(event_data))

            if event_type == "done":
                final_response = str(event_data or "")

    except HTTPException:
        raise
    except Exception as e:
        # Do not persist another assistant error here; run_events already handles
        # persistence for execution failures.
        raise HTTPException(status_code=500, detail=f"Agent execution failed: {e}")
    finally:
        if event_iter is not None:
            try:
                event_iter.close()
            except Exception:
                pass

    if permission_detail is not None:
        raise HTTPException(status_code=409, detail=permission_detail)

    if not (final_response or "").strip():
        # Recover from messages generated during this request before returning fallback.
        for msg in reversed(agent.history[history_start_idx:]):
            if msg.get("role") != "assistant":
                continue
            text = str(msg.get("content") or "").strip()
            if text:
                final_response = text
                break

    if not (final_response or "").strip():
        final_response = "No final response was generated in this run. Open intermediate steps to inspect progress."

    elapsed = time.time() - start_time
    print(f"Agent: {final_response}")
    print(f"Tools in this request: {tool_calls_count}")
    print(f"Duration: {elapsed:.2f}s")
    print("=" * 70)

    return ChatResponse(
        session_id=body.session_id,
        response=final_response,
        tool_calls_count=tool_calls_count,
    )


@router.post("/chat/interrupt", response_model=ChatInterruptResponse)
def interrupt_chat(body: ChatInterruptRequest, request: Request):
    """Interrupt current in-flight run for a session."""
    agent_manager = request.app.state.agent_manager
    agent = agent_manager.get_agent(body.session_id)
    if not agent:
        return ChatInterruptResponse(ok=False, message="Session is not active")

    print(f"[interrupt] Session: {body.session_id}")
    agent.interrupt()
    return ChatInterruptResponse(ok=True, message="Interrupt signal sent")
