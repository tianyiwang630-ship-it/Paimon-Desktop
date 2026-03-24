"""In-memory chat task registry for async polling endpoints."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

from agent.server.models import ChatRequest, ChatStatusResponse, PermissionRequiredPayload


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_interrupted_text(value: Optional[str]) -> bool:
    text = str(value or "").strip().lower()
    return text.startswith("[interrupted]")


@dataclass
class ChatExecutionResult:
    session_id: str
    status: str
    response: Optional[str] = None
    tool_calls_count: int = 0
    permission_detail: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@dataclass
class ChatTaskRecord:
    request_id: str
    session_id: str
    status: str
    created_at: str
    updated_at: str
    response: Optional[str] = None
    tool_calls_count: int = 0
    permission_detail: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    interrupt_requested: bool = False
    finished_at_monotonic: Optional[float] = None
    pending_request_id: Optional[str] = None


def build_permission_required_detail(session_id: str, event_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "code": "permission_required",
        "session_id": session_id,
        "tool": str(event_data.get("tool") or ""),
        "args": event_data.get("args") or {},
        "tool_call_id": event_data.get("tool_call_id"),
        "pending_request_id": str(event_data.get("pending_request_id") or ""),
        "message": "Permission confirmation required",
    }


def _consume_agent_events(session_id: str, event_iter: Iterable[Dict[str, Any]], agent_history) -> ChatExecutionResult:
    final_response: Optional[str] = None
    tool_calls_count = 0
    permission_detail: Optional[Dict[str, Any]] = None
    history_start_idx = len(agent_history)

    try:
        for event in event_iter:
            event_type = event.get("type")
            event_data = event.get("data")

            if event_type == "tool_start":
                tool_calls_count += 1
                continue

            if event_type == "permission_request":
                permission_detail = build_permission_required_detail(session_id, event_data or {})
                break

            if event_type == "error":
                return ChatExecutionResult(
                    session_id=session_id,
                    status="error",
                    error=str(event_data or "Agent execution failed"),
                    tool_calls_count=tool_calls_count,
                )

            if event_type == "done":
                final_response = str(event_data or "")

    except Exception as exc:
        return ChatExecutionResult(
            session_id=session_id,
            status="error",
            error=str(exc),
            tool_calls_count=tool_calls_count,
        )

    finally:
        if event_iter is not None:
            try:
                event_iter.close()
            except Exception:
                pass

    if permission_detail is not None:
        return ChatExecutionResult(
            session_id=session_id,
            status="permission_required",
            permission_detail=permission_detail,
            tool_calls_count=tool_calls_count,
        )

    if not (final_response or "").strip():
        for msg in reversed(agent_history[history_start_idx:]):
            if msg.get("role") != "assistant":
                continue
            text = str(msg.get("content") or "").strip()
            if text:
                final_response = text
                break

    if not (final_response or "").strip():
        final_response = "No final response was generated in this run. Open intermediate steps to inspect progress."

    status = "interrupted" if _is_interrupted_text(final_response) else "success"
    return ChatExecutionResult(
        session_id=session_id,
        status=status,
        response=final_response,
        tool_calls_count=tool_calls_count,
    )


def execute_chat_request(agent_manager, body: ChatRequest) -> ChatExecutionResult:
    try:
        agent = agent_manager.get_or_create(body.session_id, project_id=body.project_id)
    except Exception as exc:
        return ChatExecutionResult(
            session_id=body.session_id,
            status="error",
            error=f"Agent creation failed: {exc}",
        )

    event_iter = None
    try:
        event_iter = agent.run_events_locked(
            body.message,
            resume=body.resume,
            user_persisted=False,
        )
        return _consume_agent_events(body.session_id, event_iter, agent.history)
    finally:
        if event_iter is not None:
            try:
                event_iter.close()
            except Exception:
                pass


def execute_pending_permission_request(agent_manager, session_id: str, pending_request_id: str) -> ChatExecutionResult:
    try:
        agent = agent_manager.get_agent(session_id)
    except Exception as exc:
        return ChatExecutionResult(
            session_id=session_id,
            status="error",
            error=f"Agent lookup failed: {exc}",
        )

    if not agent:
        return ChatExecutionResult(
            session_id=session_id,
            status="error",
            error="Session is not active",
        )

    event_iter = None
    try:
        event_iter = agent.run_pending_tool_events_locked(pending_request_id)
        return _consume_agent_events(session_id, event_iter, agent.history)
    finally:
        if event_iter is not None:
            try:
                event_iter.close()
            except Exception:
                pass


class ChatTaskManager:
    """Keep async chat task state in memory for polling APIs."""

    def __init__(self, agent_manager, retention_seconds: int = 1800, cleanup_interval_seconds: int = 60):
        self._agent_manager = agent_manager
        self._retention_seconds = retention_seconds
        self._cleanup_interval_seconds = cleanup_interval_seconds
        self._tasks: dict[str, ChatTaskRecord] = {}
        self._running_by_session: dict[str, str] = {}
        self._pending_request_tasks: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        self._cleanup_thread.start()

    def start_task(self, body: ChatRequest) -> ChatTaskRecord:
        request_id = uuid.uuid4().hex
        now_iso = _utc_now_iso()

        with self._lock:
            running_id = self._running_by_session.get(body.session_id)
            if running_id:
                existing = self._tasks.get(running_id)
                if existing and existing.status == "running":
                    raise RuntimeError("Session already has an active chat request")
                self._running_by_session.pop(body.session_id, None)

            record = ChatTaskRecord(
                request_id=request_id,
                session_id=body.session_id,
                status="running",
                created_at=now_iso,
                updated_at=now_iso,
            )
            self._tasks[request_id] = record
            self._running_by_session[body.session_id] = request_id

        worker = threading.Thread(target=self._run_task, args=(request_id, body), daemon=True)
        worker.start()
        return self.get_task_or_raise(request_id)

    def start_pending_permission_task(self, session_id: str, pending_request_id: str) -> ChatTaskRecord:
        key = (session_id, pending_request_id)
        now_iso = _utc_now_iso()

        with self._lock:
            existing_request_id = self._pending_request_tasks.get(key)
            if existing_request_id:
                existing_record = self._tasks.get(existing_request_id)
                if existing_record is not None:
                    return ChatTaskRecord(**existing_record.__dict__)
                self._pending_request_tasks.pop(key, None)

            running_id = self._running_by_session.get(session_id)
            if running_id:
                existing = self._tasks.get(running_id)
                if existing and existing.status == "running":
                    raise RuntimeError("Session already has an active chat request")
                self._running_by_session.pop(session_id, None)

            request_id = uuid.uuid4().hex
            record = ChatTaskRecord(
                request_id=request_id,
                session_id=session_id,
                status="running",
                created_at=now_iso,
                updated_at=now_iso,
                pending_request_id=pending_request_id,
            )
            self._tasks[request_id] = record
            self._running_by_session[session_id] = request_id
            self._pending_request_tasks[key] = request_id

        worker = threading.Thread(
            target=self._run_pending_permission_task,
            args=(request_id, session_id, pending_request_id),
            daemon=True,
        )
        worker.start()
        return self.get_task_or_raise(request_id)

    def get_task(self, request_id: str) -> Optional[ChatTaskRecord]:
        with self._lock:
            record = self._tasks.get(request_id)
            if record is None:
                return None
            return ChatTaskRecord(**record.__dict__)

    def get_task_or_raise(self, request_id: str) -> ChatTaskRecord:
        record = self.get_task(request_id)
        if record is None:
            raise KeyError(request_id)
        return record

    def mark_session_interrupt_requested(self, session_id: str) -> None:
        now_iso = _utc_now_iso()
        with self._lock:
            request_id = self._running_by_session.get(session_id)
            if not request_id:
                return
            record = self._tasks.get(request_id)
            if record is None:
                return
            record.interrupt_requested = True
            record.updated_at = now_iso

    def build_status_response(self, request_id: str) -> Optional[ChatStatusResponse]:
        record = self.get_task(request_id)
        if record is None:
            return None

        created_ts = self._parse_iso(record.created_at)
        updated_ts = self._parse_iso(record.updated_at)
        elapsed_ms = None
        if created_ts is not None and updated_ts is not None:
            elapsed_ms = max(0, int((updated_ts - created_ts) * 1000))

        permission_detail = None
        if record.permission_detail:
            permission_detail = PermissionRequiredPayload(**record.permission_detail)

        return ChatStatusResponse(
            request_id=record.request_id,
            session_id=record.session_id,
            status=record.status,
            response=record.response,
            tool_calls_count=record.tool_calls_count,
            permission_detail=permission_detail,
            error=record.error,
            created_at=record.created_at,
            updated_at=record.updated_at,
            elapsed_ms=elapsed_ms,
        )

    def close(self) -> None:
        self._stop_event.set()
        self._cleanup_thread.join(timeout=5)

    def _run_task(self, request_id: str, body: ChatRequest) -> None:
        result = execute_chat_request(self._agent_manager, body)
        self._finalize_task_result(request_id, result)

    def _run_pending_permission_task(self, request_id: str, session_id: str, pending_request_id: str) -> None:
        result = execute_pending_permission_request(self._agent_manager, session_id, pending_request_id)
        self._finalize_task_result(request_id, result)

    def _finalize_task_result(self, request_id: str, result: ChatExecutionResult) -> None:
        completed_at = _utc_now_iso()

        with self._lock:
            record = self._tasks.get(request_id)
            if record is None:
                return

            final_status = result.status
            if record.interrupt_requested and final_status == "success":
                final_status = "interrupted"
                if not _is_interrupted_text(result.response):
                    result.response = result.response or "[interrupted] Stopped by user."

            record.status = final_status
            record.response = result.response
            record.tool_calls_count = result.tool_calls_count
            record.permission_detail = result.permission_detail
            record.error = result.error
            record.updated_at = completed_at
            record.finished_at_monotonic = time.monotonic()

            active_request_id = self._running_by_session.get(record.session_id)
            if active_request_id == request_id:
                self._running_by_session.pop(record.session_id, None)

    def _cleanup_loop(self) -> None:
        while not self._stop_event.wait(timeout=self._cleanup_interval_seconds):
            self._cleanup_finished_tasks()

    def _cleanup_finished_tasks(self) -> None:
        cutoff = time.monotonic() - self._retention_seconds
        with self._lock:
            expired_ids = [
                request_id
                for request_id, record in self._tasks.items()
                if record.status != "running"
                and record.finished_at_monotonic is not None
                and record.finished_at_monotonic < cutoff
            ]
            for request_id in expired_ids:
                record = self._tasks.pop(request_id, None)
                if not record:
                    continue
                if self._running_by_session.get(record.session_id) == request_id:
                    self._running_by_session.pop(record.session_id, None)
                if record.pending_request_id:
                    key = (record.session_id, record.pending_request_id)
                    if self._pending_request_tasks.get(key) == request_id:
                        self._pending_request_tasks.pop(key, None)

    @staticmethod
    def _parse_iso(value: str) -> Optional[float]:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
