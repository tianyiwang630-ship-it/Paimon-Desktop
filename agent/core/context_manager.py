"""
Context manager for token accounting and history compression.
"""

import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

import tiktoken

from agent.core.config import (
    COMPRESSION_INPUT_RATIO,
    COMPRESSION_THRESHOLD,
    KEEP_RECENT_TURNS,
    LLM_SUMMARY_MAX_TOKENS,
    MAX_CONTEXT_TOKENS,
    TIKTOKEN_ENCODING,
)


class ContextManager:
    """Track context budget and compress old history safely."""

    def __init__(
        self,
        llm,
        tools: List[Dict],
        system_prompt: str,
        max_context_tokens: int = MAX_CONTEXT_TOKENS,
        keep_recent_turns: int = KEEP_RECENT_TURNS,
    ):
        self.llm = llm
        self.encoding = tiktoken.get_encoding(TIKTOKEN_ENCODING)

        self.max_context_tokens = max_context_tokens
        self.keep_recent_turns = keep_recent_turns
        self.compression_threshold = COMPRESSION_THRESHOLD

        self.system_tokens = self.count_tokens(system_prompt)
        self.tools_tokens = self._count_tools_tokens(tools)
        self._tools_count = len(tools)
        self.available_for_history = (
            self.max_context_tokens - self.system_tokens - self.tools_tokens
        )

        print("[Context] Budget initialized")
        print(f"   - Max context: {self.max_context_tokens:,} tokens")
        print(f"   - System: {self.system_tokens:,} tokens")
        print(f"   - Tools: {self.tools_tokens:,} tokens")
        print(f"   - History available: {self.available_for_history:,} tokens")

    def refresh_tool_budget(self, tools: List[Dict]) -> bool:
        """Recompute tool token cost if the tool list has changed."""
        current_count = len(tools)
        if current_count == self._tools_count:
            return False

        self.tools_tokens = self._count_tools_tokens(tools)
        self.available_for_history = (
            self.max_context_tokens - self.system_tokens - self.tools_tokens
        )
        self._tools_count = current_count

        print("\n[Context] Tool set changed, budget refreshed")
        print(f"   - Tools: {self.tools_tokens:,} tokens")
        print(f"   - History available: {self.available_for_history:,} tokens")
        return True

    def count_tokens(self, text: str) -> int:
        """Count tokens for a single text string."""
        if not text:
            return 0
        return len(self.encoding.encode(text))

    def count_history_tokens(self, history: List[Dict]) -> int:
        """Count total tokens used by chat history."""
        total = 0
        for msg in history:
            if msg.get("role") in ["user", "assistant", "tool"]:
                content = msg.get("content", "")
                if content:
                    total += self.count_tokens(content)

                if msg.get("tool_calls"):
                    tool_calls_json = json.dumps(msg["tool_calls"])
                    total += self.count_tokens(tool_calls_json)
        return total

    def should_compress(self, history: List[Dict]) -> bool:
        """Return True if history should be compressed."""
        sanitized = self.sanitize_history(history)
        if len(sanitized) <= self.keep_recent_turns:
            return False

        history_tokens = self.count_history_tokens(sanitized)
        threshold = int(self.available_for_history * self.compression_threshold)
        should = history_tokens > threshold

        if should:
            print(
                "\n[Context] Compression trigger: "
                f"{history_tokens:,}/{threshold:,} tokens "
                f"(threshold {self.compression_threshold * 100:.0f}%)"
            )

        return should

    def sanitize_history(self, history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Build a model-safe history sequence.

        Strategy:
        - Drop orphan tool messages that are not tied to a pending tool call.
        - If pending tool calls are not fully matched before the next non-tool
          message, strip `tool_calls` from that assistant message.
        """
        sanitized: List[Dict[str, Any]] = []

        pending_ids: List[str] = []
        seen_ids: set[str] = set()
        pending_assistant_idx: Optional[int] = None

        def finalize_pending() -> None:
            nonlocal pending_ids, seen_ids, pending_assistant_idx
            if pending_ids and pending_assistant_idx is not None:
                missing = [tc_id for tc_id in pending_ids if tc_id not in seen_ids]
                if missing:
                    fixed = dict(sanitized[pending_assistant_idx])
                    fixed.pop("tool_calls", None)
                    sanitized[pending_assistant_idx] = fixed
            pending_ids = []
            seen_ids = set()
            pending_assistant_idx = None

        for msg in history or []:
            role = msg.get("role")

            if pending_ids:
                if role == "tool":
                    tcid = msg.get("tool_call_id")
                    if tcid and tcid in pending_ids:
                        sanitized.append(msg)
                        seen_ids.add(tcid)
                        if all(tc_id in seen_ids for tc_id in pending_ids):
                            finalize_pending()
                        continue
                    # Orphan or unrelated tool result while waiting for pending ids.
                    continue
                # Any non-tool message closes pending tool-call window.
                finalize_pending()

            if role == "assistant" and msg.get("tool_calls"):
                tool_calls = msg.get("tool_calls") or []
                tc_ids = [
                    tc_id
                    for tc in tool_calls
                    if isinstance(tc, dict)
                    for tc_id in [tc.get("id")]
                    if isinstance(tc_id, str) and tc_id
                ]
                sanitized.append(msg)
                if tc_ids:
                    pending_ids = tc_ids
                    seen_ids = set()
                    pending_assistant_idx = len(sanitized) - 1
                else:
                    # Malformed payload.
                    fixed = dict(msg)
                    fixed.pop("tool_calls", None)
                    sanitized[-1] = fixed
                continue

            if role == "tool":
                # Orphan tool message.
                continue

            sanitized.append(msg)

        if pending_ids:
            finalize_pending()

        return sanitized

    def compress_history(self, history: List[Dict]) -> List[Dict]:
        """Compress old history into one summary message plus recent turns."""
        print("\n[Context] Compressing history...")

        sanitized_history = self.sanitize_history(history)
        if len(sanitized_history) <= self.keep_recent_turns:
            print("[Context] Nothing to compress")
            return sanitized_history

        recent_history = sanitized_history[-self.keep_recent_turns :]
        old_history = sanitized_history[: -self.keep_recent_turns]

        if not old_history:
            print("[Context] Nothing to compress")
            return sanitized_history

        old_tokens = self.count_history_tokens(old_history)
        print(f"   - Before: {len(old_history)} messages, {old_tokens:,} tokens")

        summary_error = ""
        summary_md = ""
        try:
            summary_md = self._generate_summary(old_history)
            summary_md = self._clean_summary_text(summary_md)
            if not summary_md:
                raise ValueError("LLM summary became empty after cleaning")
        except Exception as e:
            summary_error = str(e)
            print(f"[Context] LLM summary failed: {summary_error}; using fallback summary")
            summary_md = self._build_fallback_summary(old_history, summary_error)

        if not summary_md:
            print("[Context] Fallback summary is empty; using safe tail truncation")
            return self._safe_tail_truncate(sanitized_history, self.keep_recent_turns * 2)

        summary_tokens = self.count_tokens(summary_md)
        new_history = self.sanitize_history([{"role": "user", "content": summary_md}] + recent_history)

        if not new_history:
            print("[Context] Sanitized compressed history became empty; using safe tail truncation")
            return self._safe_tail_truncate(sanitized_history, self.keep_recent_turns * 2)

        compression_ratio = (1 - summary_tokens / old_tokens) * 100 if old_tokens > 0 else 0
        print(f"   - After: 1 summary message, {summary_tokens:,} tokens")
        print(f"   - Compression ratio: {compression_ratio:.1f}%")
        if summary_error:
            print("   - Summary mode: fallback")
        print(f"[Context] Compression complete, kept recent {self.keep_recent_turns} turns\n")
        return new_history

    def _safe_tail_truncate(self, history: List[Dict], keep_messages: int) -> List[Dict]:
        """Truncate history from tail and sanitize to avoid orphan tool chains."""
        if keep_messages <= 0:
            return []
        return self.sanitize_history(history[-keep_messages:])

    def _count_tools_tokens(self, tools: List[Dict]) -> int:
        """Estimate tokens occupied by tool schema list."""
        tools_json = json.dumps(tools)
        return self.count_tokens(tools_json)

    def _clean_summary_text(self, text: str) -> str:
        """Normalize summary text and remove model-only artifacts."""
        cleaned = (text or "").strip()
        if not cleaned:
            return ""

        # Remove hidden thinking blocks.
        cleaned = re.sub(r"(?is)<think>.*?</think>", "", cleaned).strip()

        # Prefer markdown code fence payload if present.
        fenced_blocks = re.findall(
            r"```(?:markdown|md)?\s*([\s\S]*?)```", cleaned, flags=re.IGNORECASE
        )
        if fenced_blocks:
            candidates = [block.strip() for block in fenced_blocks if block and block.strip()]
            if candidates:
                cleaned = max(candidates, key=len)

        cleaned = cleaned.strip("` \n\r\t")
        return cleaned

    def _build_fallback_summary(self, old_history: List[Dict], error_text: str = "") -> str:
        """Build deterministic markdown summary when LLM summary fails."""
        lines: List[str] = [
            "# Conversation Compression Summary",
            "",
            "## Compression Status",
            f"- Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "- Mode: fallback",
        ]
        if error_text:
            lines.append(f"- Reason: {error_text[:240]}")

        lines.extend(["", "## Timeline"])

        max_steps = 24
        picked = old_history[-max_steps:]
        for msg in picked:
            role = (msg.get("role") or "").strip().lower()
            content = (msg.get("content") or "").replace("\r", " ").replace("\n", " ").strip()
            content = re.sub(r"\s+", " ", content)
            if len(content) > 220:
                content = content[:220].rstrip() + "..."

            if role == "assistant" and msg.get("tool_calls"):
                names = []
                for tc in msg.get("tool_calls") or []:
                    if isinstance(tc, dict):
                        fn = (
                            (tc.get("function") or {}).get("name")
                            if isinstance(tc.get("function"), dict)
                            else None
                        )
                        if isinstance(fn, str) and fn:
                            names.append(fn)
                if names:
                    lines.append(f"- Assistant planned tool calls: {', '.join(names)}")
                elif content:
                    lines.append(f"- Assistant: {content}")
                continue

            if role == "tool":
                tcid = msg.get("tool_call_id") or "unknown"
                if content:
                    lines.append(f"- Tool[{tcid}]: {content}")
                continue

            if role in {"user", "assistant"} and content:
                lines.append(f"- {role.capitalize()}: {content}")

        # Heuristic file path extraction from old messages.
        path_pattern = re.compile(
            r"([A-Za-z]:\\[^\s\"'`]+|/(?:[^\s\"'`]+/)*[^\s\"'`]+)"
        )
        found_paths: List[str] = []
        for msg in old_history[-40:]:
            text = (msg.get("content") or "")
            for match in path_pattern.findall(text):
                candidate = match.strip()
                if len(candidate) < 4:
                    continue
                if candidate not in found_paths:
                    found_paths.append(candidate)
                if len(found_paths) >= 20:
                    break
            if len(found_paths) >= 20:
                break

        if found_paths:
            lines.extend(["", "## Important Paths"])
            for p in found_paths[:12]:
                lines.append(f"- {p}")

        summary = "\n".join(lines).strip()

        # Keep fallback summary bounded.
        max_chars = 12000
        if len(summary) > max_chars:
            summary = summary[:max_chars].rstrip() + "\n..."

        return summary

    def _generate_summary(self, old_history: List[Dict]) -> str:
        """Ask LLM to produce a concise markdown summary of old history."""
        summary_prompt = """# Task: Compress chat history into a markdown summary

Output markdown directly. Include these sections when applicable:

## Timeline
- Keep key cause->action->result steps only.
- Merge repeated actions.

## Key Tool Calls
- Include side-effecting calls (write/edit/bash with changes).
- Skip purely read-only calls unless they are critical.

## Important Files
- List created/modified/deleted files using full paths.

## Current State
- What is done, what was interrupted, and what should happen next.

## Error Memory
- Record useful errors: symptom, cause, fix, lesson.

## User Intent Changes
- Keep requirement changes or explicit user preferences.

Compression rules:
1. Remove duplication.
2. Keep causal links.
3. Keep concrete artifacts (file paths, values, outputs).
4. Optimize for seamless continuation.

Now summarize the following history in markdown:
"""

        safe_old_history = self.sanitize_history(old_history)
        history_text = json.dumps(safe_old_history, ensure_ascii=False, indent=2)
        max_summary_input = int(self.max_context_tokens * COMPRESSION_INPUT_RATIO)
        if self.count_tokens(history_text) > max_summary_input:
            kept = []
            running = 0
            for msg in reversed(safe_old_history):
                t = self.count_tokens(json.dumps(msg, ensure_ascii=False))
                if running + t > max_summary_input:
                    break
                kept.append(msg)
                running += t
            kept.reverse()
            history_text = json.dumps(kept, ensure_ascii=False, indent=2)
            print(
                f"   - Summary input truncated: kept {len(kept)}/{len(safe_old_history)} messages"
            )

        full_prompt = summary_prompt + "\n" + history_text

        print("   - Generating summary...")
        response = self.llm.generate(full_prompt, max_tokens=LLM_SUMMARY_MAX_TOKENS)

        if not response or not response.strip():
            raise ValueError("LLM returned empty summary")

        return response.strip()
