from __future__ import annotations

from typing import Any, Dict

from agent.core.providers.base import BaseProviderAdapter


class MiniMaxProviderAdapter(BaseProviderAdapter):
    kind = "minimax"

    def rebuild_message_for_next_round(
        self,
        stored_message: Dict[str, Any],
        active_provider: str,
        active_model_name: str,
    ) -> Dict[str, Any]:
        if (
            active_provider == self.kind
            and stored_message.get("provider") == self.kind
            and stored_message.get("raw_payload_json")
            and "fake_textual_tool_call" not in (stored_message.get("protocol_flags") or [])
        ):
            raw_payload = stored_message.get("raw_payload_json")
            if isinstance(raw_payload, dict) and raw_payload.get("role"):
                return raw_payload
        return super().rebuild_message_for_next_round(stored_message, active_provider, active_model_name)
