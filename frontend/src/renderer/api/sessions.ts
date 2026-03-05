import { apiClient } from './client'
import type { Session, SessionDetail } from '../types'

export async function createSession(projectId?: string | null): Promise<Session> {
  const response = await apiClient.post<Session>('/sessions', {
    project_id: projectId || undefined,
  })
  return response.data
}

export async function listSessions(): Promise<Session[]> {
  const response = await apiClient.get<{ sessions: Session[]; total: number }>('/sessions')
  return response.data.sessions
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const response = await apiClient.get<SessionDetail>(`/sessions/${sessionId}`)
  return response.data
}

export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<Session> {
  const response = await apiClient.patch<Session>(`/sessions/${sessionId}`, {
    title,
  })
  return response.data
}

export async function updateSessionPin(
  sessionId: string,
  isPinned: boolean
): Promise<Session> {
  const response = await apiClient.patch<Session>(`/sessions/${sessionId}`, {
    is_pinned: isPinned,
  })
  return response.data
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/sessions/${sessionId}`, {
    params: { hard: true },
  })
}
