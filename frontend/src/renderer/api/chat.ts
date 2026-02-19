import { apiClient } from './client'
import type { ChatRequest, ChatResponse } from '../types'

export interface PermissionRequiredPayload {
  code: 'permission_required'
  session_id: string
  tool: string
  args: Record<string, any>
  tool_call_id?: string | null
  message: string
}

// Non-streaming chat request (single response).
export async function sendMessage(data: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  // Long-running autonomous tasks may exceed default client timeout.
  const response = await apiClient.post<ChatResponse>('/chat', data, { timeout: 0, signal })
  return response.data
}

export function extractPermissionRequired(error: any): PermissionRequiredPayload | null {
  const status = error?.response?.status
  const detail = error?.response?.data?.detail
  if (status !== 409 || !detail || detail.code !== 'permission_required') {
    return null
  }
  return {
    code: 'permission_required',
    session_id: detail.session_id,
    tool: detail.tool,
    args: detail.args || {},
    tool_call_id: detail.tool_call_id,
    message: detail.message || 'Permission confirmation required',
  }
}

export async function interruptSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const response = await apiClient.post<{ ok: boolean; message: string }>('/chat/interrupt', {
    session_id: sessionId,
  })
  return response.data
}
