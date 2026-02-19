// ─── Projects ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  description: string | null
  custom_instructions: string | null
  workspace_path: string | null
  created_at: string
  updated_at: string
  is_archived: boolean
}

export interface ProjectCreate {
  name: string
  description?: string
  custom_instructions?: string
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface Session {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
  project_id: string | null
  is_archived: boolean
  is_pinned?: boolean
}

export interface Message {
  id: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: any
  tool_call_id?: string
  created_at: string
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export interface ChatRequest {
  session_id: string
  message: string
  project_id?: string
  resume?: boolean
}

export interface ChatResponse {
  response: string
  tool_calls?: Array<{
    name: string
    arguments: string
    result: string | null
  }>
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  llm_base_url: string | null
  llm_model_name: string | null
  is_configured: boolean
}

export interface SettingsUpdate {
  llm_base_url?: string
  llm_api_key?: string
  llm_model_name?: string
}

// ─── Stream Events ───────────────────────────────────────────────────────────

export interface StreamEvent {
  type: 'reasoning' | 'content' | 'tool_start' | 'tool_result' | 'done' | 'error' | 'permission_request'
  data: any
}

export interface PermissionRequest {
  tool: string
  args: Record<string, any>
  tool_call_id: string
}

export interface PermissionConfirmRequest {
  session_id: string
  tool: string
  args: Record<string, any>
  action: 'allow_once' | 'allow_session' | 'deny' | 'retry_with_context' | 'switch_auto'
  extra_instruction?: string
}
