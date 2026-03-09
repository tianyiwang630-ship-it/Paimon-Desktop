"""
Agent core orchestration.

Features:
- Auto-load tools (MCP + Skills + built-ins)
- Multi-turn dialogue
- Tool execution
- Context management
- SQLite-backed session persistence
"""

# ============================================
# Path setup
# ============================================
import sys
from pathlib import Path

# Add project root to Python path
asset_root = Path(__file__).parent.parent.parent
if str(asset_root) not in sys.path:
    sys.path.insert(0, str(asset_root))

# ============================================
# Imports
# ============================================
import json
import time
import threading
import re
from typing import Any, List, Dict, Optional, Literal, cast

try:
    import msvcrt  # Windows keyboard detection
    HAS_MSVCRT = True
except ImportError:
    HAS_MSVCRT = False

from agent.core.llm import LLMClient
from agent.core.tool_loader import ToolLoader, PermissionRequestError
from agent.core.context_manager import ContextManager
from agent.core.database import Database
from agent.core.paths import get_runtime_root
from agent.core.providers.base import detect_protocol_flags
from agent.core.providers.normalizer import normalize_assistant_message
from agent.core.providers.registry import get_provider_adapter
from agent.core.providers.types import NormalizedAssistantTurn, NormalizedToolCall
from agent.core.config import (
    MAX_CONTEXT_TOKENS, KEEP_RECENT_TURNS, MAX_TOOL_RESULT_CHARS
)


class Agent:
    """Chat agent with tool calling and persistent session state."""

    def __init__(
        self,
        session_id: Optional[str] = None,
        max_turns: int = 5000,
        workspace_root: Optional[str] = None,
        task_id: Optional[str] = None,
        mcp_manager=None,
        project_id: Optional[str] = None,
        permission_mode: Optional[str] = None,
    ):
        """
        Initialize agent instance.

        Args:
            session_id: Existing session ID to resume; None to create a new session.
            max_turns: Maximum loop turns per run.
            workspace_root: Base workspace path.
            task_id: Optional task ID for task-scoped runs.
            mcp_manager: Optional shared MCP manager instance.
            project_id: Optional project ID bound to the session.
            permission_mode: Optional permission mode override (for example "auto").
        """
        # ========== ?==========
        self.db = Database()

        # ========== Project  ==========
        # 
        self._project = None
        self._custom_instructions: str = ""
        if project_id:
            self._project = self.db.get_project(project_id)
            if self._project:
                self._custom_instructions = self._project.get("custom_instructions") or ""

        # ==========  ==========
        if workspace_root is None:
            self.workspace_root = get_runtime_root()
        else:
            self.workspace_root = Path(workspace_root).resolve()

        self.task_id = task_id

        # ========== ?==========
        from datetime import datetime
        self.session_start_time = datetime.now()

        if session_id:
            session = self.db.get_session(session_id)
            if session:
                self.session_id = session_id
                self._is_new_session = False
                # ?session ?project?session  project
                if not self._project and session.get("project_id"):
                    self._project = self.db.get_project(session["project_id"])
                    if self._project:
                        self._custom_instructions = self._project.get("custom_instructions") or ""
            else:
                self.session_id = session_id
                self._is_new_session = True
                self.db.create_session(self.session_id, project_id=project_id)
        else:
            self.session_id = self._generate_session_id()
            self._is_new_session = True
            self.db.create_session(self.session_id, project_id=project_id)

        # ==========  ==========
        # ?input/output/temp?
        # ?input/output/temp?
        if self._project and self._project.get("workspace_path"):
            # ?
            _proj_ws = Path(self._project["workspace_path"])
            self.input_dir = (_proj_ws / "input").resolve()
            self.output_dir = (_proj_ws / "output").resolve()
            self.temp_dir = (_proj_ws / "temp").resolve()
        else:
            # ?
            session_ws = self.workspace_root / "sessions" / self.session_id
            self.input_dir = (session_ws / "input").resolve()
            self.output_dir = (session_ws / "output").resolve()
            self.temp_dir = (session_ws / "temp").resolve()

        self.logs_dir = (self.workspace_root / "workspace" / "logs").resolve()

        for d in [self.input_dir, self.output_dir, self.temp_dir, self.logs_dir]:
            d.mkdir(parents=True, exist_ok=True)

        # ========== ?==========
        self.llm = LLMClient()
        self.tool_loader = ToolLoader(mcp_manager=mcp_manager)
        if permission_mode and self.tool_loader.permission_manager:
            self.tool_loader.permission_manager.mode = permission_mode
        self.max_turns = max_turns

        # ==========  ==========
        #  DB 
        if not self._is_new_session:
            self.history: List[Dict[str, Any]] = self.db.get_messages(self.session_id)
            print(f"Restored session {self.session_id} with {len(self.history)} messages")
        else:
            self.history: List[Dict[str, Any]] = []

        #  ESC ?
        self._interrupted = threading.Event()
        # Serialize execution per session to avoid overlapping runs on one Agent.
        self._execution_lock = threading.Lock()

        # Title generation state (two-phase: seed fast, then refine async).
        # Eligibility is computed from history + current title, not only from
        # whether session row already exists.
        self._title_seeded = True
        self._title_refine_queued = True
        self._seeded_title: Optional[str] = None

        session_meta = self.db.get_session(self.session_id) or {}
        current_title = self._sanitize_title_text(session_meta.get("title") or "", max_len=50)
        has_history = len(self.history) > 0
        auto_title_eligible = (not has_history) and self._is_default_title(current_title)

        self._title_seeded = not auto_title_eligible
        self._title_refine_queued = not auto_title_eligible
        if not auto_title_eligible and current_title:
            self._seeded_title = current_title

        # etry_with_context ?
        self._pending_extra_instruction: str = ""

        # ==========  ==========
        print("Initializing Agent...")
        self.tools = self.tool_loader.load_all()

        #  temp_dir 
        fetch = self.tool_loader.tool_instances.get("fetch")
        if fetch:
            fetch.temp_dir = self.temp_dir

        # 
        print("\nWorkspace configuration:")
        print(f"   - Workspace root: {self.workspace_root}")
        print(f"   - Input directory: {self.input_dir}")
        print(f"   - Output directory: {self.output_dir}")
        print(f"   - Temp directory: {self.temp_dir}")
        print(f"   - Session ID: {self.session_id}")
        if self.task_id:
            print(f"   - Task ID: {self.task_id}")

        # ==========  ==========
        self.system_prompt = self._build_system_prompt()

        # ==========  ==========
        self.context_manager = ContextManager(
            llm=self.llm,
            tools=self.tools,
            system_prompt=self.system_prompt,
            max_context_tokens=MAX_CONTEXT_TOKENS,
            keep_recent_turns=KEEP_RECENT_TURNS
        )

    def _generate_session_id(self) -> str:
        """Generate a short random session ID."""
        import uuid
        return uuid.uuid4().hex[:16]

    def _build_system_prompt(self) -> str:
        from datetime import datetime

        now = datetime.now().astimezone()
        current_datetime = now.strftime("%Y-%m-%d %H:%M:%S %Z")
        current_date = now.strftime("%Y-%m-%d")
        task_info = f"Current task ID: {self.task_id}" if self.task_id else "Single-task mode"

        project_block = ""
        if self._project:
            project_name = self._project.get("name", "")
            project_block = f"\n<project>\n  Current project: {project_name}\n"
            if self._custom_instructions:
                project_block += f"\n  Project custom instructions:\n{self._custom_instructions}\n"
            project_block += "</project>\n"

        return f"""You are an assistant that can use tools to finish tasks.

<time_info>
  Current local datetime: {current_datetime}
  Current local date: {current_date}
</time_info>
{project_block}

<workspace_info>
  {task_info}
  Workspace root: {self.workspace_root}
  Input directory: {self.input_dir}
  Output directory: {self.output_dir}
  Temp directory: {self.temp_dir}
</workspace_info>

<path_rules>
1. Read input files from {self.input_dir} unless user says otherwise.
2. Write final output files to {self.output_dir} unless user says otherwise.
3. Use {self.temp_dir} for temporary/intermediate files.
4. Always prefer absolute paths for file operations.
</path_rules>

<skill_installation>
Active skill directory (auto-loaded at agent startup): {self.tool_loader.skills_dir}
Bundled resources root (readable): {self.tool_loader.resources_dir}

When the user asks to add/install a skill:
- Source can be a GitHub URL or an uploaded folder/file.
- First stage all files in Temp directory: {self.temp_dir}.
- Then install by copying skill folder(s) into: {self.tool_loader.skills_dir}.
- Session/project working files still belong under workspace root: {self.workspace_root}.
- You may read files anywhere under bundled resources: {self.tool_loader.resources_dir}.
- You may write or delete bundled files only under:
  - {self.tool_loader.skills_dir}
  - {self.tool_loader.playwright_browsers_dir}
  - {self.tool_loader.node_dir} (sensitive; require user confirmation for each write/delete command)
  - {self.tool_loader.python_dir} (sensitive; require user confirmation for each write/delete command)
- Playwright browsers download directory: {self.tool_loader.playwright_browsers_dir} (stores downloaded/cached Playwright browser binaries).
- Bundled Node runtime directory: {self.tool_loader.node_dir} (contains Node runtime and node_modules for skill JS dependencies).
- Bundled Python runtime directory: {self.tool_loader.python_dir} (contains packaged Python runtime and libraries).
- For any skill attachment or sibling file mentioned by a skill, resolve the path relative to that skill's manifest directory.

Validation checklist for each installed skill:
1) Contains SKILL.md at folder root.
2) SKILL.md starts with YAML frontmatter (--- ... ---).
3) Frontmatter includes: name, description.

If installation/activation fails, explain likely causes explicitly:
- Installed to wrong path
- Missing SKILL.md
- Invalid/missing frontmatter fields
- Encoding/parse issues
- Duplicate or conflicting skill name

After install/update, tell the user to start a new chat to load newly added skills.
</skill_installation>

<large_file_strategy>
For large files (>5000 characters or >15KB):
1. Use write for the first chunk.
2. Use append for subsequent chunks.
3. Keep each chunk around 2000 characters.
4. Prefer edit for incremental updates to existing large files.
</large_file_strategy>
<hints>
when user asks to gain any information from xiaohongshu/rednote/小红书，or from X/twitter, use playwright mcp.
</hints>
"""

    def _get_agents_md_path(self) -> Path:
        """Return the strict AGENTS.md path under the current input root."""
        return (self.input_dir / "AGENTS.md").resolve()

    def _read_agents_md_content(self) -> str:
        """Read AGENTS.md from the current input root, if present."""
        agents_path = self._get_agents_md_path()
        if not agents_path.exists() or not agents_path.is_file():
            return ""

        try:
            return agents_path.read_text(encoding="utf-8").strip()
        except Exception as exc:
            project_id = self._project.get("id") if self._project else None
            print(
                "[AGENTS.md] warning: failed to read "
                f"{agents_path} for session={self.session_id} "
                f"project={project_id or '-'} input_dir={self.input_dir}: {exc}"
            )
            return ""

    def _build_runtime_system_prompt(self) -> str:
        """Build the system prompt for the current turn, including AGENTS.md."""
        agents_content = self._read_agents_md_content()
        if not agents_content:
            return self.system_prompt

        return f"{self.system_prompt}\n\n<AGENTS>\n{agents_content}\n</AGENTS>"
    # 
    # ============================================

    def _refresh_context_budget_if_needed(self):
        """Refresh context budget and compress history when needed."""
        self.context_manager.refresh_tool_budget(self.tools)
        if self.context_manager.should_compress(self.history):
            self.history = self.context_manager.compress_history(self.history)

    def run(self, user_input: str) -> str:
        """
        Run the agent in single-response mode.

        Args:
            user_input: User message text.

        Returns:
            Final assistant text.
        """
        self._refresh_context_budget_if_needed()

        user_msg = {"role": "user", "content": user_input}
        self.history.append(user_msg)
        self.db.add_message(self.session_id, "user", content=user_input)
        self.db.touch_session(self.session_id, message_count_delta=1)
        self._seed_title_from_user_input(user_input)

        self._interrupted.clear()
        self._start_esc_listener()

        final_response = None
        try:
            for _ in range(self.max_turns):
                if self._interrupted.is_set():
                    break

                self._refresh_context_budget_if_needed()
                messages = self._build_messages()
                turn = self._call_llm_interruptible(messages)

                if turn is None:
                    break

                if turn.tool_calls:
                    self._handle_tool_calls(turn)
                    if self._interrupted.is_set():
                        break
                    continue

                full_content = str(turn.visible_content or "")
                if not full_content.strip():
                    full_content = (
                        "No final response was generated in this run. "
                        "Open intermediate steps to inspect progress."
                    )

                final_turn = NormalizedAssistantTurn(
                    provider=turn.provider,
                    visible_content=full_content,
                    raw_content=turn.raw_content,
                    tool_calls=[],
                    reasoning_blocks=turn.reasoning_blocks,
                    raw_provider_message=turn.raw_provider_message,
                    protocol_flags=turn.protocol_flags,
                )
                self._persist_assistant_turn(final_turn)
                self.db.touch_session(self.session_id, message_count_delta=1)
                final_response = full_content
                break

            if self._interrupted.is_set():
                interrupted_text = "[interrupted] Stopped by user."
                self.history.append({"role": "assistant", "content": interrupted_text})
                self.db.add_message(self.session_id, "assistant", content=interrupted_text)
                self.db.touch_session(self.session_id, message_count_delta=1)
                return interrupted_text

            if final_response is None:
                final_response = "Task is too complex; reached max turns."
                self.history.append({"role": "assistant", "content": final_response})
                self.db.add_message(self.session_id, "assistant", content=final_response)
                self.db.touch_session(self.session_id, message_count_delta=1)
                return final_response

        finally:
            self._interrupted.set()

        self._queue_title_refinement(user_input, final_response)
        return final_response

    def run_events(self, user_input: str, resume: bool = False, user_persisted: bool = False):
        """
        Run the agent with event-style output.

        Even in this event API, each LLM turn is now non-streaming
        (single completion response) to avoid token-chunk stalls.
        """
        self._refresh_context_budget_if_needed()
        self._interrupted.clear()

        if resume:
            while self.history and self.history[-1]["role"] != "user":
                self.history.pop()

            last_db_id = self.db.get_last_message_id(self.session_id)
            if last_db_id is not None:
                db_messages = self.db.get_messages(self.session_id)
                last_user_idx = None
                for i in range(len(db_messages) - 1, -1, -1):
                    if db_messages[i]["role"] == "user":
                        last_user_idx = i
                        break

                if last_user_idx is not None and last_user_idx < len(db_messages) - 1:
                    with self.db._connect() as conn:
                        rows = conn.execute(
                            "SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC",
                            (self.session_id,),
                        ).fetchall()
                    msg_ids = [r["id"] for r in rows]
                    if last_user_idx < len(msg_ids):
                        cutoff_id = msg_ids[last_user_idx]
                        self.db.delete_messages_after(self.session_id, cutoff_id)

            if self._pending_extra_instruction:
                extra = self._pending_extra_instruction
                self._pending_extra_instruction = ""
                extra_msg = {"role": "user", "content": f"[extra instruction] {extra}"}
                self.history.append(extra_msg)
                self.db.add_message(self.session_id, "user", content=extra_msg["content"])

        else:
            user_msg = {"role": "user", "content": user_input}
            if user_persisted:
                tail = self.history[-1] if self.history else None
                if not (
                    isinstance(tail, dict)
                    and tail.get("role") == "user"
                    and str(tail.get("content") or "") == user_input
                ):
                    self.history.append(user_msg)
            else:
                self.history.append(user_msg)
                self.db.add_message(self.session_id, "user", content=user_input)
                self.db.touch_session(self.session_id, message_count_delta=1)
            self._seed_title_from_user_input(user_input)

        final_response_parts = []
        empty_non_tool_rounds = 0

        try:
            for _ in range(self.max_turns):
                if self._interrupted.is_set():
                    break

                self._refresh_context_budget_if_needed()
                messages = self._build_messages()
                turn = self._call_llm_interruptible(messages)

                if turn is None:
                    break

                full_content = str(turn.visible_content or "")
                if full_content:
                    yield {"type": "content", "data": full_content}

                tool_calls_buffer = []
                seen_tool_call_ids = set()
                for i, tc in enumerate(turn.tool_calls or []):
                    name = str(tc.name or "")
                    if not name:
                        continue
                    arguments = str(tc.arguments_json or "{}") if str(tc.arguments_json or "").strip() else "{}"
                    tc_id = str(tc.id or f"tool_call_{i}")
                    if tc_id in seen_tool_call_ids:
                        continue
                    seen_tool_call_ids.add(tc_id)
                    tool_calls_buffer.append(
                        {
                            "id": tc_id,
                            "name": name,
                            "arguments": arguments,
                        }
                    )

                if self._interrupted.is_set():
                    break

                if tool_calls_buffer:
                    self._persist_assistant_turn(turn)

                    for tc in tool_calls_buffer:
                        if self._interrupted.is_set():
                            break

                        yield {
                            "type": "tool_start",
                            "data": {
                                "id": tc["id"],
                                "name": tc["name"],
                                "arguments": tc["arguments"],
                            },
                        }

                        interrupted_tool = False
                        try:
                            tool_args = self._parse_tool_arguments(tc["arguments"])
                            result = self._execute_tool_interruptible(tc["name"], tool_args)
                            if isinstance(result, dict) and result.get("_interrupted_tool"):
                                interrupted_tool = True
                                result_str = "[interrupted] tool execution canceled by user"
                            elif isinstance(result, dict):
                                result_str = self._format_tool_result(result)
                            else:
                                result_str = self._format_tool_result(result)
                        except PermissionRequestError as perm_err:
                            yield {
                                "type": "permission_request",
                                "data": {
                                    "tool": perm_err.tool,
                                    "args": perm_err.tool_args,
                                    "tool_call_id": tc["id"],
                                },
                            }
                            return
                        except Exception as e:
                            result_str = f"[tool execution failed] {str(e)}"

                        result_str = self._format_tool_result(result_str)

                        tool_msg = {
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": result_str,
                        }
                        self.history.append(tool_msg)
                        self.db.add_message(
                            self.session_id,
                            "tool",
                            content=result_str,
                            tool_call_id=tc["id"],
                        )

                        yield {
                            "type": "tool_result",
                            "data": {
                                "id": tc["id"],
                                "result": result_str,
                            },
                        }

                        if interrupted_tool or self._interrupted.is_set():
                            break

                    continue

                if not full_content.strip():
                    empty_non_tool_rounds += 1
                    if empty_non_tool_rounds <= 2:
                        continue

                    fallback = (
                        "No final response was generated in this run. "
                        "Open intermediate steps to inspect progress."
                    )
                    assistant_msg = {"role": "assistant", "content": fallback}
                    self.history.append(assistant_msg)
                    self.db.add_message(self.session_id, "assistant", content=fallback)
                    self.db.touch_session(self.session_id, message_count_delta=1)
                    final_response_parts.append(fallback)
                    break

                empty_non_tool_rounds = 0
                final_turn = NormalizedAssistantTurn(
                    provider=turn.provider,
                    visible_content=full_content,
                    raw_content=turn.raw_content,
                    tool_calls=[],
                    reasoning_blocks=turn.reasoning_blocks,
                    raw_provider_message=turn.raw_provider_message,
                    protocol_flags=turn.protocol_flags,
                )
                self._persist_assistant_turn(final_turn)
                self.db.touch_session(self.session_id, message_count_delta=1)
                final_response_parts.append(full_content)
                break

            if self._interrupted.is_set():
                interrupted_text = "[interrupted] Stopped by user."
                self.history.append({"role": "assistant", "content": interrupted_text})
                self.db.add_message(self.session_id, "assistant", content=interrupted_text)
                self.db.touch_session(self.session_id, message_count_delta=1)
                yield {"type": "done", "data": interrupted_text}
                return

            final_text = "".join([p for p in final_response_parts if p])
            if not final_text:
                final_text = (
                    "No final response was generated in this run. "
                    "Open intermediate steps to inspect progress."
                )
                self.history.append({"role": "assistant", "content": final_text})
                self.db.add_message(self.session_id, "assistant", content=final_text)
                self.db.touch_session(self.session_id, message_count_delta=1)

            yield {"type": "done", "data": final_text}

        except PermissionRequestError as perm_err:
            yield {
                "type": "permission_request",
                "data": {
                    "tool": perm_err.tool,
                    "args": perm_err.tool_args,
                    "tool_call_id": None,
                },
            }

        except Exception as e:
            err_text = f"[Error] {str(e)}"
            try:
                self.history.append({"role": "assistant", "content": err_text})
                self.db.add_message(self.session_id, "assistant", content=err_text)
                self.db.touch_session(self.session_id, message_count_delta=1)
            except Exception:
                pass
            yield {"type": "error", "data": str(e)}

        if final_response_parts:
            self._queue_title_refinement(user_input, "".join(final_response_parts))

    def run_locked(self, user_input: str) -> str:
        """Run single-shot chat with per-session execution lock."""
        self._execution_lock.acquire()
        try:
            return self.run(user_input)
        finally:
            self._execution_lock.release()

    def run_events_locked(self, user_input: str, resume: bool = False, user_persisted: bool = False):
        """Run event-style chat with per-session execution lock."""
        self._execution_lock.acquire()
        try:
            yield from self.run_events(user_input, resume=resume, user_persisted=user_persisted)
        finally:
            self._execution_lock.release()

    def interrupt(self):
        """Interrupt current run/event execution for this agent session."""
        self._interrupted.set()

    @staticmethod
    def _sanitize_title_text(text: str, max_len: int = 50) -> str:
        cleaned = (text or "").strip().strip('"').strip("'")
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if len(cleaned) > max_len:
            cleaned = cleaned[:max_len].rstrip()
        return cleaned

    @staticmethod
    def _strip_hidden_thinking(text: str) -> str:
        cleaned = (text or "").strip()
        if not cleaned:
            return ""
        return re.sub(r"(?is)<think>.*?</think>", "", cleaned).strip()

    @staticmethod
    def _is_default_title(title: str) -> bool:
        normalized = (title or "").strip().lower()
        return normalized in {"", "new chat", "new session", "untitled"}

    def _build_seed_title(self, user_input: str) -> str:
        text = (user_input or "").replace("\r", "\n")
        first_non_empty = ""
        for line in text.split("\n"):
            line = line.strip()
            if line:
                first_non_empty = line
                break
        if not first_non_empty:
            return ""
        first_non_empty = self._sanitize_title_text(first_non_empty, max_len=50)
        if len(first_non_empty) > 47:
            return f"{first_non_empty[:47].rstrip()}..."
        return first_non_empty

    def _seed_title_from_user_input(self, user_input: str):
        if self._title_seeded:
            return
        self._title_seeded = True
        try:
            seed_title = self._build_seed_title(user_input)
            if not seed_title:
                return
            session = self.db.get_session(self.session_id)
            current = self._sanitize_title_text((session or {}).get("title", ""))
            if current and not self._is_default_title(current):
                return
            self.db.update_session_title(self.session_id, seed_title)
            self._seeded_title = seed_title
        except Exception:
            # Never block the main chat flow because of title updates.
            pass

    def _queue_title_refinement(self, user_input: str, assistant_response: str):
        if self._title_refine_queued:
            return
        self._title_refine_queued = True
        self._generate_title_async(
            user_input=user_input,
            assistant_response=assistant_response,
            seeded_title=self._seeded_title,
        )

    def _generate_title_async(
        self,
        user_input: str,
        assistant_response: str,
        seeded_title: Optional[str] = None,
    ):
        """Generate a title asynchronously in a background thread."""
        def _do():
            try:
                clean_assistant = self._strip_hidden_thinking(assistant_response)
                if not clean_assistant:
                    return
                prompt = (
                    "Generate a concise chat title (<=20 chars, no quotes) based on first turn:\n\n"
                    f"User: {user_input[:200]}\n"
                    f"Assistant: {clean_assistant[:200]}"
                )
                title = self.llm.generate(prompt, max_tokens=50)
                title = self._strip_hidden_thinking(title)
                title = self._sanitize_title_text(title, max_len=50)
                if not title:
                    return

                session = self.db.get_session(self.session_id)
                if not session:
                    return
                current = self._sanitize_title_text(session.get("title") or "", max_len=50)
                if current and not self._is_default_title(current):
                    # Preserve user-edited title.
                    if seeded_title and current != seeded_title:
                        return
                    if not seeded_title:
                        return
                self.db.update_session_title(self.session_id, title)
            except Exception:
                pass

        t = threading.Thread(target=_do, daemon=True)
        t.start()

    def _get_active_provider(self) -> str:
        return self.llm.get_runtime_config().get("provider", "openai")

    def _get_active_provider_adapter(self):
        return get_provider_adapter(self._get_active_provider())

    @staticmethod
    def _tool_calls_to_data(tool_calls: List[NormalizedToolCall]) -> List[Dict[str, Any]]:
        return [
            {
                "id": tool_call.id,
                "type": "function",
                "function": {
                    "name": tool_call.name,
                    "arguments": tool_call.arguments_json,
                },
            }
            for tool_call in tool_calls
        ]

    @staticmethod
    def _reasoning_blocks_to_data(turn: NormalizedAssistantTurn) -> List[Dict[str, Any]]:
        return [
            {
                "type": block.type,
                "content": block.content,
                "raw": block.raw,
            }
            for block in turn.reasoning_blocks
        ]

    def _build_history_assistant_message(self, turn: NormalizedAssistantTurn) -> Dict[str, Any]:
        message: Dict[str, Any] = {
            "role": "assistant",
            "content": turn.visible_content,
            "provider": turn.provider,
            "raw_payload_json": turn.raw_provider_message,
            "reasoning_blocks": self._reasoning_blocks_to_data(turn),
            "protocol_flags": list(turn.protocol_flags),
            "message_format_version": 2,
        }
        if turn.tool_calls:
            message["tool_calls"] = self._tool_calls_to_data(turn.tool_calls)
        return message

    def _persist_assistant_turn(self, turn: NormalizedAssistantTurn) -> Dict[str, Any]:
        assistant_msg = self._build_history_assistant_message(turn)
        self.history.append(assistant_msg)
        self.db.add_message(
            self.session_id,
            "assistant",
            content=turn.visible_content,
            tool_calls=assistant_msg.get("tool_calls"),
            provider=turn.provider,
            raw_payload=turn.raw_provider_message,
            reasoning_blocks=assistant_msg.get("reasoning_blocks"),
            protocol_flags=assistant_msg.get("protocol_flags"),
            message_format_version=2,
        )
        return assistant_msg

    @staticmethod
    def _parse_tool_arguments(raw_arguments: str) -> Dict[str, Any]:
        try:
            return json.loads(raw_arguments)
        except json.JSONDecodeError:
            try:
                return json.loads((raw_arguments or "").replace("'", '"'))
            except Exception:
                return {}

    @staticmethod
    def _format_tool_result(result: Any) -> str:
        if isinstance(result, dict):
            result_str = json.dumps(result, ensure_ascii=False)
        else:
            result_str = str(result)

        result_str = re.sub(r'\x1b\[[0-9;]*m', '', result_str)
        if len(result_str) > MAX_TOOL_RESULT_CHARS:
            result_str = result_str[:MAX_TOOL_RESULT_CHARS] + f"\n\n... (truncated, original {len(result_str)} chars)"
        return result_str

    def _call_llm(self, messages: List[Dict]) -> NormalizedAssistantTurn:
        runtime_config = self.llm.get_runtime_config()
        provider = runtime_config.get("provider", "openai")
        adapter = get_provider_adapter(provider)
        response = self.llm.generate_with_tools(
            messages=adapter.build_request_messages(messages),
            tools=self.tools
        )

        message = response.choices[0].message
        normalized = normalize_assistant_message(provider, message)

        if normalized.tool_calls:
            import os
            debug_mode = os.environ.get('DEBUG_AGENT', '0') == '1'
            if debug_mode:
                debug_file = self.workspace_root / "workspace" / "temp" / "last_llm_response.json"
                debug_file.parent.mkdir(parents=True, exist_ok=True)
                debug_data = {
                    "provider": provider,
                    "content": normalized.visible_content,
                    "tool_calls": self._tool_calls_to_data(normalized.tool_calls),
                    "reasoning_blocks": self._reasoning_blocks_to_data(normalized),
                    "protocol_flags": normalized.protocol_flags,
                    "raw_provider_message": normalized.raw_provider_message,
                }
                debug_file.write_text(
                    json.dumps(debug_data, ensure_ascii=False, indent=2),
                    encoding='utf-8'
                )

        return normalized

    # ============================================
    # 
    # ============================================

    def _start_esc_listener(self):
        """Start a background listener; double ESC interrupts current run."""
        if not HAS_MSVCRT:
            return None

        self._interrupted.clear()
        last_esc = [0.0]

        def listener():
            while not self._interrupted.is_set():
                if msvcrt.kbhit():
                    key = msvcrt.getch()
                    if key == b'\x1b':  # ESC
                        now = time.time()
                        if now - last_esc[0] < 1.0:
                            self._interrupted.set()
                            print("\n\nDetected double ESC, interrupting...")
                            return
                        last_esc[0] = now
                time.sleep(0.05)

        t = threading.Thread(target=listener, daemon=True)
        t.start()
        return t

    def _call_llm_interruptible(self, messages):
        """Call LLM in a worker thread and return None if interrupted."""
        result: list = [None]
        error: list = [None]

        def call():
            try:
                result[0] = self._call_llm(messages)
            except Exception as e:
                error[0] = e

        t = threading.Thread(target=call)
        t.start()

        while t.is_alive():
            t.join(timeout=0.1)
            if self._interrupted.is_set():
                return None

        if error[0]:
            raise error[0]
        return result[0]

    def _execute_tool_interruptible(self, tool_name: str, tool_args: Dict[str, Any]) -> Any:
        """Execute a tool in a worker thread and return early when interrupted."""
        result: list = [None]
        error: list = [None]

        def call():
            try:
                result[0] = self.tool_loader.execute_tool(tool_name, tool_args)
            except Exception as e:
                error[0] = e

        t = threading.Thread(target=call, daemon=True)
        t.start()

        while t.is_alive():
            t.join(timeout=0.1)
            if self._interrupted.is_set():
                return {"_interrupted_tool": True}

        if error[0]:
            raise error[0]
        return result[0]

    def _handle_tool_calls(self, turn: NormalizedAssistantTurn) -> None:
        """Handle tool calls and persist their results."""
        self._persist_assistant_turn(turn)

        for tool_call in turn.tool_calls:
            if self._interrupted.is_set():
                interrupted_msg = {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": "[interrupted] tool call skipped"
                }
                self.history.append(interrupted_msg)
                self.db.add_message(
                    self.session_id, "tool",
                    content="[interrupted] tool call skipped",
                    tool_call_id=tool_call.id
                )
                continue

            try:
                result = self._execute_single_tool(tool_call.name, tool_call.arguments_json)
            except Exception as e:
                # Never leave assistant.tool_calls without a matching tool result.
                # Otherwise the next round can fail with protocol errors.
                result = {"error": f"Tool execution failed: {str(e)}"}

            # ?
            if isinstance(result, dict) and "retry_with_context" in result:
                extra_instruction = result["retry_with_context"]
                print(f"User added retry instruction: {extra_instruction}")
                print("Retrying with additional user context...\n")

                retry_tool_msg = {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": "[retry_with_context] user provided extra instruction; retrying."
                }
                self.history.append(retry_tool_msg)
                self.db.add_message(
                    self.session_id,
                    "tool",
                    content=retry_tool_msg["content"],
                    tool_call_id=tool_call.id
                )

                extra_msg = {
                    "role": "user",
                    "content": f"[extra instruction] {extra_instruction}"
                }
                self.history.append(extra_msg)
                self.db.add_message(
                    self.session_id, "user",
                    content=f"[extra instruction] {extra_instruction}"
                )
                break

            # 
            result_str = self._format_tool_result(result)

            print(f"   Result: {result_str[:100]}...")

            tool_msg = {
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result_str
            }
            self.history.append(tool_msg)
            self.db.add_message(
                self.session_id, "tool",
                content=result_str,
                tool_call_id=tool_call.id
            )

    def _execute_single_tool(self, tool_name: str, raw_arguments: str) -> Any:

        print(f"\nCalling tool: {tool_name}")
        print(f"   Raw args: {raw_arguments[:200] if len(raw_arguments) > 200 else raw_arguments}")

        arguments = self._parse_tool_arguments(raw_arguments)
        if arguments:
            print("   JSON parsed successfully")
        else:
            print("   Unable to parse tool arguments, using empty args")

        # PermissionRequestError handling
        try:
            return self.tool_loader.execute_tool(tool_name, arguments)
        except PermissionRequestError as perm_err:
            pm = perm_err.permission_manager

            # In desktop/non-interactive mode, never block on stdin input.
            stdin_is_tty = bool(getattr(sys.stdin, "isatty", lambda: False)())
            if not stdin_is_tty:
                decision = pm.get_last_decision() if hasattr(pm, "get_last_decision") else {}
                reason = decision.get("reason") or "Permission confirmation required but interactive approval is unavailable"
                blocked_command = decision.get("blocked_command")
                blocked_path = decision.get("blocked_path")
                detail = decision.get("detail")

                if blocked_command:
                    reason = f"{reason}. blocked_command={blocked_command}"
                if blocked_path:
                    reason = f"{reason}. blocked_path={blocked_path}"
                if detail:
                    reason = f"{reason}. detail={detail}"

                return {
                    "error": "Permission denied",
                    "tool": tool_name,
                    "reason": reason,
                }

            result = pm.ask_user(perm_err.tool, perm_err.tool_args)

            if isinstance(result, dict) and "retry_with_context" in result:
                return {
                    "retry_with_context": result["retry_with_context"],
                    "tool": tool_name,
                    "args": arguments,
                }
            if result:
                return self.tool_loader.execute_tool(tool_name, arguments)
            return {"error": "Permission denied by user"}

    def _build_messages(self) -> List[Dict[str, Any]]:
        messages = [{"role": "system", "content": self._build_runtime_system_prompt()}]
        messages.extend(self._sanitize_history_for_llm(self.history))
        return messages

    def _sanitize_history_for_llm(self, history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Build a model-safe history sequence.

        Some interrupted/failed turns may leave dangling assistant tool_calls
        without matching tool results. That breaks OpenAI-compatible APIs with:
        "tool call result does not follow tool call".

        Strategy:
        - Drop orphan tool messages that are not tied to a pending tool call.
        - If a pending assistant tool_call is not fully matched before the next
          non-tool message, strip `tool_calls` from that assistant message.
        """
        sanitized: List[Dict[str, Any]] = []
        active_provider = self._get_active_provider()
        active_adapter = get_provider_adapter(active_provider)

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

        for msg in history:
            role = msg.get("role")
            protocol_flags = list(msg.get("protocol_flags") or [])
            if role == "assistant" and not msg.get("tool_calls") and not protocol_flags:
                protocol_flags = detect_protocol_flags(str(msg.get("content") or ""), False)

            if "fake_textual_tool_call" in protocol_flags and not msg.get("tool_calls"):
                continue

            if pending_ids:
                if role == "tool":
                    tcid = msg.get("tool_call_id")
                    if tcid and tcid in pending_ids:
                        sanitized.append(active_adapter.rebuild_message_for_next_round(msg, active_provider))
                        seen_ids.add(tcid)
                        if all(tc_id in seen_ids for tc_id in pending_ids):
                            finalize_pending()
                        continue
                    # Orphan/unknown tool message while waiting for specific IDs.
                    # Drop it to keep model sequence valid.
                    continue
                # Any non-tool message closes the pending tool-call window.
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
                rebuilt = active_adapter.rebuild_message_for_next_round(msg, active_provider)
                sanitized.append(rebuilt)
                if tc_ids:
                    pending_ids = tc_ids
                    seen_ids = set()
                    pending_assistant_idx = len(sanitized) - 1
                else:
                    # Malformed tool call payload; strip it immediately.
                    fixed = dict(rebuilt)
                    fixed.pop("tool_calls", None)
                    sanitized[-1] = fixed
                continue

            if role == "tool":
                # Orphan tool message (no pending assistant tool_call).
                # Skip it for model input.
                continue

            sanitized.append(active_adapter.rebuild_message_for_next_round(msg, active_provider))

        if pending_ids:
            finalize_pending()

        return sanitized

    # ============================================
    # 
    # ============================================

    def get_context_json(self) -> str:
        context = {
            "session_id": self.session_id,
            "system_prompt": self.system_prompt,
            "available_tools": len(self.tools),
            "history": self.history
        }
        return json.dumps(context, ensure_ascii=False, indent=2)

    def save_context(self, filepath: str):
        Path(filepath).write_text(self.get_context_json(), encoding='utf-8')
        print(f"Context saved: {filepath}")

    def reset(self):
        """Reset chat history and start a new session."""
        self.history = []
        self.session_id = self._generate_session_id()
        self._title_seeded = False
        self._title_refine_queued = False
        self._seeded_title = None
        self.db.create_session(self.session_id)
        print(f"Chat reset. New session ID: {self.session_id}")


# ============================================
# CLI 
# ============================================

if __name__ == "__main__":
    print("=" * 70)
    print("Agent interactive mode")
    print("=" * 70)

    agent = Agent()
    print("Commands: quit/exit, reset, context, save, /admin")

    while True:
        try:
            user_input = input("You: ").strip()
            if not user_input:
                continue

            if user_input.lower() in ["quit", "exit", "q"]:
                print("Bye")
                break

            if user_input.lower() == "reset":
                agent.reset()
                continue

            if user_input.lower() == "context":
                print(agent.get_context_json())
                continue

            if user_input.lower() == "save":
                save_path = agent.workspace_root / "workspace" / "temp" / "agent_context.json"
                save_path.parent.mkdir(parents=True, exist_ok=True)
                agent.save_context(str(save_path))
                continue

            if user_input.lower() == "/admin":
                pm = agent.tool_loader.permission_manager
                if pm is None:
                    print("Permission manager not enabled")
                    continue
                print(f"Current mode: {pm.mode}")
                mode = input("Choose mode (ask/auto): ").strip().lower()
                if mode in ("ask", "auto"):
                    pm.set_mode(cast(Literal["ask", "auto"], mode))
                else:
                    print("Invalid mode")
                continue

            response = agent.run(user_input)
            print(f"Agent: {response}")

        except KeyboardInterrupt:
            print("\nInterrupted, exiting...")
            mcp_mgr = agent.tool_loader.tool_executors.get("_mcp_manager")
            if mcp_mgr:
                try:
                    mcp_mgr.close_all()
                except Exception:
                    pass
            break
        except Exception as e:
            print(f"Error: {e}")




