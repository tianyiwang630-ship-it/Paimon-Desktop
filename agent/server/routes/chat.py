"""Chat API routes."""

import time

from fastapi import APIRouter, HTTPException, Request

from agent.server.chat_debug import summarize_text, write_chat_debug_event
from agent.server.chat_tasks import execute_chat_request
from agent.server.models import (
    ChatInterruptRequest,
    ChatInterruptResponse,
    ChatRequest,
    ChatResponse,
    ChatStartResponse,
    ChatStatusResponse,
)

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest, request: Request):
    """Run chat in non-stream mode; pause on permission requests with HTTP 409."""
    agent_manager = request.app.state.agent_manager
    start_time = time.time()
    write_chat_debug_event(
        "chat_legacy_request_received",
        session_id=body.session_id,
        project_id=body.project_id,
        resume=body.resume,
        message=summarize_text(body.message),
    )

    print("\n" + "=" * 70)
    print(f"Session: {body.session_id} | Project: {body.project_id or '-'}")
    print(f"You: {body.message}")

    result = execute_chat_request(agent_manager, body)
    write_chat_debug_event(
        "chat_legacy_request_finished",
        session_id=body.session_id,
        project_id=body.project_id,
        status=result.status,
        duration_ms=int((time.time() - start_time) * 1000),
        tool_calls_count=result.tool_calls_count,
        error=result.error,
    )

    if result.status == "permission_required":
        raise HTTPException(status_code=409, detail=result.permission_detail)

    if result.status == "error":
        raise HTTPException(status_code=500, detail=f"Agent execution failed: {result.error}")

    final_response = result.response or "No final response was generated in this run. Open intermediate steps to inspect progress."

    elapsed = time.time() - start_time
    print(f"Agent: {final_response}")
    print(f"Tools in this request: {result.tool_calls_count}")
    print(f"Duration: {elapsed:.2f}s")
    print("=" * 70)

    return ChatResponse(
        session_id=body.session_id,
        response=final_response,
        tool_calls_count=result.tool_calls_count,
    )


@router.post("/chat/start", response_model=ChatStartResponse)
def start_chat(body: ChatRequest, request: Request):
    """Start a chat request in the background and return a pollable request id."""
    task_manager = request.app.state.chat_task_manager
    start_time = time.time()
    write_chat_debug_event(
        "chat_start_request_received",
        session_id=body.session_id,
        project_id=body.project_id,
        resume=body.resume,
        message=summarize_text(body.message),
    )
    try:
        record = task_manager.start_task(body)
    except RuntimeError as exc:
        write_chat_debug_event(
            "chat_start_request_rejected",
            session_id=body.session_id,
            project_id=body.project_id,
            duration_ms=int((time.time() - start_time) * 1000),
            error={"type": type(exc).__name__, "message": str(exc)},
        )
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        write_chat_debug_event(
            "chat_start_request_failed",
            session_id=body.session_id,
            project_id=body.project_id,
            duration_ms=int((time.time() - start_time) * 1000),
            error={"type": type(exc).__name__, "message": str(exc)},
        )
        raise HTTPException(status_code=500, detail=f"Failed to start chat task: {exc}")

    write_chat_debug_event(
        "chat_start_request_started",
        session_id=record.session_id,
        project_id=body.project_id,
        request_id=record.request_id,
        duration_ms=int((time.time() - start_time) * 1000),
    )
    return ChatStartResponse(
        request_id=record.request_id,
        session_id=record.session_id,
    )


@router.get("/chat/status/{request_id}", response_model=ChatStatusResponse)
def get_chat_status(request_id: str, request: Request):
    """Return current status for an in-memory chat task."""
    task_manager = request.app.state.chat_task_manager
    response = task_manager.build_status_response(request_id)
    if response is None:
        write_chat_debug_event(
            "chat_status_not_found",
            request_id=request_id,
        )
        raise HTTPException(status_code=404, detail="Chat request not found")
    write_chat_debug_event(
        "chat_status_returned",
        request_id=request_id,
        session_id=response.session_id,
        status=response.status,
        elapsed_ms=response.elapsed_ms,
        has_response=bool(response.response),
        has_error=bool(response.error),
    )
    return response


@router.post("/chat/interrupt", response_model=ChatInterruptResponse)
def interrupt_chat(body: ChatInterruptRequest, request: Request):
    """Interrupt current in-flight run for a session."""
    agent_manager = request.app.state.agent_manager
    write_chat_debug_event(
        "chat_interrupt_requested",
        session_id=body.session_id,
    )
    request.app.state.chat_task_manager.mark_session_interrupt_requested(body.session_id)
    agent = agent_manager.get_agent(body.session_id)
    if not agent:
        return ChatInterruptResponse(ok=False, message="Session is not active")

    print(f"[interrupt] Session: {body.session_id}")
    agent.interrupt()
    return ChatInterruptResponse(ok=True, message="Interrupt signal sent")
