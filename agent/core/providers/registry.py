from __future__ import annotations

from agent.core.providers.base import BaseProviderAdapter
from agent.core.providers.kimi_adapter import KimiProviderAdapter
from agent.core.providers.minimax_adapter import MiniMaxProviderAdapter
from agent.core.providers.openai_adapter import OpenAIProviderAdapter
from agent.core.providers.zhipu_adapter import ZhipuProviderAdapter


_ADAPTERS: dict[str, BaseProviderAdapter] = {
    "openai": OpenAIProviderAdapter(),
    "minimax": MiniMaxProviderAdapter(),
    "zhipu": ZhipuProviderAdapter(),
    "kimi": KimiProviderAdapter(),
}


def get_provider_adapter(provider: str | None) -> BaseProviderAdapter:
    return _ADAPTERS.get(str(provider or "").strip().lower(), _ADAPTERS["openai"])
