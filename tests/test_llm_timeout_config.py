from agent.core.config import LLM_HTTP_TIMEOUT_SECONDS


def test_llm_http_timeout_allows_five_minute_generation():
    assert LLM_HTTP_TIMEOUT_SECONDS == 300.0
