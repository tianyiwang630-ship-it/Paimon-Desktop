"""Session/project scoped file APIs."""

import io
import tempfile
import os
import re
import zipfile
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import APIRouter, HTTPException, UploadFile, File, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from send2trash import send2trash

from agent.core.database import Database
from agent.core.paths import get_runtime_root
from agent.server.models import (
    FileInfo,
    UploadConflictItem,
    UploadConflictsCheckRequest,
    UploadConflictsCheckResponse,
    UploadFolderLocalRequest,
    UploadFolderLocalResponse,
)

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


def _sanitize_dir_name(name: str, fallback: str = "imported_folder") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", (name or "").strip())
    cleaned = cleaned.rstrip(". ").strip()
    if cleaned in {"", ".", ".."}:
        return fallback
    return cleaned


def _build_import_root_name(source_root: Path) -> str:
    root_name = (source_root.name or "").strip()
    if root_name:
        return _sanitize_dir_name(root_name)

    drive = (source_root.drive or "").replace(":", "").strip()
    if drive:
        return _sanitize_dir_name(f"{drive}_drive")

    anchor = (source_root.anchor or "").replace("\\", "_").replace("/", "_").replace(":", "").strip()
    if anchor:
        return _sanitize_dir_name(anchor)

    return "imported_folder"


def _split_name_for_suffix(name: str, is_dir: bool) -> Tuple[str, str]:
    if is_dir:
        return name, ""

    suffixes = Path(name).suffixes
    ext = "".join(suffixes)
    if not ext:
        return name, ""
    return name[:-len(ext)], ext


def _resolve_non_conflicting_path(dest: Path) -> Path:
    """Return a sibling path using _(n) naming that does not exist yet."""
    parent = dest.parent
    is_dir = dest.exists() and dest.is_dir()
    if not dest.exists():
        is_dir = dest.suffix == ""
    base_name, ext = _split_name_for_suffix(dest.name, is_dir=is_dir)

    counter = 1
    while True:
        candidate = parent / f"{base_name}_({counter}){ext}"
        if not candidate.exists():
            return candidate
        counter += 1


def _trash_existing_path(path: Path) -> None:
    if path.exists():
        send2trash(str(path))


def _resolve_target_path(input_dir: Path, relative_path: str) -> Path:
    rel_obj = Path((relative_path or "").strip())
    if rel_obj.is_absolute() or any(part in ("..", "") for part in rel_obj.parts):
        raise HTTPException(status_code=400, detail="Invalid relative path")

    dest = (input_dir / rel_obj).resolve()
    if not _is_within(dest, input_dir):
        raise HTTPException(status_code=400, detail="Invalid relative path")
    return dest


def _apply_conflict_strategy(dest: Path, strategy: Optional[str]) -> Path:
    if not dest.exists():
        return dest

    if strategy == "replace":
        _trash_existing_path(dest)
        return dest

    if strategy == "rename":
        return _resolve_non_conflicting_path(dest)

    raise HTTPException(
        status_code=409,
        detail=f"Target already exists: {_to_public_path(dest)}. Choose replace or rename.",
    )


def _collect_existing_conflicts(input_dir: Path, relative_paths: List[str]) -> List[UploadConflictItem]:
    conflicts: List[UploadConflictItem] = []
    seen_paths: set[str] = set()

    for relative_path in relative_paths:
        dest = _resolve_target_path(input_dir, relative_path)
        if not dest.exists():
            continue

        public_path = _to_public_path(dest)
        if public_path in seen_paths:
            continue
        seen_paths.add(public_path)

        conflicts.append(
            UploadConflictItem(
                path=public_path,
                name=dest.name,
                is_dir=dest.is_dir(),
            )
        )

    return conflicts


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


@router.post("/input-conflicts/check", response_model=UploadConflictsCheckResponse)
def check_input_conflicts(body: UploadConflictsCheckRequest):
    """Check whether input uploads would conflict with existing items."""
    try:
        input_dir, _, _ = _ensure_session_workspace(body.session_id, project_id=body.project_id)
        conflicts = _collect_existing_conflicts(input_dir, body.relative_paths)
        return UploadConflictsCheckResponse(
            has_conflicts=bool(conflicts),
            conflicts=conflicts,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to check upload conflicts: {str(e)}")


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


@router.delete("/input-item")
def delete_input_item(
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
    path: str = Query(...),
):
    """Delete a file/folder under scoped input directory only."""
    try:
        if not path or not path.strip():
            raise HTTPException(status_code=400, detail="Path is required")

        input_dir, _, _ = _ensure_session_workspace(session_id, project_id=project_id)
        target = _resolve_raw_path(path.strip())

        if not _is_within(target, input_dir):
            raise HTTPException(status_code=403, detail="Only input directory items can be deleted")
        if target.resolve() == input_dir.resolve():
            raise HTTPException(status_code=400, detail="Input root cannot be deleted")
        if not target.exists():
            raise HTTPException(status_code=404, detail="Path not found")

        is_dir = target.is_dir()
        send2trash(str(target))

        return {
            "deleted": True,
            "path": _to_public_path(target),
            "is_dir": is_dir,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete input item: {str(e)}")


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    session_id: str = Query(...),
    project_id: Optional[str] = Query(None),
    relative_path: Optional[str] = Query(None),
    conflict_strategy: Optional[str] = Query(None),
):
    """Upload file to scoped input directory, optionally preserving relative folder layout."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    max_file_size = 100 * 1024 * 1024  # 100MB
    chunk_size = 1024 * 1024  # 1MB

    try:
        input_dir, _, _ = _ensure_session_workspace(session_id, project_id=project_id)

        raw_rel = (relative_path or file.filename).strip()
        dest = _resolve_target_path(input_dir, raw_rel)
        dest.parent.mkdir(parents=True, exist_ok=True)

        total = 0
        temp_path: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                delete=False,
                dir=str(dest.parent),
                prefix=f".{dest.name}.",
                suffix=".uploading",
            ) as out:
                temp_path = Path(out.name)
                while True:
                    chunk = await file.read(chunk_size)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_file_size:
                        raise HTTPException(
                            status_code=413,
                            detail=f"File too large, max {max_file_size // 1024 // 1024}MB",
                        )
                    out.write(chunk)

            if temp_path is None or not temp_path.exists():
                raise RuntimeError("Temporary upload file was not created")

            final_dest = _apply_conflict_strategy(dest, conflict_strategy)
            final_dest.parent.mkdir(parents=True, exist_ok=True)
            temp_path.replace(final_dest)
            dest = final_dest
        except Exception:
            if temp_path and temp_path.exists():
                try:
                    temp_path.unlink()
                except Exception:
                    pass
            raise
        finally:
            try:
                await file.close()
            except Exception:
                pass

        return {
            "name": dest.name,
            "size": total,
            "path": _to_public_path(dest),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


@router.post("/upload-folder-local", response_model=UploadFolderLocalResponse)
async def upload_folder_local(body: UploadFolderLocalRequest, request: Request):
    """Import a local folder recursively into scoped input directory."""
    folder_raw = (body.folder_path or "").strip()
    if not folder_raw:
        raise HTTPException(status_code=400, detail="Invalid folder path")

    source_root = Path(folder_raw).expanduser().resolve()
    if not source_root.exists():
        raise HTTPException(status_code=404, detail="Folder not found")
    if not source_root.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    input_dir, _, _ = _ensure_session_workspace(body.session_id, project_id=body.project_id)
    import_root_name = _build_import_root_name(source_root)
    import_root_dir = (input_dir / import_root_name).resolve()
    if not _is_within(import_root_dir, input_dir):
        raise HTTPException(status_code=400, detail="Invalid folder name")
    import_root_dir = _apply_conflict_strategy(import_root_dir, body.conflict_strategy)
    import_root_dir.mkdir(parents=True, exist_ok=True)

    imported_count = 0
    failed_count = 0
    first_error: Optional[str] = None
    copy_chunk_size = 1024 * 1024
    disconnect_check_interval = 8
    files_since_disconnect_check = 0

    for dirpath, dirnames, filenames in os.walk(source_root, followlinks=False):
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="Upload canceled by client")

        dir_path = Path(dirpath)
        rel_dir = dir_path.relative_to(source_root)
        target_dir = import_root_dir if rel_dir == Path(".") else (import_root_dir / rel_dir).resolve()
        if not _is_within(target_dir, input_dir):
            failed_count += len(filenames)
            if not first_error:
                rel_text = str(rel_dir).replace(os.sep, "/")
                first_error = f"Invalid directory path: {rel_text}"
            # Stop walking this branch when target path is invalid.
            dirnames[:] = []
            continue
        target_dir.mkdir(parents=True, exist_ok=True)

        # Skip symlink directories to avoid escaping or recursion hazards.
        dirnames[:] = [name for name in dirnames if not (dir_path / name).is_symlink()]

        for filename in filenames:
            files_since_disconnect_check += 1
            if files_since_disconnect_check >= disconnect_check_interval:
                files_since_disconnect_check = 0
                if await request.is_disconnected():
                    raise HTTPException(status_code=499, detail="Upload canceled by client")

            src = dir_path / filename

            if src.is_symlink() or not src.is_file():
                continue

            rel = src.relative_to(source_root)
            dest = (target_dir / filename).resolve()
            if not _is_within(dest, input_dir):
                failed_count += 1
                if not first_error:
                    first_error = f"Invalid relative path: {str(rel).replace(os.sep, '/')}"
                continue

            dest.parent.mkdir(parents=True, exist_ok=True)

            temp_path: Optional[Path] = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    delete=False,
                    dir=str(dest.parent),
                    prefix=f".{dest.name}.",
                    suffix=".importing",
                ) as out:
                    temp_path = Path(out.name)
                    with src.open("rb") as inp:
                        while True:
                            chunk = inp.read(copy_chunk_size)
                            if not chunk:
                                break
                            if await request.is_disconnected():
                                raise HTTPException(status_code=499, detail="Upload canceled by client")
                            out.write(chunk)

                if temp_path is None or not temp_path.exists():
                    raise RuntimeError("Temporary import file was not created")

                temp_path.replace(dest)
                imported_count += 1
            except HTTPException:
                if temp_path and temp_path.exists():
                    try:
                        temp_path.unlink()
                    except Exception:
                        pass
                raise
            except Exception as exc:
                failed_count += 1
                if not first_error:
                    first_error = str(exc)
                if temp_path and temp_path.exists():
                    try:
                        temp_path.unlink()
                    except Exception:
                        pass

    return UploadFolderLocalResponse(
        imported_count=imported_count,
        failed_count=failed_count,
        first_error=first_error,
        root_name=import_root_dir.name,
    )


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


