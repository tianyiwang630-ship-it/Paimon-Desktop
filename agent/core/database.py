"""
SQLite  - sessions, messages, settings 


- Python  sqlite3
- WAL 
- 
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional
from agent.core.paths import get_runtime_root


def get_db_path() -> Path:
    """ data/agent.db"""
    runtime_root = get_runtime_root()
    return runtime_root / "data" / "agent.db"


class Database:
    """SQLite WAL """

    def __init__(self, db_path: str = None):
        if db_path is None:
            db_path = str(get_db_path())
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_schema(self):
        with self._connect() as conn:
            # 
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS projects (
                id                   TEXT PRIMARY KEY,
                name                 TEXT NOT NULL,
                description          TEXT,
                custom_instructions  TEXT,
                workspace_path       TEXT,
                settings             TEXT,
                created_at           TEXT NOT NULL,
                updated_at           TEXT NOT NULL,
                is_archived          INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_projects_updated
                ON projects(updated_at DESC);

            CREATE TABLE IF NOT EXISTS sessions (
                id            TEXT PRIMARY KEY,
                title         TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                message_count INTEGER DEFAULT 0,
                is_archived   INTEGER DEFAULT 0,
                is_pinned     INTEGER DEFAULT 0,
                project_id    TEXT,
                summary       TEXT,
                model_name    TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_updated
                ON sessions(updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_sessions_archived
                ON sessions(is_archived, updated_at DESC);

            CREATE TABLE IF NOT EXISTS messages (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   TEXT NOT NULL REFERENCES sessions(id),
                role         TEXT NOT NULL,
                content      TEXT,
                tool_calls   TEXT,
                tool_call_id TEXT,
                created_at   TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, id ASC);

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """)

            # 
            try:
                conn.execute("ALTER TABLE sessions ADD COLUMN is_archived INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # 

            try:
                conn.execute("ALTER TABLE sessions ADD COLUMN summary TEXT")
            except sqlite3.OperationalError:
                pass  # 

            try:
                conn.execute("ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # 

    #  Sessions 

    def create_session(
        self,
        session_id: str,
        model_name: str = None,
        project_id: str = None,
    ) -> Dict:
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions (id, created_at, updated_at, model_name, project_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, now, now, model_name, project_id)
            )
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_sessions(
        self,
        limit: int = 50,
        offset: int = 0,
        search: str = None,
        project_id: str = None
    ) -> List[Dict]:
        with self._connect() as conn:
            #  WHERE  - 
            conditions = ["is_archived = 0"]
            params = []

            if project_id is not None:
                # project_id = "" Your Chats
                if project_id == "":
                    conditions.append("project_id IS NULL")
                else:
                    conditions.append("project_id = ?")
                    params.append(project_id)

            if search:
                conditions.append("(s.title LIKE ? OR m.content LIKE ?)")
                params.extend([f"%{search}%", f"%{search}%"])

            where_clause = " AND ".join(conditions)

            if search:
                sql = f"""
                    SELECT DISTINCT s.*
                    FROM sessions s
                    LEFT JOIN messages m ON m.session_id = s.id
                    WHERE {where_clause}
                    ORDER BY s.is_pinned DESC, s.updated_at DESC
                    LIMIT ? OFFSET ?
                """
                params.extend([limit, offset])
            else:
                sql = f"""
                    SELECT * FROM sessions
                    WHERE {where_clause}
                    ORDER BY is_pinned DESC, updated_at DESC
                    LIMIT ? OFFSET ?
                """
                params.extend([limit, offset])

            rows = conn.execute(sql, tuple(params)).fetchall()
            return [dict(r) for r in rows]

    def count_sessions(self, search: str = None, project_id: str = None) -> int:
        with self._connect() as conn:
            #  WHERE  - 
            conditions = ["is_archived = 0"]
            params = []

            if project_id is not None:
                if project_id == "":
                    conditions.append("project_id IS NULL")
                else:
                    conditions.append("project_id = ?")
                    params.append(project_id)

            if search:
                conditions.append("(title LIKE ? OR m.content LIKE ?)")
                params.extend([f"%{search}%", f"%{search}%"])

            where_clause = " AND ".join(conditions)

            if search:
                sql = f"""
                    SELECT COUNT(DISTINCT s.id) as cnt
                    FROM sessions s
                    LEFT JOIN messages m ON m.session_id = s.id
                    WHERE {where_clause}
                """
                row = conn.execute(sql, tuple(params)).fetchone()
            else:
                sql = f"SELECT COUNT(*) as cnt FROM sessions WHERE {where_clause}"
                row = conn.execute(sql, tuple(params)).fetchone()
            return row["cnt"]

    def update_session_title(self, session_id: str, title: str):
        with self._connect() as conn:
            conn.execute(
                "UPDATE sessions SET title = ? WHERE id = ?",
                (title, session_id)
            )

    def touch_session(self, session_id: str, message_count_delta: int = 1):
        """"""
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE sessions
                SET updated_at = ?, message_count = message_count + ?
                WHERE id = ?
                """,
                (now, message_count_delta, session_id)
            )

    def archive_session(self, session_id: str):
        with self._connect() as conn:
            conn.execute(
                "UPDATE sessions SET is_archived = 1 WHERE id = ?",
                (session_id,)
            )

    def delete_session(self, session_id: str):
        """"""
        with self._connect() as conn:
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def update_session_patch(self, session_id: str, **fields):
        """title, summary """
        allowed = {"title", "summary", "project_id", "model_name", "is_pinned"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [session_id]
        with self._connect() as conn:
            conn.execute(
                f"UPDATE sessions SET {set_clause} WHERE id = ?",
                values
            )

    #  Messages 

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str = None,
        tool_calls: List = None,
        tool_call_id: str = None
    ) -> int:
        now = datetime.now().isoformat()
        tool_calls_json = json.dumps(tool_calls, ensure_ascii=False) if tool_calls else None
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO messages
                    (session_id, role, content, tool_calls, tool_call_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, role, content, tool_calls_json, tool_call_id, now)
            )
            return cur.lastrowid

    def get_messages(self, session_id: str) -> List[Dict]:
        """
         OpenAI messages 

        
            user/assistant:  {"role": ..., "content": ...}
            assistant+tools: {"role": "assistant", "content": ..., "tool_calls": [...]}
            tool result:     {"role": "tool", "tool_call_id": ..., "content": ...}
        """
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC",
                (session_id,)
            ).fetchall()

        result = []
        for row in rows:
            msg: Dict[str, Any] = {"role": row["role"]}

            if row["content"] is not None:
                msg["content"] = row["content"]

            if row["tool_calls"]:
                msg["tool_calls"] = json.loads(row["tool_calls"])

            if row["tool_call_id"]:
                msg["tool_call_id"] = row["tool_call_id"]

            result.append(msg)

        return result

    def delete_messages_after(self, session_id: str, after_id: int):
        """ id > after_id """
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND id > ?",
                (session_id, after_id)
            )

    def get_last_message_id(self, session_id: str) -> Optional[int]:
        """ id"""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT MAX(id) as max_id FROM messages WHERE session_id = ?",
                (session_id,)
            ).fetchone()
            return row["max_id"] if row and row["max_id"] is not None else None

    #  Settings 

    def get_setting(self, key: str, default=None):
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
            if row is None:
                return default
            try:
                return json.loads(row["value"])
            except Exception:
                return row["value"]

    def set_setting(self, key: str, value):
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, json.dumps(value, ensure_ascii=False))
            )

    def get_all_settings(self) -> Dict:
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
        result = {}
        for row in rows:
            try:
                result[row["key"]] = json.loads(row["value"])
            except Exception:
                result[row["key"]] = row["value"]
        return result

    def delete_setting(self, key: str):
        with self._connect() as conn:
            conn.execute("DELETE FROM settings WHERE key = ?", (key,))

    def is_configured(self) -> bool:
        """ API Key"""
        api_key = self.get_setting("llm_api_key")
        return bool(api_key)

    #  Projects 

    def create_project(
        self,
        project_id: str,
        name: str,
        description: str = None,
        custom_instructions: str = None,
        workspace_path: str = None,
        settings: dict = None,
    ) -> Dict:
        now = datetime.now().isoformat()
        settings_json = json.dumps(settings or {}, ensure_ascii=False)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO projects
                    (id, name, description, custom_instructions, workspace_path,
                     settings, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (project_id, name, description, custom_instructions,
                 workspace_path, settings_json, now, now)
            )
        return self.get_project(project_id)

    def get_project(self, project_id: str) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if not row:
                return None
            p = dict(row)
            if p.get("settings"):
                try:
                    p["settings"] = json.loads(p["settings"])
                except Exception:
                    p["settings"] = {}
            return p

    def list_projects(self) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM projects WHERE is_archived = 0 ORDER BY updated_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            p = dict(row)
            if p.get("settings"):
                try:
                    p["settings"] = json.loads(p["settings"])
                except Exception:
                    p["settings"] = {}
            result.append(p)
        return result

    def update_project(self, project_id: str, **fields) -> Optional[Dict]:
        allowed = {"name", "description", "custom_instructions", "workspace_path"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if "settings" in fields:
            updates["settings"] = json.dumps(fields["settings"], ensure_ascii=False)
        if not updates:
            return self.get_project(project_id)
        updates["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [project_id]
        with self._connect() as conn:
            conn.execute(
                f"UPDATE projects SET {set_clause} WHERE id = ?", values
            )
        return self.get_project(project_id)

    def archive_project(self, project_id: str):
        with self._connect() as conn:
            conn.execute(
                "UPDATE projects SET is_archived = 1 WHERE id = ?", (project_id,)
            )

    def delete_project(self, project_id: str):
        """ sessions  project_id  NULL"""
        with self._connect() as conn:
            conn.execute(
                "UPDATE sessions SET project_id = NULL WHERE project_id = ?",
                (project_id,)
            )
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))

    def get_project_sessions(
        self, project_id: str, limit: int = 50, offset: int = 0
    ) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM sessions
                WHERE project_id = ? AND is_archived = 0
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (project_id, limit, offset)
            ).fetchall()
        return [dict(r) for r in rows]

    def get_project_session_ids(self, project_id: str) -> List[str]:
        """Return all session IDs under a project, including archived ones."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id FROM sessions WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        return [str(r["id"]) for r in rows]

    def count_project_sessions(self, project_id: str) -> int:
        """"""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) as cnt
                FROM sessions
                WHERE project_id = ? AND is_archived = 0
                """,
                (project_id,)
            ).fetchone()
            return row["cnt"]
