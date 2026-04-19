import sys
import types
from pathlib import Path


if "openai" not in sys.modules:
    sys.modules["openai"] = types.SimpleNamespace(OpenAI=object)
if "tiktoken" not in sys.modules:
    sys.modules["tiktoken"] = types.SimpleNamespace(
        get_encoding=lambda _name: types.SimpleNamespace(encode=lambda text: list(str(text or "")))
    )

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

from agent.core.recovery.policy import decide_recovery
from agent.core.recovery.state import RecoveryState
from agent.core.recovery.types import RecoveryBudgetConfig, RecoveryIssue


def test_timeout_retries_allowed_within_budgets():
    state = RecoveryState(started_at_monotonic=0.0)
    budgets = RecoveryBudgetConfig(
        llm_timeout_retry_per_round=2,
        llm_timeout_retry_total=4,
        tool_protocol_retry_total=2,
        recovery_total_time_budget_minutes=30,
    )
    issue = RecoveryIssue(category="llm_timeout", message="Request timed out.")

    decision = decide_recovery(issue, state, budgets, now_monotonic=10.0)

    assert decision.action == "retry_llm"
    assert "retry" in decision.message.lower()


def test_timeout_retries_fail_after_total_budget_exhausted():
    state = RecoveryState(
        started_at_monotonic=0.0,
        llm_timeout_retry_total_used=4,
        current_round_llm_timeout_retries=1,
    )
    budgets = RecoveryBudgetConfig(
        llm_timeout_retry_per_round=2,
        llm_timeout_retry_total=4,
        tool_protocol_retry_total=2,
        recovery_total_time_budget_minutes=30,
    )
    issue = RecoveryIssue(category="llm_timeout", message="Request timed out.")

    decision = decide_recovery(issue, state, budgets, now_monotonic=20.0)

    assert decision.action == "fail"
    assert "budget" in decision.message.lower()


def test_protocol_retries_fail_after_protocol_budget_exhausted():
    state = RecoveryState(
        started_at_monotonic=0.0,
        tool_protocol_retry_total_used=2,
    )
    budgets = RecoveryBudgetConfig(
        llm_timeout_retry_per_round=2,
        llm_timeout_retry_total=4,
        tool_protocol_retry_total=2,
        recovery_total_time_budget_minutes=30,
    )
    issue = RecoveryIssue(category="tool_protocol_failure", message="Provider returned a textual tool call.")

    decision = decide_recovery(issue, state, budgets, now_monotonic=30.0)

    assert decision.action == "fail"
    assert "textual tool call" in decision.message.lower()


def test_protocol_retries_fail_after_total_time_budget_exhausted():
    state = RecoveryState(started_at_monotonic=0.0)
    budgets = RecoveryBudgetConfig(
        llm_timeout_retry_per_round=2,
        llm_timeout_retry_total=4,
        tool_protocol_retry_total=2,
        recovery_total_time_budget_minutes=30,
    )
    issue = RecoveryIssue(category="tool_protocol_failure", message="Provider returned a textual tool call.")

    decision = decide_recovery(issue, state, budgets, now_monotonic=31 * 60.0)

    assert decision.action == "fail"
    assert "time budget" in decision.message.lower()
