"""Session/project scoped file APIs."""

import io
import os
import zipfile
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse, StreamingResponse

from agent.core.database import Database
from agent.core.paths import get_runtime_root
from agent.server.models import FileInfo

router = APIRouter(prefix="/api/files", tags=["files"])

_runtime_root = get_runtime_root().resolve()


def _to_public_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(_runtime_root))
    except Exception:
        return str(path.resolve())


def _is_within(path: Path, base: Path) -> bool:
    """True if path is located under base directory."""
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False


def _ensure_session_workspace(
    session_id: str,
    project_id: Optional[str] = None,
) -> Tuple[Path, Path, Path]:
    """
    Resolve input/output directories for a session.

    Rules:
    - Project session: shared project workspace (input/output/temp)
    - Non-project session: isolated per-session workspace under sessions/{session_id}/
    """
    db = Database()
    session = db.get_session(session_id)

    if not session:
        db.create_session(session_id, project_id=project_id)
        session = db.get_session(session_id)
    elif project_id:
        existing_project_id = session.get("project_id")
        if existing_project_id and existing_project_id != project_id:
            raise HTTPException(status_code=400, detail="Session project mismatch")
        if not existing_project_id:
            db.update_session_patch(session_id, project_id=project_id)
            session = db.get_session(session_id)

    if session and session.get("project_id"):
        project = db.get_project(session["project_id"])
        if project and project.get("workspace_path"):
            ws = Path(project["workspace_path"]).resolve()
            projects_root = (_runtime_root / "projects").resolve()
            if not _is_within(ws, projects_root):
                raise HTTPException(status_code=400, detail="Invalid project workspace path")
            input_dir = (ws / "input").resolve()
            output_dir = (ws / "output").resolve()
            temp_dir = (ws / "temp").resolve()
            input_dir.mkdir(parents=True, exist_ok=True)
            output_dir.mkdir(parents=True, exist_ok=True)
            temp_dir.mkdir(parents=True, exist_ok=True)
            return input_dir, output_dir, temp_dir

    session_ws = (_runtime_root / "sessions" / session_id).resolve()
    input_dir = (session_ws / "input").resolve()
    output_dir = (session_ws / "output").resolve()
    temp_dir = (session_ws / "temp").resolve()
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)
    return input_dir, output_dir, temp_dir


def _resolve_scoped_path(base_dir: Path, path: Optional[str]) -> Path:
    """
    Resolve an optional target path under a scoped base directory.

    - path=None -> base_dir
    - absolute path is allowed only if inside base_dir
    - relative path is resolved from runtime root and must still be inside base_dir
    """
    if not path:
        return base_dir.resolve()

    candidate = Path(path)
    resolved = candidate.resolve() if candidate.is_absolute() else (_runtime_root / candidate).resolve()

    if not _is_within(resolved, base_dir):
        raise HTTPException(status_code=403, detail="Path is outside scoped workspace")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    return resolved


def _resolve_raw_path(path: str) -> Path:
    candidate = Path(path)
    return candidate.resolve() if candidate.is_absolute() else (_runtime_root / candidate).resolve()


def _write_directory_to_zip(zf: zipfile.ZipFile, source_dir: Path, zip_root: str):
    root = source_dir.resolve()
    if not root.exists():
        zf.writestr(f"{zip_root}/", "")
        return

    has_any = False
    for dirpath, dirnames, filenames in os.walk(root):
        dir_path = Path(dirpath)
        rel_dir = dir_path.relative_to(root)
        zip_dir = Path(zip_root) / rel_dir if rel_dir != Path(".") else Path(zip_root)

        if not dirnames and not filenames:
            zf.writestr(f"{zip_dir.as_posix()}/", "")
            has_any = True

        for filename in filenames:
            has_any = True
            file_path = dir_path / filename
            arcname = (zip_dir / filename).as_posix()
            zf.write(file_path, arcname)

    if not has_any:
        zf.writestr(f"{zip_root}/", "")


def _list_dir(directory: Path) -> List[FileInfo]:
    result: List[FileInfo] = []
    for entry in sorted(directory.iterdir()):
        try:
            result.append(
                FileInfo(
                    name=entry.name,
                    path=_to_public_path(entry),
                    size=entry.stat().st_size if entry.is_file() else 0,
                    is_dir=entry.is_dir(),
                )
            )
        except Exception:
            continue
    return result


@router.get("/input", response_model=List[FileInfo])
def list_input_files(
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
    path: Optional[str] = Query(None),
):
    """List input files in the session/project scoped workspace."""
    try:
        input_dir, _, _ = _ensure_session_workspace(session_id, project_id=project_id)
        target_dir = _resolve_scoped_path(input_dir, path)
        return _list_dir(target_dir)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list input files: {str(e)}")


@router.get("/output", response_model=List[FileInfo])
def list_output_files(
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
    path: Optional[str] = Query(None),
):
    """List output files in the session/project scoped workspace."""
    try:
        _, output_dir, _ = _ensure_session_workspace(session_id, project_id=project_id)
        target_dir = _resolve_scoped_path(output_dir, path)
        return _list_dir(target_dir)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list output files: {str(e)}")


@router.get("/temp", response_model=List[FileInfo])
def list_temp_files(
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
    path: Optional[str] = Query(None),
):
    """List temp files in the session/project scoped workspace."""
    try:
        _, _, temp_dir = _ensure_session_workspace(session_id, project_id=project_id)
        target_dir = _resolve_scoped_path(temp_dir, path)
        return _list_dir(target_dir)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list temp files: {str(e)}")


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
    relative_path: Optional[str] = Query(None),
):
    """Upload file to scoped input directory, optionally preserving relative folder layout."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    max_file_size = 100 * 1024 * 1024  # 100MB
    content = await file.read()
    if len(content) > max_file_size:
        raise HTTPException(
            status_code=413,
            detail=f"File too large, max {max_file_size // 1024 // 1024}MB",
        )

    try:
        input_dir, _, _ = _ensure_session_workspace(session_id, project_id=project_id)

        raw_rel = (relative_path or file.filename).strip()
        rel_obj = Path(raw_rel)
        if rel_obj.is_absolute() or any(part in ("..", "") for part in rel_obj.parts):
            raise HTTPException(status_code=400, detail="Invalid relative path")

        dest = (input_dir / rel_obj).resolve()
        if not _is_within(dest, input_dir):
            raise HTTPException(status_code=400, detail="Invalid relative path")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return {
            "name": dest.name,
            "size": len(content),
            "path": _to_public_path(dest),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


@router.get("/download")
def download_file(
    path: str = Query(...),
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
):
    """Download a file only from scoped input/output/temp directories."""
    input_dir, output_dir, temp_dir = _ensure_session_workspace(session_id, project_id=project_id)

    full_path = Path(path).resolve() if Path(path).is_absolute() else (_runtime_root / path).resolve()
    allowed_bases = [input_dir.resolve(), output_dir.resolve(), temp_dir.resolve()]
    if not any(_is_within(full_path, base) for base in allowed_bases):
        raise HTTPException(status_code=403, detail="Path is outside scoped workspace")
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(full_path), filename=full_path.name)


@router.get("/download-zip")
def download_directory_zip(
    path: str = Query(...),
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
):
    """Download a directory as zip from scoped input/output/temp directories."""
    input_dir, output_dir, temp_dir = _ensure_session_workspace(session_id, project_id=project_id)
    allowed_bases = [input_dir.resolve(), output_dir.resolve(), temp_dir.resolve()]

    full_path = _resolve_raw_path(path)
    if not any(_is_within(full_path, base) for base in allowed_bases):
        raise HTTPException(status_code=403, detail="Path is outside scoped workspace")
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not full_path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        root_name = full_path.name
        for dirpath, dirnames, filenames in os.walk(full_path):
            dir_path = Path(dirpath)
            rel_dir = dir_path.relative_to(full_path)
            zip_dir = Path(root_name) / rel_dir if rel_dir != Path(".") else Path(root_name)

            if not dirnames and not filenames:
                zf.writestr(f"{str(zip_dir).replace('\\', '/')}/", "")

            for filename in filenames:
                file_path = dir_path / filename
                arcname = (zip_dir / filename).as_posix()
                zf.write(file_path, arcname)

    buf.seek(0)
    download_name = f"{full_path.name}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@router.get("/download-output-zip")
def download_output_zip(
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
):
    """Download scoped output folder as zip."""
    _, output_dir, _ = _ensure_session_workspace(session_id, project_id=project_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        _write_directory_to_zip(zf, output_dir, "output")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="output.zip"'},
    )


@router.get("/download-temp-zip")
def download_temp_zip(
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
):
    """Download scoped temp folder as zip."""
    _, _, temp_dir = _ensure_session_workspace(session_id, project_id=project_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        _write_directory_to_zip(zf, temp_dir, "temp")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="temp.zip"'},
    )
