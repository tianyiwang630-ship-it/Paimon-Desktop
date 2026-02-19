import { create } from 'zustand'
import type { Session, Message } from '../types'
import * as sessionAPI from '../api/sessions'

interface SessionStore {
  // 状态
  sessions: Session[]
  currentSessionId: string | null
  currentMessages: Message[]
  loading: boolean

  // 操作
  loadSessions: () => Promise<void>
  createSession: (projectId?: string | null) => Promise<Session>
  loadSessionMessages: (sessionId: string) => Promise<void>
  setCurrentSession: (sessionId: string) => Promise<void>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  toggleSessionPin: (sessionId: string, isPinned: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  addOptimisticMessage: (message: Omit<Message, 'id' | 'created_at'>) => void
  clearCurrentSession: () => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  currentMessages: [],
  loading: false,

  loadSessions: async () => {
    set({ loading: true })
    try {
      const sessions = await sessionAPI.listSessions()
      set({ sessions: Array.isArray(sessions) ? sessions : [] })
    } catch (error) {
      console.error('Failed to load sessions:', error)
      set({ sessions: [] }) // 错误时确保为空数组
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
    }))
    return session
  },

  loadSessionMessages: async (sessionId: string) => {
    set({ loading: true })
    try {
      const { messages } = await sessionAPI.getSession(sessionId)
      set({ currentMessages: messages })
    } catch (error) {
      console.error('Failed to load messages:', error)
    } finally {
      set({ loading: false })
    }
  },

  setCurrentSession: async (sessionId: string) => {
    // 先设置会话 ID，确保状态一致性
    set({ currentSessionId: sessionId, currentMessages: [] })
    // 使用 get() 获取最新的会话 ID，防止竞态条件
    const currentId = get().currentSessionId
    if (currentId !== sessionId) {
      return // 会话已切换，跳过加载
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
      }))
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  },

  addOptimisticMessage: (message) => {
    set((state) => ({
      currentMessages: [
        ...state.currentMessages,
        {
          ...message,
          id: -(Date.now() + Math.random()), // 负数临时 ID，避免与真实 ID 冲突
          created_at: new Date().toISOString(),
        },
      ],
    }))
  },

  clearCurrentSession: () => {
    set({ currentSessionId: null, currentMessages: [] })
  },
}))
