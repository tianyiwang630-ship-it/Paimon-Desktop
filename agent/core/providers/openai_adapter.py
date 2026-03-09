from __future__ import annotations

from agent.core.providers.base import BaseProviderAdapter


class OpenAIProviderAdapter(BaseProviderAdapter):
    kind = "openai"
