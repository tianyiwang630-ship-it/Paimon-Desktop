import sys
import types
from pathlib import Path

import pytest


if "openai" not in sys.modules:
    sys.modules["openai"] = types.SimpleNamespace(OpenAI=object)
if "tiktoken" not in sys.modules:
    sys.modules["tiktoken"] = types.SimpleNamespace(
        get_encoding=lambda _name: types.SimpleNamespace(encode=lambda text: list(str(text or "")))
    )

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

from agent.core.config import infer_provider_from_base_url
from agent.core.main import Agent
from agent.core.providers.base import ProviderRequestValidationError
from agent.core.providers.kimi_adapter import KimiProviderAdapter
from agent.core.providers.openai_adapter import OpenAIProviderAdapter
from agent.core.providers.siliconflow_adapter import SiliconFlowProviderAdapter
from agent.core.providers.zhipu_adapter import ZhipuProviderAdapter


def test_infer_provider_from_base_url_detects_siliconflow():
    assert infer_provider_from_base_url("https://api.siliconflow.cn/v1") == "siliconflow"


def test_openai_default_replay_keeps_tool_calls_without_reasoning_payload():
    adapter = OpenAIProviderAdapter()
    rebuilt = adapter.rebuild_message_for_next_round(
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{}"}}],
            "raw_payload_json": {"role": "assistant", "content": "", "tool_calls": [], "reasoning_content": "hidden"},
        },
        "openai",
        "gpt-4.1",
    )
    assert rebuilt["role"] == "assistant"
    assert rebuilt["tool_calls"][0]["id"] == "call_1"
    assert "reasoning_content" not in rebuilt


def test_siliconflow_replay_preserves_reasoning_content_from_raw_payload():
    adapter = SiliconFlowProviderAdapter()
    rebuilt = adapter.rebuild_message_for_next_round(
        {
            "role": "assistant",
            "content": "",
            "provider": "siliconflow",
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{}"}}],
            "raw_payload_json": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{}"}}],
                "reasoning_content": "keep me",
            },
        },
        "siliconflow",
        "deepseek-r1",
    )
    assert rebuilt["reasoning_content"] == "keep me"
    assert rebuilt["tool_calls"][0]["id"] == "call_1"


def test_zhipu_replay_preserves_reasoning_content_from_raw_payload():
    adapter = ZhipuProviderAdapter()
    rebuilt = adapter.rebuild_message_for_next_round(
        {
            "role": "assistant",
            "content": "visible",
            "provider": "zhipu",
            "raw_payload_json": {
                "role": "assistant",
                "content": "visible",
                "reasoning_content": "glm reasoning",
            },
        },
        "zhipu",
        "glm-4.5",
    )
    assert rebuilt["reasoning_content"] == "glm reasoning"


def test_kimi_thinking_preview_rejects_tools():
    adapter = KimiProviderAdapter()
    with pytest.raises(ProviderRequestValidationError):
        adapter.validate_request(
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "search", "parameters": {}}}],
            model_name="kimi-thinking-preview",
        )


def test_kimi_thinking_preview_drops_reasoning_content_on_replay():
    adapter = KimiProviderAdapter()
    rebuilt = adapter.rebuild_message_for_next_round(
        {
            "role": "assistant",
            "content": "visible",
            "provider": "kimi",
            "raw_payload_json": {
                "role": "assistant",
                "content": "visible",
                "reasoning_content": "drop me",
            },
        },
        "kimi",
        "kimi-thinking-preview",
    )
    assert "reasoning_content" not in rebuilt
    assert rebuilt["content"] == "visible"


def test_agent_sanitize_history_preserves_siliconflow_tool_call_reasoning():
    agent = Agent.__new__(Agent)
    agent._get_active_provider = lambda: "siliconflow"
    agent._get_active_model_name = lambda: "deepseek-r1"

    history = [
        {
            "role": "assistant",
            "content": "",
            "provider": "siliconflow",
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{}"}}],
            "raw_payload_json": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{}"}}],
                "reasoning_content": "keep me",
            },
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "ok",
        },
        {
            "role": "assistant",
            "content": "done",
        },
    ]

    sanitized = Agent._sanitize_history_for_llm(agent, history)

    assert sanitized[0]["reasoning_content"] == "keep me"
    assert sanitized[0]["tool_calls"][0]["id"] == "call_1"
    assert sanitized[1]["tool_call_id"] == "call_1"
