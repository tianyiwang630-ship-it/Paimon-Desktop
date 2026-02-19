"""
 CRUD API
"""

import shutil
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query, Request
from typing import Optional

from agent.core.database import Database
from agent.core.paths import get_runtime_root
from agent.server.models import (
    SessionCreate, SessionPatch, SessionInfo, SessionListResponse,
    SessionDetail, MessageItem
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])
_runtime_root = get_runtime_root().resolve()


def _get_db() -> Database:
    return Database()


def _session_workspace_path(session_id: str) -> Path:
    return (_runtime_root / "sessions" / session_id).resolve()


def _safe_remove_tree(path: Path):
    if not path.exists():
        return
    if path == _runtime_root:
        raise RuntimeError("Refusing to delete project root")
    try:
        path.relative_to(_runtime_root)
    except Exception:
        raise RuntimeError("Refusing to delete path outside project root")
    shutil.rmtree(path, ignore_errors=True)


@router.post("", response_model=SessionInfo)
def create_session(body: SessionCreate = None):
    """"""
    db = _get_db()
    import uuid
    session_id = (body.session_id if body and body.session_id else None) or uuid.uuid4().hex[:6]
    session = db.create_session(session_id, project_id=(body.project_id if body else None))
    return SessionInfo(**session)


@router.get("", response_model=SessionListResponse)
def list_sessions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None, description=""),
):
    """"""
    db = _get_db()
    sessions = db.list_sessions(limit=limit, offset=offset, search=search, project_id=project_id)
    total = db.count_sessions(search=search, project_id=project_id)
    return SessionListResponse(
        sessions=[SessionInfo(**s) for s in sessions],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{session_id}", response_model=SessionDetail)
def get_session(session_id: str):
    """"""
    db = _get_db()
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="")
    messages_raw = db.get_messages(session_id)
    messages = [
        MessageItem(
            role=m["role"],
            content=m.get("content"),
            tool_calls=m.get("tool_calls"),
            tool_call_id=m.get("tool_call_id"),
        )
        for m in messages_raw
    ]
    return SessionDetail(
        id=session["id"],
        title=session.get("title"),
        created_at=session["created_at"],
        updated_at=session["updated_at"],
        message_count=session.get("message_count", 0),
        is_pinned=bool(session.get("is_pinned", 0)),
        model_name=session.get("model_name"),
        messages=messages,
    )


@router.patch("/{session_id}", response_model=SessionInfo)
def patch_session(session_id: str, body: SessionPatch):
    """"""
    db = _get_db()
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="")
    updates = body.model_dump(exclude_none=True)
    if updates:
        db.update_session_patch(session_id, **updates)
    return SessionInfo(**db.get_session(session_id))


@router.delete("/{session_id}")
def delete_session(session_id: str, request: Request, hard: bool = Query(False)):
    """
    
    hard=false
    hard=true
    """
    db = _get_db()
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="")

    # Drop in-memory agent to avoid stale state after deletion.
    try:
        request.app.state.agent_manager.release(session_id)
    except Exception:
        pass

    if hard:
        db.delete_session(session_id)
        # Non-project sessions have isolated workspace, delete it with the chat.
        if not session.get("project_id"):
            _safe_remove_tree(_session_workspace_path(session_id))
    else:
        db.archive_session(session_id)
    return {"ok": True}
