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

    try:
        for event in agent.run_stream_locked(body.message, resume=body.resume):
            event_type = event.get("type")
            event_data = event.get("data")

            if event_type == "tool_start":
                tool_calls_count += 1
                continue

            if event_type == "permission_request":
                detail = _build_permission_required_detail(body.session_id, event_data or {})
                raise HTTPException(status_code=409, detail=detail)

            if event_type == "error":
                raise RuntimeError(str(event_data))

            if event_type == "done":
                final_response = str(event_data or "")

    except HTTPException:
        raise
    except Exception as e:
        err_text = f"[Error] {str(e)}"
        try:
            agent.history.append({"role": "assistant", "content": err_text})
            agent.db.add_message(body.session_id, "assistant", content=err_text)
            agent.db.touch_session(body.session_id, message_count_delta=1)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Agent execution failed: {e}")

    if final_response is None:
        final_response = ""

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
