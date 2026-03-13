from __future__ import annotations

from typing import Dict

from agent.core.providers.base import BaseProviderAdapter


class SiliconFlowProviderAdapter(BaseProviderAdapter):
    kind = "siliconflow"

    def rebuild_message_for_next_round(
        self,
        stored_message: Dict[str, Any],
        active_provider: str,
        active_model_name: str,
    ) -> Dict[str, Any]:
        if stored_message.get("role") == "assistant":
            return self._rebuild_with_reasoning_content(stored_message, active_provider, active_model_name)
        return super().rebuild_message_for_next_round(stored_message, active_provider, active_model_name)
