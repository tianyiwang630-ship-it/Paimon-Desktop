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
  provider?: string | null
  reasoning_blocks?: Array<{
    type: string
    content: string
    raw?: Record<string, any> | null
  }>
  protocol_flags?: string[]
  message_format_version?: number
  created_at: string
}

export interface SessionDetail {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  message_count: number
  is_pinned?: boolean
  model_name?: string | null
  messages: Message[]
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
  llm_provider: 'openai' | 'minimax' | 'zhipu' | 'kimi' | null
  llm_base_url: string | null
  llm_model_name: string | null
  is_configured: boolean
}

export interface SettingsUpdate {
  llm_provider?: 'openai' | 'minimax' | 'zhipu' | 'kimi'
  llm_base_url?: string
  llm_api_key?: string
  llm_model_name?: string
}

export type AppStartupState = 'starting' | 'ready' | 'failed'

export interface AppRuntimeStatus {
  backendOrigin: string
  backendApiBaseUrl: string
  backendHealthUrl: string
  startupState: AppStartupState
  startupFailureReason: string | null
  logPath: string
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
