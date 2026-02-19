"""
Pydantic /
"""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel


#  Projects 

class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    custom_instructions: Optional[str] = None


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    custom_instructions: Optional[str] = None


class ProjectInfo(BaseModel):
    id: str
    name: str
    description: Optional[str]
    custom_instructions: Optional[str]
    workspace_path: Optional[str]
    created_at: str
    updated_at: str
    is_archived: bool


#  Sessions 

class SessionCreate(BaseModel):
    """"""
    session_id: Optional[str] = None
    project_id: Optional[str] = None


class SessionPatch(BaseModel):
    """"""
    title: Optional[str] = None
    is_pinned: Optional[bool] = None


class SessionInfo(BaseModel):
    """"""
    id: str
    title: Optional[str]
    created_at: str
    updated_at: str
    message_count: int
    is_archived: bool
    is_pinned: bool = False
    project_id: Optional[str]
    model_name: Optional[str]


class SessionListResponse(BaseModel):
    sessions: List[SessionInfo]
    total: int
    limit: int
    offset: int


class MessageItem(BaseModel):
    """"""
    role: str
    content: Optional[str]
    tool_calls: Optional[List[Dict[str, Any]]]
    tool_call_id: Optional[str]


class SessionDetail(BaseModel):
    """"""
    id: str
    title: Optional[str]
    created_at: str
    updated_at: str
    message_count: int
    is_pinned: bool = False
    model_name: Optional[str]
    messages: List[MessageItem]


#  Chat 

class ChatRequest(BaseModel):
    session_id: str
    message: str
    project_id: Optional[str] = None  # 
    resume: bool = False  # 


class ToolCallInfo(BaseModel):
    name: str
    arguments: str
    result: Optional[str] = None


class ChatResponse(BaseModel):
    session_id: str
    response: str
    tool_calls_count: int = 0


class ChatInterruptRequest(BaseModel):
    session_id: str


class ChatInterruptResponse(BaseModel):
    ok: bool
    message: str


#  Settings 

class SettingsPatch(BaseModel):
    llm_base_url: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model_name: Optional[str] = None


class SettingsResponse(BaseModel):
    llm_base_url: Optional[str]
    llm_model_name: Optional[str]
    is_configured: bool
    # api_key 


class ConfigStatus(BaseModel):
    is_configured: bool


#  Files 

class FileInfo(BaseModel):
    name: str
    path: str
    size: int
    is_dir: bool


#  Permissions 

class PermissionConfirmRequest(BaseModel):
    """"""
    session_id: str
    tool: str
    args: Dict[str, Any]
    action: str  # "allow_once", "allow_session", "deny", "retry_with_context", "switch_auto"
    extra_instruction: Optional[str] = None


class PermissionConfirmResponse(BaseModel):
    """"""
    success: bool
    message: str

class PermissionModeRequest(BaseModel):
    session_id: str
    mode: str  # "ask" | "auto"


class PermissionModeResponse(BaseModel):
    success: bool
    mode: str
    message: str

