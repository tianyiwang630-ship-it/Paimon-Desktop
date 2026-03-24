import axios from 'axios'

import { apiClient } from './client'
import type { ChatRequest, ChatResponse } from '../types'

export interface PermissionRequiredPayload {
  code: 'permission_required'
  session_id: string
  tool: string
  args: Record<string, any>
  tool_call_id?: string | null
  pending_request_id: string
  message: string
}

export interface ChatStartResponse {
  request_id: string
  session_id: string
}

type ChatRunStatus = 'running' | 'success' | 'error' | 'permission_required' | 'interrupted'

interface ChatStatusResponse {
  request_id: string
  session_id: string
  status: ChatRunStatus
  response?: string | null
  tool_calls_count?: number
  permission_detail?: PermissionRequiredPayload | null
  error?: string | null
  created_at: string
  updated_at: string
  elapsed_ms?: number
}

const CHAT_START_TIMEOUT_MS = 30_000
const CHAT_STATUS_FETCH_TIMEOUT_MS = 15_000
const CHAT_STATUS_POLL_INTERVAL_MS = 1_000
const CHAT_STATUS_POLL_RETRY_MAX_INTERVAL_MS = 5_000

function isEndpointMissing(error: any): boolean {
  const status = error?.response?.status
  return status === 404 || status === 405
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new axios.CanceledError('Request canceled')
  }
}

function toPermissionDetail(raw: any, fallbackSessionId: string): PermissionRequiredPayload {
  return {
    code: 'permission_required',
    session_id: String(raw?.session_id || fallbackSessionId || ''),
    tool: String(raw?.tool || ''),
    args: raw?.args || {},
    tool_call_id: raw?.tool_call_id ?? null,
    pending_request_id: String(raw?.pending_request_id || ''),
    message: String(raw?.message || 'Permission confirmation required'),
  }
}

function throwPermissionRequired(detail: PermissionRequiredPayload): never {
  const error: any = new Error(detail.message || 'Permission confirmation required')
  error.response = {
    status: 409,
    data: {
      detail,
    },
  }
  throw error
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    let done = false
    const timeoutId = window.setTimeout(() => {
      if (done) return
      done = true
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      resolve()
    }, ms)

    const onAbort = () => {
      if (done) return
      done = true
      window.clearTimeout(timeoutId)
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      reject(new axios.CanceledError('Request canceled'))
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function toChatResponse(data: ChatStatusResponse, fallbackSessionId: string): ChatResponse {
  return {
    session_id: data.session_id || fallbackSessionId,
    response: String(data.response || ''),
    tool_calls_count: Number(data.tool_calls_count || 0),
  }
}

function isCanceledError(error: any): boolean {
  return (
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'CanceledError' ||
    error instanceof axios.CanceledError
  )
}

function isRetryableStatusFetchError(error: any): boolean {
  if (isCanceledError(error)) return false

  const status = Number(error?.response?.status || 0)
  if (status === 429 || status >= 500) return true
  if (status >= 400 && status < 500) return false

  const code = String(error?.code || '').toUpperCase()
  if (code === 'ECONNABORTED' || code === 'ERR_NETWORK' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return true
  }

  // No HTTP response usually means a transient network path issue.
  if (!error?.response) return true
  return false
}

function getStatusPollRetryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 3) return CHAT_STATUS_POLL_INTERVAL_MS
  if (consecutiveFailures <= 10) return 2_000
  return CHAT_STATUS_POLL_RETRY_MAX_INTERVAL_MS
}

export interface SendMessageOptions {
  onStatusRetrying?: (consecutiveFailures: number, error: any) => void
  onStatusRecovered?: (previousConsecutiveFailures: number) => void
}

export async function waitForRunCompletion(
  requestId: string,
  fallbackSessionId: string,
  options?: SendMessageOptions,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  let consecutiveFailures = 0

  while (true) {
    throwIfAborted(signal)

    let response
    try {
      response = await apiClient.get<ChatStatusResponse>(`/chat/status/${requestId}`, {
        signal,
        timeout: CHAT_STATUS_FETCH_TIMEOUT_MS,
      })
    } catch (error: any) {
      throwIfAborted(signal)
      if (!isRetryableStatusFetchError(error)) {
        throw error
      }

      consecutiveFailures += 1
      options?.onStatusRetrying?.(consecutiveFailures, error)
      await sleepWithAbort(getStatusPollRetryDelayMs(consecutiveFailures), signal)
      continue
    }

    if (consecutiveFailures > 0) {
      options?.onStatusRecovered?.(consecutiveFailures)
      consecutiveFailures = 0
    }

    const status = String(response?.data?.status || 'error') as ChatRunStatus
    if (status === 'success' || status === 'interrupted') {
      return toChatResponse(response.data, fallbackSessionId)
    }

    if (status === 'permission_required') {
      const detail = toPermissionDetail(response?.data?.permission_detail, fallbackSessionId)
      throwPermissionRequired(detail)
    }

    if (status === 'error') {
      const message = String(response?.data?.error || 'Chat request failed')
      throw new Error(message)
    }

    await sleepWithAbort(CHAT_STATUS_POLL_INTERVAL_MS, signal)
  }
}

// Non-streaming chat request with async status polling and legacy fallback.
export async function sendMessage(
  data: ChatRequest,
  signal?: AbortSignal,
  options?: SendMessageOptions,
): Promise<ChatResponse> {
  try {
    const startResponse = await apiClient.post<ChatStartResponse>('/chat/start', data, {
      timeout: CHAT_START_TIMEOUT_MS,
      signal,
    })
    const requestId = String(startResponse?.data?.request_id || '')
    if (!requestId) {
      throw new Error('Missing request id from /chat/start')
    }
    return await waitForRunCompletion(requestId, data.session_id, options, signal)
  } catch (error: any) {
    // Backward compatibility with servers that only support /chat.
    if (isEndpointMissing(error)) {
      const response = await apiClient.post<ChatResponse>('/chat', data, {
        timeout: 0,
        signal,
      })
      return response.data
    }
    throw error
  }
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
    pending_request_id: detail.pending_request_id || '',
    message: detail.message || 'Permission confirmation required',
  }
}

export async function interruptSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const response = await apiClient.post<{ ok: boolean; message: string }>('/chat/interrupt', {
    session_id: sessionId,
  })
  return response.data
}
