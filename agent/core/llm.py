import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from openai import OpenAI

from agent.core.config import (
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_HTTP_CONNECT_TIMEOUT_SECONDS,
    LLM_HTTP_TIMEOUT_SECONDS,
    LLM_MAX_TOKENS,
    LLM_MODEL_NAME,
    LLM_PROVIDER,
    infer_provider_from_base_url,
)
from agent.core.providers.registry import get_provider_adapter
from agent.server.chat_debug import summarize_text, write_chat_debug_event


def _safe_base_url(value: str) -> str:
    try:
        parsed = urlparse(value or "")
        if parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        pass
    return summarize_text(value, preview_chars=60)["preview"]


class LLMClient:
    def __init__(
        self,
        provider: str = None,
        model_name: str = None,
        base_url: str = None,
        api_key: str = None,
    ):
        """
        Initialize LLM client.

        Priority: explicit args > DB config > config.py defaults.
        """
        self.explicit_provider = provider
        self.explicit_model_name = model_name
        self.explicit_base_url = base_url
        self.explicit_api_key = api_key

        self.request_timeout = httpx.Timeout(
            timeout=LLM_HTTP_TIMEOUT_SECONDS,
            connect=LLM_HTTP_CONNECT_TIMEOUT_SECONDS,
        )

    def get_runtime_config(self) -> Dict[str, str]:
        provider = self.explicit_provider
        model_name = self.explicit_model_name
        base_url = self.explicit_base_url
        api_key = self.explicit_api_key

        if not (base_url and api_key and model_name):
            try:
                from agent.core.config import get_llm_config

                db_config = get_llm_config()
                if db_config:
                    provider = provider or db_config.get("provider")
                    base_url = base_url or db_config.get("base_url")
                    api_key = api_key or db_config.get("api_key")
                    model_name = model_name or db_config.get("model_name")
            except Exception:
                pass

        base_url = base_url or LLM_BASE_URL
        api_key = api_key or LLM_API_KEY
        model_name = model_name or LLM_MODEL_NAME
        provider = (provider or LLM_PROVIDER or infer_provider_from_base_url(base_url)).strip().lower()

        return {
            "provider": provider,
            "base_url": base_url,
            "api_key": api_key,
            "model_name": model_name,
        }

    def _create_client(self) -> tuple[OpenAI, Dict[str, str]]:
        config = self.get_runtime_config()
        client = OpenAI(
            base_url=config["base_url"],
            api_key=config["api_key"],
            timeout=self.request_timeout,
        )
        return client, config

    def generate(self, prompt: str, max_tokens: int = LLM_MAX_TOKENS) -> str:
        client, config = self._create_client()
        start_time = time.monotonic()
        write_chat_debug_event(
            "llm_generate_start",
            provider=config["provider"],
            model_name=config["model_name"],
            base_url=_safe_base_url(config["base_url"]),
            max_tokens=max_tokens,
            prompt=summarize_text(prompt),
        )
        try:
            completion = client.chat.completions.create(
                model=config["model_name"],
                messages=[{"role": "user", "content": prompt}],
                max_tokens=max_tokens,
                timeout=self.request_timeout,
            )
        except Exception as exc:
            write_chat_debug_event(
                "llm_generate_error",
                provider=config["provider"],
                model_name=config["model_name"],
                base_url=_safe_base_url(config["base_url"]),
                duration_ms=int((time.monotonic() - start_time) * 1000),
                error={"type": type(exc).__name__, "message": str(exc)},
            )
            raise
        if not completion.choices:
            write_chat_debug_event(
                "llm_generate_success",
                provider=config["provider"],
                model_name=config["model_name"],
                base_url=_safe_base_url(config["base_url"]),
                duration_ms=int((time.monotonic() - start_time) * 1000),
                choices_count=0,
                response=summarize_text(""),
            )
            return ""
        content = completion.choices[0].message.content or ""
        write_chat_debug_event(
            "llm_generate_success",
            provider=config["provider"],
            model_name=config["model_name"],
            base_url=_safe_base_url(config["base_url"]),
            duration_ms=int((time.monotonic() - start_time) * 1000),
            choices_count=len(completion.choices),
            response=summarize_text(content),
        )
        return content

    def generate_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        max_tokens: int = LLM_MAX_TOKENS,
    ) -> Any:
        client, config = self._create_client()
        adapter = get_provider_adapter(config["provider"])
        adapter.validate_request(
            messages=messages,
            tools=tools,
            model_name=config["model_name"],
        )
        kwargs = {
            "model": config["model_name"],
            "messages": messages,
            "max_tokens": max_tokens,
            "timeout": self.request_timeout,
        }

        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        start_time = time.monotonic()
        write_chat_debug_event(
            "llm_generate_with_tools_start",
            provider=config["provider"],
            model_name=config["model_name"],
            base_url=_safe_base_url(config["base_url"]),
            max_tokens=max_tokens,
            messages_count=len(messages or []),
            tools_count=len(tools or []),
        )
        try:
            response = client.chat.completions.create(**kwargs)
        except Exception as exc:
            write_chat_debug_event(
                "llm_generate_with_tools_error",
                provider=config["provider"],
                model_name=config["model_name"],
                base_url=_safe_base_url(config["base_url"]),
                duration_ms=int((time.monotonic() - start_time) * 1000),
                error={"type": type(exc).__name__, "message": str(exc)},
            )
            raise
        choices_count = len(getattr(response, "choices", []) or [])
        write_chat_debug_event(
            "llm_generate_with_tools_success",
            provider=config["provider"],
            model_name=config["model_name"],
            base_url=_safe_base_url(config["base_url"]),
            duration_ms=int((time.monotonic() - start_time) * 1000),
            choices_count=choices_count,
        )
        return response
