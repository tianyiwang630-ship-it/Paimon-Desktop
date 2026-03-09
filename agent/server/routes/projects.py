"""
Project CRUD API
"""

import uuid
import shutil
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException, Query, Request

from agent.core.database import Database
from agent.core.paths import get_runtime_root
from agent.server.models import (
    ProjectCreate, ProjectPatch, ProjectInfo,
    SessionInfo, SessionListResponse
)

router = APIRouter(prefix="/api/projects", tags=["projects"])

# projects/{project_id}/
_runtime_root = get_runtime_root().resolve()
_projects_base = _runtime_root / "projects"


def _get_db() -> Database:
    return Database()


def _ensure_workspace(project_id: str) -> str:
    """"""
    workspace = _projects_base / project_id / "files"
    #  input/output/temp 
    (workspace / "input").mkdir(parents=True, exist_ok=True)
    (workspace / "output").mkdir(parents=True, exist_ok=True)
    (workspace / "temp").mkdir(parents=True, exist_ok=True)
    return str(workspace)


def _is_within(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False


def _safe_remove_project_workspace(workspace_path: str):
    if not workspace_path:
        return
    ws = Path(workspace_path).resolve()
    # Workspace is expected at projects/{project_id}/files.
    target = ws.parent if ws.name == "files" else ws
    if target.exists() and _is_within(target, _projects_base):
        shutil.rmtree(target, ignore_errors=True)


@router.post("", response_model=ProjectInfo)
def create_project(body: ProjectCreate):
    """ Project"""
    db = _get_db()
    project_id = uuid.uuid4().hex[:8]
    workspace_path = _ensure_workspace(project_id)
    project = db.create_project(
        project_id=project_id,
        name=body.name,
        description=body.description,
        custom_instructions=body.custom_instructions,
        workspace_path=workspace_path,
    )
    return ProjectInfo(**project)


@router.get("", response_model=List[ProjectInfo])
def list_projects():
    """ Project"""
    db = _get_db()
    projects = db.list_projects()
    return [ProjectInfo(**p) for p in projects]


@router.get("/{project_id}", response_model=ProjectInfo)
def get_project(project_id: str):
    """ Project """
    db = _get_db()
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project ")
    return ProjectInfo(**project)


@router.patch("/{project_id}", response_model=ProjectInfo)
def patch_project(project_id: str, body: ProjectPatch):
    """ Project"""
    db = _get_db()
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project ")
    updates = body.model_dump(exclude_none=True)
    if updates:
        project = db.update_project(project_id, **updates)
    return ProjectInfo(**project)


@router.delete("/{project_id}")
def delete_project(project_id: str, request: Request, hard: bool = Query(False)):
    """
     Project
    hard=false
    hard=true sessions  project_id  NULL
    """
    db = _get_db()
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project ")
    if hard:
        session_ids = db.get_project_session_ids(project_id)
        # Release agents and hard-delete project sessions/messages.
        for session_id in session_ids:
            try:
                request.app.state.agent_manager.release(session_id)
            except Exception:
                pass
            db.delete_session(session_id)
        db.delete_project(project_id)
        _safe_remove_project_workspace(project.get("workspace_path"))
    else:
        db.archive_project(project_id)
    return {"ok": True}


@router.get("/{project_id}/sessions", response_model=SessionListResponse)
def get_project_sessions(
    project_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """ Project """
    db = _get_db()
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project ")
    sessions = db.get_project_sessions(project_id, limit=limit, offset=offset)
    total = db.count_project_sessions(project_id)
    return SessionListResponse(
        sessions=[SessionInfo(**s) for s in sessions],
        total=total,
        limit=limit,
        offset=offset,
    )
