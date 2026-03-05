from __future__ import annotations

import json
import re
from abc import ABC
from typing import Any, Dict, List

from agent.core.providers.types import NormalizedAssistantTurn, NormalizedToolCall, ReasoningBlock


_FAKE_TOOL_PATTERNS = (
    r"\[TOOL_CALL\]",
    r"\[/TOOL_CALL\]",
    r"<invoke\b",
    r"</invoke>",
    r"<minimax:tool_call>",
    r"<parameter\s+name=",
)


def detect_protocol_flags(content: str, has_tool_calls: bool) -> List[str]:
    if has_tool_calls:
        return []
    text = str(content or "")
    if any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in _FAKE_TOOL_PATTERNS):
        return ["fake_textual_tool_call"]
    return []


def serialize_provider_message(message: Any) -> Dict[str, Any]:
    if hasattr(message, "model_dump"):
        try:
            return message.model_dump(mode="json", exclude_none=False)
        except TypeError:
            return message.model_dump(exclude_none=False)
    if isinstance(message, dict):
        return dict(message)
    result: Dict[str, Any] = {}
    for attr in ("role", "content", "tool_calls", "reasoning", "reasoning_details"):
        try:
            value = getattr(message, attr)
        except Exception:
            continue
        if value is not None:
            result[attr] = value
    return result


def coerce_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content") or ""
                if text:
                    parts.append(str(text))
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(value)


def extract_reasoning_blocks(raw_message: Dict[str, Any]) -> List[ReasoningBlock]:
    blocks: List[ReasoningBlock] = []
    for key in ("reasoning_details", "reasoning", "reasoning_content"):
        value = raw_message.get(key)
        if not value:
            continue
        if isinstance(value, str):
            blocks.append(ReasoningBlock(type="text", content=value, raw={"value": value}))
        elif isinstance(value, dict):
            content = value.get("text") or value.get("content") or json.dumps(value, ensure_ascii=False)
            blocks.append(ReasoningBlock(type=str(value.get("type") or "text"), content=str(content), raw=value))
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    content = item.get("text") or item.get("content") or json.dumps(item, ensure_ascii=False)
                    blocks.append(
                        ReasoningBlock(
                            type=str(item.get("type") or "text"),
                            content=str(content),
                            raw=item,
                        )
                    )
                else:
                    blocks.append(ReasoningBlock(type="text", content=str(item), raw={"value": item}))
    return blocks


class BaseProviderAdapter(ABC):
    kind: str = "openai"

    def build_request_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return messages

    def normalize_assistant_message(self, message: Any) -> NormalizedAssistantTurn:
        raw_message = serialize_provider_message(message)
        tool_calls = self._extract_tool_calls(message, raw_message)
        raw_content = coerce_content(raw_message.get("content"))
        return NormalizedAssistantTurn(
            provider=self.kind,
            visible_content=raw_content,
            raw_content=raw_content,
            tool_calls=tool_calls,
            reasoning_blocks=extract_reasoning_blocks(raw_message),
            raw_provider_message=raw_message,
            protocol_flags=detect_protocol_flags(raw_content, bool(tool_calls)),
        )

    def rebuild_message_for_next_round(
        self,
        stored_message: Dict[str, Any],
        active_provider: str,
    ) -> Dict[str, Any]:
        role = stored_message.get("role")
        rebuilt: Dict[str, Any] = {"role": role}

        if role == "tool":
            rebuilt["tool_call_id"] = stored_message.get("tool_call_id")
            rebuilt["content"] = stored_message.get("content") or ""
            return rebuilt

        if role == "assistant" and stored_message.get("tool_calls"):
            rebuilt["content"] = stored_message.get("content")
            rebuilt["tool_calls"] = stored_message.get("tool_calls")
            return rebuilt

        rebuilt["content"] = stored_message.get("content") or ""
        return rebuilt

    def _extract_tool_calls(self, message: Any, raw_message: Dict[str, Any]) -> List[NormalizedToolCall]:
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls is None:
            tool_calls = raw_message.get("tool_calls") or []

        normalized: List[NormalizedToolCall] = []
        for index, tool_call in enumerate(tool_calls or []):
            if hasattr(tool_call, "function"):
                fn = getattr(tool_call, "function", None)
                name = str(getattr(fn, "name", "") or "")
                arguments = str(getattr(fn, "arguments", "") or "{}")
                tool_call_id = str(getattr(tool_call, "id", "") or f"tool_call_{index}")
            elif isinstance(tool_call, dict):
                fn = tool_call.get("function") or {}
                name = str(fn.get("name") or "")
                arguments = str(fn.get("arguments") or "{}")
                tool_call_id = str(tool_call.get("id") or f"tool_call_{index}")
            else:
                continue

            if not name:
                continue
            normalized.append(
                NormalizedToolCall(
                    id=tool_call_id,
                    name=name,
                    arguments_json=arguments,
                )
            )
        return normalized
