from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal


ProviderKind = Literal["openai", "minimax", "zhipu", "kimi"]


@dataclass
class NormalizedToolCall:
    id: str
    name: str
    arguments_json: str


@dataclass
class ReasoningBlock:
    type: str
    content: str
    raw: Dict[str, Any] | None = None


@dataclass
class NormalizedAssistantTurn:
    provider: str
    visible_content: str
    raw_content: str
    tool_calls: List[NormalizedToolCall] = field(default_factory=list)
    reasoning_blocks: List[ReasoningBlock] = field(default_factory=list)
    raw_provider_message: Dict[str, Any] = field(default_factory=dict)
    protocol_flags: List[str] = field(default_factory=list)
