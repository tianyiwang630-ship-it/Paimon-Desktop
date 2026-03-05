"""Session CRUD API routes."""

import json
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from agent.core.database import Database
from agent.core.paths import get_runtime_root
from agent.server.models import (
    MessageItem,
    SessionCreate,
    SessionDetail,
    SessionInfo,
    SessionListResponse,
    SessionPatch,
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
        raise RuntimeError("Refusing to delete runtime root")
    try:
        path.relative_to(_runtime_root)
    except Exception as exc:
        raise RuntimeError("Refusing to delete path outside runtime root") from exc
    shutil.rmtree(path, ignore_errors=True)


def _create_session_with_retry(db: Database, project_id: Optional[str]) -> dict:
    # Use longer random IDs and retry on rare collisions.
    for _ in range(16):
        session_id = uuid.uuid4().hex[:12]
        try:
            return db.create_session(session_id, project_id=project_id)
        except sqlite3.IntegrityError:
            continue
    raise HTTPException(status_code=500, detail="Failed to allocate unique session id")


@router.post("", response_model=SessionInfo)
def create_session(body: SessionCreate = None):
    db = _get_db()
    project_id = body.project_id if body else None

    if body and body.session_id:
        requested_id = body.session_id.strip()
        if not requested_id:
            raise HTTPException(status_code=400, detail="Invalid session id")
        if db.get_session(requested_id):
            raise HTTPException(status_code=409, detail="Session id already exists")
        try:
            session = db.create_session(requested_id, project_id=project_id)
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Session id already exists")
    else:
        session = _create_session_with_retry(db, project_id)

    return SessionInfo(**session)


@router.get("", response_model=SessionListResponse)
def list_sessions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None, description=""),
):
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
    db = _get_db()
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="")

    with db._connect() as conn:
        rows = conn.execute(
            """
            SELECT
                id,
                role,
                content,
                tool_calls,
                tool_call_id,
                provider,
                reasoning_json,
                protocol_flags_json,
                message_format_version,
                created_at
            FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

    messages = []
    for row in rows:
        tool_calls = None
        raw_tool_calls = row["tool_calls"]
        if raw_tool_calls and isinstance(raw_tool_calls, str):
            try:
                tool_calls = json.loads(raw_tool_calls)
            except json.JSONDecodeError:
                # Keep session readable even if a historical row has malformed tool_calls.
                tool_calls = None

        messages.append(
            MessageItem(
                id=row["id"],
                role=row["role"],
                content=row["content"],
                tool_calls=tool_calls,
                tool_call_id=row["tool_call_id"],
                provider=row["provider"] if "provider" in row.keys() else None,
                reasoning_blocks=(
                    json.loads(row["reasoning_json"])
                    if "reasoning_json" in row.keys() and row["reasoning_json"]
                    else None
                ),
                protocol_flags=(
                    json.loads(row["protocol_flags_json"])
                    if "protocol_flags_json" in row.keys() and row["protocol_flags_json"]
                    else None
                ),
                message_format_version=(
                    int(row["message_format_version"])
                    if "message_format_version" in row.keys() and row["message_format_version"] is not None
                    else 1
                ),
                created_at=row["created_at"],
            )
        )

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
    """Delete/archive session. hard=true also removes non-project session workspace."""
    db = _get_db()
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="")

    try:
        request.app.state.agent_manager.release(session_id)
    except Exception:
        pass

    if hard:
        db.delete_session(session_id)
        if not session.get("project_id"):
            _safe_remove_tree(_session_workspace_path(session_id))
    else:
        db.archive_session(session_id)

    return {"ok": True}
