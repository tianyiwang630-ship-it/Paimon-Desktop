from __future__ import annotations

from dataclasses import dataclass

from agent.core.recovery.types import RecoveryIssue


@dataclass
class RecoveryState:
    started_at_monotonic: float
    llm_timeout_retry_total_used: int = 0
    tool_protocol_retry_total_used: int = 0
    current_round_llm_timeout_retries: int = 0
    last_recovery_category: str = ""
    last_recovery_message: str = ""

    def begin_round(self) -> None:
        self.current_round_llm_timeout_retries = 0

    def record_retry(self, issue: RecoveryIssue) -> None:
        self.last_recovery_category = issue.category
        self.last_recovery_message = issue.message
        if issue.category == "llm_timeout":
            self.current_round_llm_timeout_retries += 1
            self.llm_timeout_retry_total_used += 1
        elif issue.category == "tool_protocol_failure":
            self.tool_protocol_retry_total_used += 1
