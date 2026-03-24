"""Permission confirmation APIs."""

from fastapi import APIRouter, HTTPException, Request

from agent.server.models import (
    ChatStartResponse,
    PermissionConfirmRequest,
    PermissionConfirmResponse,
    PermissionExecuteRequest,
)

router = APIRouter(prefix="/api/permissions", tags=["permissions"])


@router.post("/confirm", response_model=PermissionConfirmResponse)
async def confirm_permission(body: PermissionConfirmRequest, request: Request):
    agent_manager = request.app.state.agent_manager
    agent = agent_manager.get_agent(body.session_id)

    if not agent:
        raise HTTPException(status_code=404, detail="Session not found")

    if not agent.tool_loader.permission_manager:
        raise HTTPException(status_code=400, detail="Permission manager not enabled")

    pm = agent.tool_loader.permission_manager
    pending = agent.get_pending_tool_request(body.pending_request_id)
    if not pending:
        raise HTTPException(status_code=404, detail="Pending permission request not found")

    if pending.get("tool") != body.tool or (pending.get("args") or {}) != (body.args or {}):
        raise HTTPException(status_code=409, detail="Pending permission request no longer matches tool payload")

    signature = pm._get_signature(body.tool, body.args)
    if body.action == "allow_once":
        pm.pending_allow_once.add(signature)
        pm.session_denied.discard(signature)
        agent.record_pending_permission_decision(body.pending_request_id, body.action)
        return PermissionConfirmResponse(
            success=True,
            message="Allowed for this request",
            requires_execution=True,
            pending_request_id=body.pending_request_id,
        )

    if body.action == "deny":
        # Web deny is scoped to the current request. Keep future delete attempts ask-able.
        pm.pending_allow_once.discard(signature)
        pm.session_denied.discard(signature)
        agent.record_pending_permission_decision(body.pending_request_id, body.action)
        return PermissionConfirmResponse(
            success=True,
            message="Denied for this request",
            requires_execution=True,
            pending_request_id=body.pending_request_id,
        )

    if body.action == "retry_with_context":
        extra_instruction = (body.extra_instruction or "").strip()
        if not extra_instruction:
            raise HTTPException(status_code=400, detail="Extra instruction is required")
        agent.record_pending_permission_decision(body.pending_request_id, body.action, extra_instruction)
        return PermissionConfirmResponse(
            success=True,
            message="Will retry with extra instruction",
            requires_execution=True,
            pending_request_id=body.pending_request_id,
        )

    raise HTTPException(status_code=400, detail="Invalid action")


@router.post("/execute", response_model=ChatStartResponse)
async def execute_pending_permission(body: PermissionExecuteRequest, request: Request):
    agent_manager = request.app.state.agent_manager
    agent = agent_manager.get_agent(body.session_id)

    if not agent:
        raise HTTPException(status_code=404, detail="Session not found")

    pending = agent.get_pending_tool_request(body.pending_request_id)
    if not pending:
        raise HTTPException(status_code=404, detail="Pending permission request not found")

    if not pending.get("decision_action"):
        raise HTTPException(status_code=409, detail="Pending permission request has not been confirmed")

    task_manager = request.app.state.chat_task_manager
    try:
        record = task_manager.start_pending_permission_task(body.session_id, body.pending_request_id)
        agent.link_pending_tool_request_task(body.pending_request_id, record.request_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start pending permission task: {exc}")

    return ChatStartResponse(
        request_id=record.request_id,
        session_id=record.session_id,
    )

