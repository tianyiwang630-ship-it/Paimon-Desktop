from __future__ import annotations

from typing import Any

from agent.core.providers.registry import get_provider_adapter
from agent.core.providers.types import NormalizedAssistantTurn


def normalize_assistant_message(provider: str, message: Any) -> NormalizedAssistantTurn:
    return get_provider_adapter(provider).normalize_assistant_message(message)
