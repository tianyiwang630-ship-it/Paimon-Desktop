import { create } from 'zustand'
import type { Session, Message } from '../types'
import * as sessionAPI from '../api/sessions'

interface SessionStore {
  sessions: Session[]
  currentSessionId: string | null
  currentMessages: Message[]
  messageCache: Record<string, Message[]>
  loading: boolean

  loadSessions: () => Promise<void>
  createSession: (projectId?: string | null) => Promise<Session>
  loadSessionMessages: (sessionId: string) => Promise<boolean>
  setCurrentSession: (sessionId: string) => Promise<void>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  toggleSessionPin: (sessionId: string, isPinned: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  addOptimisticMessage: (message: Omit<Message, 'id' | 'created_at'>) => void
  clearCurrentSession: () => void
}

function isOptimisticMessage(message: Partial<Message>): boolean {
  return typeof (message as any)?.id === 'number' && ((message as any).id as number) < 0
}

function normalizeMessageKey(message: Partial<Message>): string {
  const role = String(message.role || '')
  const content = String(message.content || '')
  const toolCallId = String((message as any).tool_call_id || '')
  const toolCalls = (() => {
    try {
      return JSON.stringify((message as any).tool_calls || null)
    } catch {
      return ''
    }
  })()
  return `${role}::${content}::${toolCallId}::${toolCalls}`
}

const MESSAGE_ACK_MAX_NEGATIVE_SKEW_MS = 1000

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? null : ts
}

function findAckedServerIndex(
  server: Message[],
  usedServerIndices: Set<number>,
  optimistic: Message,
): number {
  const key = normalizeMessageKey(optimistic)
  const optimisticTs = parseTimestamp(optimistic.created_at)

  // Scan newest-first to avoid accidentally matching an older identical message
  // (for example repeated "continue") before the current optimistic send is persisted.
  for (let i = server.length - 1; i >= 0; i -= 1) {
    if (usedServerIndices.has(i)) continue
    const candidate = server[i]
    if (normalizeMessageKey(candidate) !== key) continue

    const candidateTs = parseTimestamp(candidate.created_at)
    if (optimisticTs !== null) {
      // If server timestamp is missing, do not ACK an optimistic message yet.
      if (candidateTs === null) {
        continue
      }
      if (candidateTs < optimisticTs - MESSAGE_ACK_MAX_NEGATIVE_SKEW_MS) {
        continue
      }
    }

    return i
  }

  return -1
}

function mergeServerAndOptimisticMessages(
  serverMessages: Message[],
  currentMessages: Message[],
): Message[] {
  const optimistic = (currentMessages || []).filter((m) => isOptimisticMessage(m))
  if (optimistic.length === 0) {
    return serverMessages || []
  }

  const server = serverMessages || []
  const usedServerIndices = new Set<number>()
  const keepOptimistic: Message[] = []

  for (const msg of optimistic) {
    const ackedIndex = findAckedServerIndex(server, usedServerIndices, msg as Message)
    if (ackedIndex >= 0) {
      usedServerIndices.add(ackedIndex)
      continue
    }
    keepOptimistic.push(msg as Message)
  }

  return [...server, ...keepOptimistic]
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  currentMessages: [],
  messageCache: {},
  loading: false,

  loadSessions: async () => {
    set({ loading: true })
    try {
      const sessions = await sessionAPI.listSessions()
      set({ sessions: Array.isArray(sessions) ? sessions : [] })
    } catch (error) {
      console.error('Failed to load sessions:', error)
      set({ sessions: [] })
    } finally {
      set({ loading: false })
    }
  },

  createSession: async (projectId?: string | null) => {
    const session = await sessionAPI.createSession(projectId)
    set((state) => ({
      sessions: [session, ...state.sessions.filter((s) => s.id !== session.id)],
      currentSessionId: session.id,
      currentMessages: [],
      messageCache: {
        ...state.messageCache,
        [session.id]: [],
      },
    }))
    return session
  },

  loadSessionMessages: async (sessionId: string) => {
    set({ loading: true })
    try {
      const detail = await sessionAPI.getSession(sessionId)
      const messages = Array.isArray(detail.messages) ? detail.messages : []
      set((state) => {
        const merged = mergeServerAndOptimisticMessages(
          messages as Message[],
          state.currentMessages,
        )

        const nextCache = {
          ...state.messageCache,
          [sessionId]: merged,
        }

        if (state.currentSessionId !== sessionId) {
          return {
            messageCache: nextCache,
          }
        }
        return {
          currentMessages: merged,
          messageCache: nextCache,
        }
      })

      // Best-effort session metadata sync in case title/message_count changed.
      set((state) => {
        const idx = state.sessions.findIndex((s) => s.id === sessionId)
        if (idx < 0) return state
        const session = state.sessions[idx]
        const maybeUpdated: Session = {
          ...session,
          title: detail.title ?? session.title,
          message_count: detail.message_count ?? session.message_count,
          updated_at: detail.updated_at || session.updated_at,
          is_pinned: detail.is_pinned ?? session.is_pinned,
        }
        const nextSessions = [...state.sessions]
        nextSessions[idx] = maybeUpdated
        return {
          sessions: nextSessions,
        }
      })

      return true
    } catch (error) {
      console.error('Failed to load messages:', error)
      set((state) => {
        if (state.currentSessionId !== sessionId) {
          return state
        }
        const cached = state.messageCache[sessionId]
        if (!Array.isArray(cached)) {
          return state
        }
        return {
          currentMessages: cached,
        }
      })
      return false
    } finally {
      set({ loading: false })
    }
  },

  setCurrentSession: async (sessionId: string) => {
    const cached = get().messageCache[sessionId]
    set({
      currentSessionId: sessionId,
      currentMessages: Array.isArray(cached) ? cached : [],
    })
    const currentId = get().currentSessionId
    if (currentId !== sessionId) {
      return
    }
    await get().loadSessionMessages(sessionId)
  },

  updateSessionTitle: async (sessionId: string, title: string) => {
    try {
      await sessionAPI.updateSessionTitle(sessionId, title)
      await get().loadSessions()
    } catch (error) {
      console.error('Failed to update session title:', error)
    }
  },

  toggleSessionPin: async (sessionId: string, isPinned: boolean) => {
    try {
      await sessionAPI.updateSessionPin(sessionId, isPinned)
      await get().loadSessions()
    } catch (error) {
      console.error('Failed to update session pin:', error)
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await sessionAPI.deleteSession(sessionId)
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        currentSessionId:
          state.currentSessionId === sessionId ? null : state.currentSessionId,
        currentMessages:
          state.currentSessionId === sessionId ? [] : state.currentMessages,
        messageCache: Object.fromEntries(
          Object.entries(state.messageCache).filter(([id]) => id !== sessionId),
        ),
      }))
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  },

  addOptimisticMessage: (message) => {
    set((state) => {
      const optimisticMessage: Message = {
        ...message,
        id: -(Date.now() + Math.random()),
        created_at: new Date().toISOString(),
      }
      const nextCurrentMessages = [...state.currentMessages, optimisticMessage]
      const sessionId = state.currentSessionId

      if (!sessionId) {
        return {
          currentMessages: nextCurrentMessages,
        }
      }

      return {
        currentMessages: nextCurrentMessages,
        messageCache: {
          ...state.messageCache,
          [sessionId]: nextCurrentMessages,
        },
      }
    })
  },

  clearCurrentSession: () => {
    set({ currentSessionId: null, currentMessages: [] })
  },
}))

