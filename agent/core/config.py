"""
Configuration constants for Agent core components.
Single source of truth for system-wide settings.
"""

# ========== Context Management ==========
MAX_CONTEXT_TOKENS = 150000  # Total context limit
KEEP_RECENT_TURNS = 10  # Turns to preserve during compression
COMPRESSION_THRESHOLD = 0.5  # Compress when history reaches 50% of available space
COMPRESSION_INPUT_RATIO = 0.9  # Summary LLM can receive up to 90% of max tokens

# ========== Tool Execution ==========
MAX_TOOL_RESULT_CHARS = 10000  # Truncate individual tool results
BASH_TOOL_TIMEOUT = 300  # Bash tool execution timeout (seconds)

# ========== LLM Responses ==========
LLM_MAX_TOKENS = 20000  # Default max tokens for LLM generation
LLM_SUMMARY_MAX_TOKENS = 4000  # Max tokens for compression summary
LLM_HTTP_TIMEOUT_SECONDS = 180.0  # End-to-end timeout per LLM request
LLM_HTTP_CONNECT_TIMEOUT_SECONDS = 20.0  # Connect timeout for LLM HTTP calls

# ========== Encoding ==========
TIKTOKEN_ENCODING = "cl100k_base"  # Encoding for token counting

# ========== MCP Tool Search ==========
DEFAULT_MCP_CATEGORY = "searchable"  # Default category for MCP servers not in registry.json

# ========== LLM Configuration ==========
import os
from urllib.parse import urlparse

# Defaults are non-secret; API key must be provided by env or settings DB.
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "minimax")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.minimaxi.com/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "MiniMax-M2.5")
SUPPORTED_LLM_PROVIDERS = {"openai", "minimax", "zhipu", "kimi"}


def infer_provider_from_base_url(base_url: str | None) -> str:
    """Infer provider from a configured base URL."""
    value = (base_url or "").strip()
    if not value:
        return "openai"

    try:
        host = (urlparse(value).netloc or value).lower()
    except Exception:
        host = value.lower()

    if "minimaxi" in host:
        return "minimax"
    if "bigmodel" in host:
        return "zhipu"
    if "moonshot" in host or "kimi" in host:
        return "kimi"
    if "openai" in host:
        return "openai"
    return "openai"


def get_llm_config() -> dict | None:
    """Read LLM config from settings DB if fully configured."""
    try:
        from agent.core.database import Database

        db = Database()
        provider = db.get_setting("llm_provider")
        base_url = db.get_setting("llm_base_url")
        api_key = db.get_setting("llm_api_key")
        model_name = db.get_setting("llm_model_name")
        if base_url and api_key and model_name:
            normalized_provider = str(provider or "").strip().lower()
            if normalized_provider not in SUPPORTED_LLM_PROVIDERS:
                normalized_provider = infer_provider_from_base_url(base_url)
            return {
                "provider": normalized_provider,
                "base_url": base_url,
                "api_key": api_key,
                "model_name": model_name,
            }
    except Exception:
        pass
    return None
