from __future__ import annotations

from dataclasses import dataclass

from agent.core.recovery.state import RecoveryState
from agent.core.recovery.types import RecoveryAction, RecoveryBudgetConfig, RecoveryIssue


@dataclass(frozen=True)
class RecoveryDecision:
    action: RecoveryAction
    message: str


def _is_time_budget_exhausted(
    state: RecoveryState,
    budgets: RecoveryBudgetConfig,
    now_monotonic: float,
) -> bool:
    budget_seconds = max(0, budgets.recovery_total_time_budget_minutes) * 60.0
    if budget_seconds <= 0:
        return False
    return now_monotonic - state.started_at_monotonic >= budget_seconds


def decide_recovery(
    issue: RecoveryIssue,
    state: RecoveryState,
    budgets: RecoveryBudgetConfig,
    now_monotonic: float,
) -> RecoveryDecision:
    if _is_time_budget_exhausted(state, budgets, now_monotonic):
        return RecoveryDecision(
            action="fail",
            message=f"{issue.message} Recovery time budget exhausted.",
        )

    if issue.category == "llm_timeout":
        if state.current_round_llm_timeout_retries >= budgets.llm_timeout_retry_per_round:
            return RecoveryDecision(
                action="fail",
                message=f"{issue.message} Timeout retry budget exhausted for this round.",
            )
        if state.llm_timeout_retry_total_used >= budgets.llm_timeout_retry_total:
            return RecoveryDecision(
                action="fail",
                message=f"{issue.message} Timeout recovery budget exhausted.",
            )
        next_round_attempt = state.current_round_llm_timeout_retries + 1
        next_total_attempt = state.llm_timeout_retry_total_used + 1
        return RecoveryDecision(
            action="retry_llm",
            message=(
                f"{issue.message} Retrying LLM request "
                f"({next_round_attempt}/{budgets.llm_timeout_retry_per_round} this round, "
                f"{next_total_attempt}/{budgets.llm_timeout_retry_total} total)."
            ),
        )

    if issue.category == "tool_protocol_failure":
        if state.tool_protocol_retry_total_used >= budgets.tool_protocol_retry_total:
            return RecoveryDecision(
                action="fail",
                message=f"{issue.message} Textual tool call repair budget exhausted.",
            )
        next_attempt = state.tool_protocol_retry_total_used + 1
        return RecoveryDecision(
            action="retry_with_repair_prompt",
            message=(
                f"{issue.message} Retrying with a tool-call format repair prompt "
                f"({next_attempt}/{budgets.tool_protocol_retry_total})."
            ),
        )

    return RecoveryDecision(
        action="fail",
        message=issue.message,
    )
