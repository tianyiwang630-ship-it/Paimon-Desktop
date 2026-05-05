import axios from 'axios'

import { apiClient } from './client'

type ChatDebugLayer = 'frontend' | 'backend'

interface ChatDebugPayload {
  layer?: ChatDebugLayer
  session_id?: string
  project_id?: string
  request_id?: string
  duration_ms?: number
  http_status?: number
  data?: Record<string, any>
  error?: Record<string, any>
}

function truthyEnv(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

export function isChatDebugEnabled(): boolean {
  const electronFlag = (window as any).electronAPI?.chatDebugEnabled
  const viteFlag = (import.meta as any).env?.VITE_PAIMON_DEBUG_CHAT
  return truthyEnv(electronFlag) || truthyEnv(viteFlag)
}

export function summarizeText(value: unknown, previewChars = 80): Record<string, any> {
  const text = value == null ? '' : String(value)
  return {
    length: text.length,
    preview: text.slice(0, previewChars),
    truncated: text.length > previewChars,
  }
}

export function serializeChatDebugError(error: any): Record<string, any> {
  const payload: Record<string, any> = {
    name: error?.name || '',
    message: String(error?.message || ''),
    code: error?.code || '',
    status: error?.response?.status,
    isAxiosError: axios.isAxiosError(error),
    hasResponse: Boolean(error?.response),
  }

  const detail = error?.response?.data?.detail
  if (typeof detail === 'string') {
    payload.detail = summarizeText(detail)
  } else if (detail && typeof detail === 'object') {
    payload.detail = {
      code: detail.code,
      message: summarizeText(detail.message || ''),
    }
  }
  return payload
}

export function logChatDebug(event: string, payload: ChatDebugPayload = {}): void {
  if (!isChatDebugEnabled()) return

  const baseURL = String(apiClient.defaults.baseURL || '').replace(/\/+$/, '')
  void axios
    .post(
      '/debug/chat-log',
      {
        event,
        layer: 'frontend',
        ...payload,
      },
      { baseURL, timeout: 2_000 },
    )
    .catch(() => {})
}
