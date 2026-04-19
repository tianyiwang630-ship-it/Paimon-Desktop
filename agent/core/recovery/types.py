from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from agent.core.config import (
    LLM_TIMEOUT_RETRY_PER_ROUND,
    LLM_TIMEOUT_RETRY_TOTAL,
    RECOVERY_TOTAL_TIME_BUDGET_MINUTES,
    TOOL_PROTOCOL_RETRY_TOTAL,
)


RecoveryCategory = Literal[
    "llm_timeout",
    "tool_protocol_failure",
    "tool_execution_failure",
    "non_recoverable",
]

RecoveryAction = Literal["retry_llm", "retry_with_repair_prompt", "fail"]


@dataclass(frozen=True)
class RecoveryIssue:
    category: RecoveryCategory
    message: str
    detail: Optional[str] = None


@dataclass(frozen=True)
class RecoveryBudgetConfig:
    llm_timeout_retry_per_round: int = LLM_TIMEOUT_RETRY_PER_ROUND
    llm_timeout_retry_total: int = LLM_TIMEOUT_RETRY_TOTAL
    tool_protocol_retry_total: int = TOOL_PROTOCOL_RETRY_TOTAL
    recovery_total_time_budget_minutes: int = RECOVERY_TOTAL_TIME_BUDGET_MINUTES
