"""Opt-in chat diagnostics for connection-error investigations."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

CHAT_DEBUG_ENV_VAR = "PAIMON_DEBUG_CHAT"
CHAT_DEBUG_LOG_NAME = "chat-debug.log"
MAX_STRING_LENGTH = 240
_SENSITIVE_KEY_PARTS = ("api_key", "apikey", "authorization", "token", "secret", "password")
_LOCK = threading.Lock()


def is_chat_debug_enabled() -> bool:
    value = (os.environ.get(CHAT_DEBUG_ENV_VAR) or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def get_runtime_root() -> Path:
    from agent.core.paths import get_runtime_root

    return get_runtime_root()


def get_chat_debug_log_path() -> Path:
    return get_runtime_root() / "workspace" / "logs" / CHAT_DEBUG_LOG_NAME


def summarize_text(value: Any, preview_chars: int = 80) -> dict[str, Any]:
    text = "" if value is None else str(value)
    preview = text[:preview_chars]
    return {
        "length": len(text),
        "preview": preview,
        "truncated": len(text) > preview_chars,
    }


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_sensitive_key(key: Any) -> bool:
    normalized = str(key or "").lower().replace("-", "_")
    return any(part in normalized for part in _SENSITIVE_KEY_PARTS)


def _truncate_string(value: str) -> str:
    if len(value) <= MAX_STRING_LENGTH:
        return value
    return f"{value[:MAX_STRING_LENGTH]}... [truncated]"


def _sanitize(value: Any, *, key: str | None = None, depth: int = 0) -> Any:
    if key is not None and _is_sensitive_key(key):
        return "[redacted]"
    if depth > 8:
        return "[max_depth]"

    if isinstance(value, str):
        return _truncate_string(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, Mapping):
        return {str(item_key): _sanitize(item_value, key=str(item_key), depth=depth + 1) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, depth=depth + 1) for item in value[:50]]
    return _truncate_string(str(value))


def write_chat_debug_event(event: str, layer: str = "backend", **fields: Any) -> bool:
    """Write one JSONL diagnostic event when PAIMON_DEBUG_CHAT is enabled."""
    if not is_chat_debug_enabled():
        return False

    payload = {
        "ts": _utc_now_iso(),
        "event": str(event or "unknown"),
        "layer": str(layer or "backend"),
    }
    payload.update({str(key): _sanitize(value, key=str(key)) for key, value in fields.items()})

    try:
        log_path = get_chat_debug_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(payload, ensure_ascii=False, default=str)
        with _LOCK:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        return True
    except Exception as exc:
        print(f"[chat-debug] failed to write diagnostic event: {exc}")
        return False
