"""Permission confirmation and mode APIs."""

from fastapi import APIRouter, HTTPException, Request

from agent.server.models import (
    PermissionConfirmRequest,
    PermissionConfirmResponse,
    PermissionModeRequest,
    PermissionModeResponse,
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
    signature = pm._get_signature(body.tool, body.args)
    is_delete_request = pm.is_delete_request(body.tool, body.args)

    if body.action == "allow_once":
        pm.pending_allow_once.add(signature)
        pm.session_denied.discard(signature)
        return PermissionConfirmResponse(success=True, message="Allowed for this request")

    if body.action == "allow_session":
        if is_delete_request:
            pm.pending_allow_once.add(signature)
            pm.session_denied.discard(signature)
            return PermissionConfirmResponse(
                success=True,
                message="Delete operation can only be allowed once. Approved for current request.",
            )

        normalized_tool = pm.allow_tool_for_session(body.tool)
        pm.session_denied.discard(signature)
        return PermissionConfirmResponse(
            success=True,
            message=f"Allowed for this session: {normalized_tool or body.tool}",
        )

    if body.action == "deny":
        # Web deny is scoped to the current request. Keep future delete attempts ask-able.
        pm.pending_allow_once.discard(signature)
        pm.session_denied.discard(signature)
        return PermissionConfirmResponse(success=True, message="Denied for this request")

    if body.action == "retry_with_context":
        pm.pending_allow_once.add(signature)
        agent._pending_extra_instruction = body.extra_instruction or ""
        return PermissionConfirmResponse(success=True, message="Will retry with extra instruction")

    if body.action == "switch_auto":
        pm.mode = "auto"
        return PermissionConfirmResponse(success=True, message="Switched to auto mode")

    raise HTTPException(status_code=400, detail="Invalid action")


@router.post("/mode", response_model=PermissionModeResponse)
async def set_permission_mode(body: PermissionModeRequest, request: Request):
    if body.mode not in {"ask", "auto"}:
        raise HTTPException(status_code=400, detail="Invalid mode")

    agent_manager = request.app.state.agent_manager
    agent = agent_manager.get_agent(body.session_id)

    if not agent:
        db = request.app.state.db
        session = db.get_session(body.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        agent = agent_manager.get_or_create(body.session_id, project_id=session.get("project_id"))

    if not agent.tool_loader.permission_manager:
        raise HTTPException(status_code=400, detail="Permission manager not enabled")

    agent.tool_loader.permission_manager.set_mode(body.mode)
    return PermissionModeResponse(success=True, mode=body.mode, message=f"Permission mode set to {body.mode}")

