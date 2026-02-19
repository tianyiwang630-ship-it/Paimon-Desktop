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

When the user asks to add/install a skill:
- Source can be a GitHub URL or an uploaded folder/file.
- First stage all files in Temp directory: {self.temp_dir}.
- Then install by copying skill folder(s) into: {self.tool_loader.skills_dir}.

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
"""
    # 
    # ============================================

    def _refresh_context_budget_if_needed(self):
        """Refresh context budget and compress history when needed."""
        self.context_manager.refresh_tool_budget(self.tools)
        if self.context_manager.should_compress(self.history):
            self.history = self.context_manager.compress_history(self.history)

    def run(self, user_input: str) -> str:
        """
         Agent

        Args:
            user_input: 

        Returns:
            Agent 
        """
        # 
        self._refresh_context_budget_if_needed()

        # ?
        user_msg = {"role": "user", "content": user_input}
        self.history.append(user_msg)
        self.db.add_message(self.session_id, "user", content=user_input)
        self.db.touch_session(self.session_id, message_count_delta=1)
        self._seed_title_from_user_input(user_input)

        #  ESC ?
        self._interrupted.clear()
        esc_thread = self._start_esc_listener()

        final_response = None
        try:
            for turn in range(self.max_turns):
                if self._interrupted.is_set():
                    break

                # tool_search 
                self._refresh_context_budget_if_needed()

                messages = self._build_messages()
                message = self._call_llm_interruptible(messages)

                if message is None:  # ?
                    break

                if message.tool_calls:
                    self._handle_tool_calls(message)
                    if self._interrupted.is_set():
                        break
                    continue
                else:
                    # ?
                    assistant_msg = {"role": "assistant", "content": message.content}
                    self.history.append(assistant_msg)
                    self.db.add_message(self.session_id, "assistant", content=message.content)
                    self.db.touch_session(self.session_id, message_count_delta=1)
                    final_response = message.content
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
            self._interrupted.set()  #  ESC 

        # Refine title asynchronously after first completed response.
        self._queue_title_refinement(user_input, final_response)

        return final_response

    def run_stream(self, user_input: str, resume: bool = False):
        """
         Agent

        Args:
            user_input: 
            resume: 

        Yields:
            dict: {
                "type": "reasoning" | "content" | "tool_start" | "tool_result" | "done" | "error",
                "data": ...
            }
        """
        # 
        self._refresh_context_budget_if_needed()
        self._interrupted.clear()

        if resume:
            # ?user ?assistant/tool ?
            while self.history and self.history[-1]["role"] != "user":
                self.history.pop()
            #  DB 
            last_db_id = self.db.get_last_message_id(self.session_id)
            if last_db_id is not None:
                #  history 
                db_messages = self.db.get_messages(self.session_id)
                # ?user ?DB 
                last_user_idx = None
                for i in range(len(db_messages) - 1, -1, -1):
                    if db_messages[i]["role"] == "user":
                        last_user_idx = i
                        break
                if last_user_idx is not None and last_user_idx < len(db_messages) - 1:
                    # ?? history 
                    #  DB id
                    with self.db._connect() as conn:
                        rows = conn.execute(
                            "SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC",
                            (self.session_id,)
                        ).fetchall()
                    msg_ids = [r["id"] for r in rows]
                    if last_user_idx < len(msg_ids):
                        cutoff_id = msg_ids[last_user_idx]
                        self.db.delete_messages_after(self.session_id, cutoff_id)

            #  retry_with_context ?
            if self._pending_extra_instruction:
                extra = self._pending_extra_instruction
                self._pending_extra_instruction = ""
                extra_msg = {"role": "user", "content": f"[extra instruction] {extra}"}
                self.history.append(extra_msg)
                self.db.add_message(self.session_id, "user", content=f"[extra instruction] {extra}")
        else:
            # 
            user_msg = {"role": "user", "content": user_input}
            self.history.append(user_msg)
            self.db.add_message(self.session_id, "user", content=user_input)
            self.db.touch_session(self.session_id, message_count_delta=1)
            self._seed_title_from_user_input(user_input)

        # 
        final_response_parts = []
        try:
            for turn in range(self.max_turns):
                if self._interrupted.is_set():
                    break
                # tool_search 
                self._refresh_context_budget_if_needed()
                messages = self._build_messages()

                #  LLM
                stream = self.llm.generate_with_tools(
                    messages=messages,
                    tools=self.tools,
                    stream=True
                )

                # 
                content_buffer = []
                reasoning_buffer = []
                tool_calls_buffer = []  # [{id, name, arguments}, ...]
                tool_calls_map = {}     # key -> aggregated tool call
                tool_call_order = []    # keep stable tool-call order

                for chunk in stream:
                    if self._interrupted.is_set():
                        break
                    chunk_type = chunk["type"]
                    chunk_data = chunk["data"]

                    # 1. 
                    if chunk_type == "reasoning":
                        reasoning_buffer.append(chunk_data)
                        yield {"type": "reasoning", "data": chunk_data}

                    # 2. 
                    elif chunk_type == "content":
                        content_buffer.append(chunk_data)
                        yield {"type": "content", "data": chunk_data}

                    # 3. Tool calls (aggregate streaming fragments into complete calls)
                    elif chunk_type == "tool_call":
                        # Same call can arrive in multiple chunks. Aggregate by index/id.
                        idx = chunk_data.get("index")
                        tc_id = chunk_data.get("id")
                        if idx is not None:
                            key = f"idx:{idx}"
                        elif tc_id:
                            key = f"id:{tc_id}"
                        else:
                            key = "idx:0"

                        if key not in tool_calls_map:
                            tool_calls_map[key] = {"id": "", "name": "", "arguments": ""}
                            tool_call_order.append(key)

                        agg = tool_calls_map[key]
                        if tc_id:
                            agg["id"] = tc_id
                        if chunk_data.get("name"):
                            agg["name"] += chunk_data["name"]
                        if chunk_data.get("arguments"):
                            agg["arguments"] += chunk_data["arguments"]

                    # 4. 
                    elif chunk_type == "done":
                        break

                # finalize aggregated tool calls (and guard against empty fragments)
                for i, key in enumerate(tool_call_order):
                    tc = tool_calls_map.get(key, {})
                    if not tc.get("name"):
                        continue
                    if not tc.get("id"):
                        tc["id"] = f"tool_call_{i}"
                    tool_calls_buffer.append(tc)

                # Safety net: some providers may duplicate chunks/calls.
                # Ensure each tool call id executes at most once per turn.
                deduped_tool_calls = []
                seen_tool_call_ids = set()
                for tc in tool_calls_buffer:
                    tc_id = tc.get("id")
                    if tc_id in seen_tool_call_ids:
                        continue
                    seen_tool_call_ids.add(tc_id)
                    deduped_tool_calls.append(tc)
                tool_calls_buffer = deduped_tool_calls

                if self._interrupted.is_set():
                    break

                # 
                full_content = "".join(content_buffer)

                # ??
                if tool_calls_buffer:
                    # ?assistant ?
                    tool_calls_data = [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": tc["arguments"]
                            }
                        }
                        for tc in tool_calls_buffer
                    ]
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_content,
                        "tool_calls": tool_calls_data
                    }
                    self.history.append(assistant_msg)
                    self.db.add_message(
                        self.session_id,
                        "assistant",
                        content=full_content,
                        tool_calls=tool_calls_data
                    )

                    #  yield 
                    for tc in tool_calls_buffer:
                        yield {
                            "type": "tool_start",
                            "data": {
                                "id": tc["id"],
                                "name": tc["name"],
                                "arguments": tc["arguments"]
                            }
                        }

                        # 
                        try:
                            result = self.tool_loader.execute_tool(
                                tc["name"],
                                json.loads(tc["arguments"])
                            )
                            result_str = str(result)[:MAX_TOOL_RESULT_CHARS]
                        except PermissionRequestError as perm_err:
                            # ield 
                            yield {
                                "type": "permission_request",
                                "data": {
                                    "tool": perm_err.tool,
                                    "args": perm_err.tool_args,
                                    "tool_call_id": tc["id"],
                                }
                            }
                            # 
                            return
                        except Exception as e:
                            result_str = f"[tool execution failed] {str(e)}"

                        # ?
                        tool_msg = {
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": result_str
                        }
                        self.history.append(tool_msg)
                        self.db.add_message(
                            self.session_id,
                            "tool",
                            content=result_str,
                            tool_call_id=tc["id"]
                        )

                        yield {
                            "type": "tool_result",
                            "data": {
                                "id": tc["id"],
                                "result": result_str
                            }
                        }

                    # ?
                    continue

                else:
                    # ?
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_content
                    }
                    self.history.append(assistant_msg)
                    self.db.add_message(
                        self.session_id,
                        "assistant",
                        content=full_content
                    )
                    self.db.touch_session(self.session_id, message_count_delta=1)
                    final_response_parts.append(full_content)
                    break

            if self._interrupted.is_set():
                yield {"type": "done", "data": "[interrupted]"}
                return

            # 
            yield {"type": "done", "data": "".join(final_response_parts)}

        except PermissionRequestError as perm_err:
            # Web ield 
            yield {
                "type": "permission_request",
                "data": {
                    "tool": perm_err.tool,
                    "args": perm_err.tool_args,
                    "tool_call_id": None,  # ?stream ?tool_call_id
                }
            }
            # ?stream?

        except Exception as e:
            # Persist error as assistant message so UI can always render feedback
            # even if the SSE error event is lost on client side.
            err_text = f"[Error] {str(e)}"
            try:
                self.history.append({"role": "assistant", "content": err_text})
                self.db.add_message(self.session_id, "assistant", content=err_text)
                self.db.touch_session(self.session_id, message_count_delta=1)
            except Exception:
                pass
            yield {"type": "error", "data": str(e)}

        # Refine title asynchronously after first completed response.
        if final_response_parts:
            self._queue_title_refinement(user_input, "".join(final_response_parts))

    def run_locked(self, user_input: str) -> str:
        """Run single-shot chat with per-session execution lock."""
        # Do not interrupt an in-flight run. Wait until the current run finishes.
        # This preserves long-running autonomous tasks.
        self._execution_lock.acquire()
        try:
            return self.run(user_input)
        finally:
            self._execution_lock.release()

    def run_stream_locked(self, user_input: str, resume: bool = False):
        """Run streaming chat with per-session execution lock."""
        self._execution_lock.acquire()
        try:
            yield from self.run_stream(user_input, resume=resume)
        finally:
            self._execution_lock.release()

    def interrupt(self):
        """Interrupt current run/stream for this agent session."""
        self._interrupted.set()

    @staticmethod
    def _sanitize_title_text(text: str, max_len: int = 50) -> str:
        cleaned = (text or "").strip().strip('"').strip("'")
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if len(cleaned) > max_len:
            cleaned = cleaned[:max_len].rstrip()
        return cleaned

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
                prompt = (
                    "Generate a concise chat title (<=20 chars, no quotes) based on first turn:\n\n"
                    f"User: {user_input[:200]}\n"
                    f"Assistant: {assistant_response[:200]}"
                )
                title = self.llm.generate(prompt, max_tokens=50)
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

    def _call_llm(self, messages: List[Dict]) -> Any:
        response = self.llm.generate_with_tools(
            messages=messages,
            tools=self.tools
        )

        message = response.choices[0].message

        if hasattr(message, 'tool_calls') and message.tool_calls:
            import os
            debug_mode = os.environ.get('DEBUG_AGENT', '0') == '1'
            if debug_mode:
                debug_file = self.workspace_root / "workspace" / "temp" / "last_llm_response.json"
                debug_file.parent.mkdir(parents=True, exist_ok=True)
                debug_data = {
                    "content": message.content,
                    "tool_calls": [
                        {
                            "name": tc.function.name,
                            "arguments_raw": tc.function.arguments
                        }
                        for tc in message.tool_calls
                    ]
                }
                debug_file.write_text(
                    json.dumps(debug_data, ensure_ascii=False, indent=2),
                    encoding='utf-8'
                )

        return message

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

    def _handle_tool_calls(self, message) -> None:
        """Handle tool calls and persist their results."""
        # assistant ?
        tool_calls_data = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments
                }
            }
            for tc in message.tool_calls
        ]
        assistant_msg = {
            "role": "assistant",
            "content": message.content,
            "tool_calls": tool_calls_data
        }
        self.history.append(assistant_msg)
        self.db.add_message(
            self.session_id,
            "assistant",
            content=message.content,
            tool_calls=tool_calls_data
        )

        # ?
        for tool_call in message.tool_calls:
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
                result = self._execute_single_tool(tool_call)
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
            if isinstance(result, dict):
                result_str = json.dumps(result, ensure_ascii=False)
            else:
                result_str = str(result)

            import re
            result_str = re.sub(r'\x1b\[[0-9;]*m', '', result_str)

            if len(result_str) > MAX_TOOL_RESULT_CHARS:
                result_str = result_str[:MAX_TOOL_RESULT_CHARS] + f"\n\n... (truncated, original {len(result_str)} chars)"

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

    def _execute_single_tool(self, tool_call) -> Any:
        tool_name = tool_call.function.name
        raw_arguments = tool_call.function.arguments

        print(f"\nCalling tool: {tool_name}")
        print(f"   Raw args: {raw_arguments[:200] if len(raw_arguments) > 200 else raw_arguments}")

        try:
            arguments = json.loads(raw_arguments)
            print("   JSON parsed successfully")
        except json.JSONDecodeError as e:
            print(f"   JSON parse error: {e}")
            try:
                fixed_args = raw_arguments.replace("'", '"')
                arguments = json.loads(fixed_args)
                print("   JSON repaired successfully; using repaired arguments")
            except Exception:
                print("   Unable to repair JSON, using empty args")
                arguments = {}

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
        messages = [{"role": "system", "content": self.system_prompt}]
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

            if pending_ids:
                if role == "tool":
                    tcid = msg.get("tool_call_id")
                    if tcid and tcid in pending_ids:
                        sanitized.append(msg)
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
                sanitized.append(msg)
                if tc_ids:
                    pending_ids = tc_ids
                    seen_ids = set()
                    pending_assistant_idx = len(sanitized) - 1
                else:
                    # Malformed tool call payload; strip it immediately.
                    fixed = dict(msg)
                    fixed.pop("tool_calls", None)
                    sanitized[-1] = fixed
                continue

            if role == "tool":
                # Orphan tool message (no pending assistant tool_call).
                # Skip it for model input.
                continue

            sanitized.append(msg)

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
