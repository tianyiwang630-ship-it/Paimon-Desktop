from __future__ import annotations

from typing import Any, Dict, List, Optional

from agent.core.providers.base import BaseProviderAdapter, ProviderRequestValidationError


class KimiProviderAdapter(BaseProviderAdapter):
    kind = "kimi"

    @staticmethod
    def _is_thinking_model(model_name: str) -> bool:
        return "kimi-thinking-preview" in str(model_name or "").strip().lower()

    def validate_request(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]],
        model_name: str,
    ) -> None:
        if self._is_thinking_model(model_name) and tools:
            raise ProviderRequestValidationError(
                "Kimi model 'kimi-thinking-preview' does not support tool calling. "
                "Choose a non-thinking Kimi model or disable tools for this request."
            )

    def rebuild_message_for_next_round(
        self,
        stored_message: Dict[str, Any],
        active_provider: str,
        active_model_name: str,
    ) -> Dict[str, Any]:
        if stored_message.get("role") != "assistant":
            return super().rebuild_message_for_next_round(stored_message, active_provider, active_model_name)

        if self._is_thinking_model(active_model_name):
            raw_replay = self._replay_assistant_from_raw_payload(
                stored_message,
                active_provider,
                drop_reasoning=True,
            )
            if raw_replay:
                return raw_replay

        if stored_message.get("tool_calls"):
            raw_replay = self._replay_assistant_from_raw_payload(stored_message, active_provider)
            if raw_replay:
                return raw_replay

        return super().rebuild_message_for_next_round(stored_message, active_provider, active_model_name)
