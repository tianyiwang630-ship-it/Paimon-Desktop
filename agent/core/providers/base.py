from __future__ import annotations

import json
import re
from abc import ABC
from typing import Any, Dict, List, Optional

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
    for attr in ("role", "content", "tool_calls", "reasoning", "reasoning_details", "reasoning_content"):
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
    _SAFE_RAW_MESSAGE_KEYS = (
        "role",
        "content",
        "tool_calls",
        "tool_call_id",
        "reasoning",
        "reasoning_details",
        "reasoning_content",
        "name",
    )

    def build_request_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return messages

    def validate_request(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]],
        model_name: str,
    ) -> None:
        return None

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
        active_model_name: str,
    ) -> Dict[str, Any]:
        return self._basic_rebuild_message_for_next_round(stored_message)

    def _basic_rebuild_message_for_next_round(self, stored_message: Dict[str, Any]) -> Dict[str, Any]:
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

    def _stored_reasoning_text(self, stored_message: Dict[str, Any]) -> str:
        raw_payload = stored_message.get("raw_payload_json")
        if isinstance(raw_payload, dict):
            for key in ("reasoning_content", "reasoning", "reasoning_details"):
                value = raw_payload.get(key)
                text = self._reasoning_value_to_text(value)
                if text:
                    return text

        for block in stored_message.get("reasoning_blocks") or []:
            if not isinstance(block, dict):
                continue
            text = str(block.get("content") or "").strip()
            if text:
                return text

        return ""

    @staticmethod
    def _reasoning_value_to_text(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            text = value.get("text") or value.get("content")
            if text:
                return str(text).strip()
            return json.dumps(value, ensure_ascii=False)
        if isinstance(value, list):
            parts: List[str] = []
            for item in value:
                text = BaseProviderAdapter._reasoning_value_to_text(item)
                if text:
                    parts.append(text)
            return "\n".join(parts).strip()
        return str(value).strip()

    def _can_use_raw_payload(self, stored_message: Dict[str, Any], active_provider: str) -> bool:
        if active_provider != self.kind:
            return False

        stored_provider = str(stored_message.get("provider") or "").strip().lower()
        if stored_provider and stored_provider != self.kind:
            return False

        raw_payload = stored_message.get("raw_payload_json")
        return isinstance(raw_payload, dict) and bool(raw_payload.get("role"))

    def _build_safe_raw_message(self, raw_payload: Dict[str, Any], drop_reasoning: bool = False) -> Dict[str, Any]:
        rebuilt: Dict[str, Any] = {}
        for key in self._SAFE_RAW_MESSAGE_KEYS:
            if key in raw_payload and raw_payload[key] is not None:
                rebuilt[key] = raw_payload[key]

        if drop_reasoning:
            rebuilt.pop("reasoning", None)
            rebuilt.pop("reasoning_details", None)
            rebuilt.pop("reasoning_content", None)

        return rebuilt

    def _replay_assistant_from_raw_payload(
        self,
        stored_message: Dict[str, Any],
        active_provider: str,
        *,
        drop_reasoning: bool = False,
    ) -> Optional[Dict[str, Any]]:
        if not self._can_use_raw_payload(stored_message, active_provider):
            return None

        raw_payload = stored_message.get("raw_payload_json")
        if not isinstance(raw_payload, dict) or raw_payload.get("role") != "assistant":
            return None

        return self._build_safe_raw_message(raw_payload, drop_reasoning=drop_reasoning)

    def _rebuild_with_reasoning_content(
        self,
        stored_message: Dict[str, Any],
        active_provider: str,
        active_model_name: str,
    ) -> Dict[str, Any]:
        raw_replay = self._replay_assistant_from_raw_payload(stored_message, active_provider)
        if raw_replay:
            return raw_replay

        rebuilt = self._basic_rebuild_message_for_next_round(stored_message)
        reasoning_text = self._stored_reasoning_text(stored_message)
        if reasoning_text:
            rebuilt["reasoning_content"] = reasoning_text
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


class ProviderRequestValidationError(ValueError):
    """Raised when a provider/model/tool combination is known to be unsupported."""
