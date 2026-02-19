import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useSessionStore } from '../store/session'
import { useProjectStore } from '../store/project'
import { extractPermissionRequired, interruptSession, sendMessage } from '../api/chat'
import { getSettings, updateSettings } from '../api/settings'
import { getAppGuide, getSkillCatalog } from '../api/meta'
import { confirmPermission, setPermissionMode } from '../api/permissions'
import type { Message, SettingsUpdate } from '../types'
import FileManager from '../components/FileManager'

interface RenderMessage {
  key: string
  role: 'user' | 'assistant'
  content: string
  details: IntermediateStep[]
  rawContent?: string
}

interface IntermediateStep {
  role: 'assistant' | 'tool'
  content: string
}

interface ParsedTurn {
  userContent: string
  finalAssistant: string
  finalAssistantRaw: string
  details: IntermediateStep[]
  isOpen: boolean
}

type AssistantViewMode = 'rendered' | 'raw'

interface TruncateLimits {
  maxChars: number
  maxLines: number
}

interface SlashPickerOption {
  id: string
  label: string
  type: 'skill' | 'permission'
  skillName?: string
  permissionMode?: 'ask' | 'auto'
}

interface PendingPermissionRequest {
  sessionId: string
  tool: string
  args: Record<string, any>
  toolCallId?: string | null
}

const TOOL_PREVIEW_LIMITS: TruncateLimits = {
  maxChars: 1000,
  maxLines: 20,
}

const LIVE_STEP_PREVIEW_LIMITS: TruncateLimits = {
  maxChars: 360,
  maxLines: 6,
}

const FALLBACK_SKILLS = [
  'calculator',
  'docx',
  'humanizer',
  'pdf',
  'planwithfile',
  'pptx',
  'skill-creator',
  'xiaohongshu',
  'xlsx',
]

function truncatePreview(
  text: string,
  limits: TruncateLimits,
): { content: string; truncated: boolean } {
  if (!text) {
    return { content: '', truncated: false }
  }

  const lines = text.split(/\r?\n/)
  let limited = text
  let truncated = false

  if (lines.length > limits.maxLines) {
    limited = lines.slice(0, limits.maxLines).join('\n')
    truncated = true
  }

  if (limited.length > limits.maxChars) {
    limited = limited.slice(0, limits.maxChars)
    truncated = true
  }

  return { content: limited, truncated }
}

function truncateToolPreview(text: string): { content: string; truncated: boolean } {
  return truncatePreview(text, TOOL_PREVIEW_LIMITS)
}

function truncateLiveStepPreview(text: string): { content: string; truncated: boolean } {
  return truncatePreview(text, LIVE_STEP_PREVIEW_LIMITS)
}

function summarizeStep(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return '(empty step)'
  if (compact.length <= 80) return compact
  return `${compact.slice(0, 80)}...`
}

function extractThinkBlocks(text: string): { visible: string; hidden: string[] } {
  const hidden: string[] = []
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi
  let match: RegExpExecArray | null

  while ((match = thinkRegex.exec(text)) !== null) {
    const block = (match[1] || '').trim()
    if (block) hidden.push(`[Think]\n${block}`)
  }

  const visible = text.replace(thinkRegex, '').trim()
  return { visible, hidden }
}

function parseTurns(messages: Message[]): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let turn: ParsedTurn | null = null

  const flush = (isOpen: boolean) => {
    if (!turn) return
    turns.push({
      ...turn,
      isOpen,
    })
    turn = null
  }

  for (const msg of messages || []) {
    if (msg.role === 'user') {
      flush(false)
      turn = {
        userContent: msg.content || '',
        finalAssistant: '',
        finalAssistantRaw: '',
        details: [],
        isOpen: true,
      }
      continue
    }

    if (!turn) {
      continue
    }
    const activeTurn = turn

    if (msg.role === 'tool') {
      const toolText = (msg.content || '').trim()
      if (toolText) {
        activeTurn.details.push({
          role: 'tool',
          content: toolText,
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const raw = msg.content || ''
      const { visible, hidden } = extractThinkBlocks(raw)
      hidden.forEach((block) => {
        activeTurn.details.push({
          role: 'assistant',
          content: block,
        })
      })

      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
      const assistantText = (visible || raw || '').trim()
      if (hasToolCalls) {
        if (assistantText) {
          activeTurn.details.push({
            role: 'assistant',
            content: assistantText,
          })
        }
      } else {
        if (activeTurn.finalAssistant) {
          activeTurn.details.push({
            role: 'assistant',
            content: activeTurn.finalAssistant,
          })
        }
        activeTurn.finalAssistant = assistantText
        activeTurn.finalAssistantRaw = (raw || '').trim() || assistantText
      }
    }
  }

  flush(true)
  return turns
}

function buildRenderMessages(
  turns: ParsedTurn[],
  options?: {
    hideLastOpenIntermediate?: boolean
  },
): RenderMessage[] {
  const rendered: RenderMessage[] = []

  turns.forEach((turn, index) => {
    rendered.push({
      key: `u-${index}`,
      role: 'user',
      content: turn.userContent,
      details: [],
    })

    const isLast = index === turns.length - 1
    const hideIntermediateOnlyAssistant =
      Boolean(options?.hideLastOpenIntermediate) &&
      isLast &&
      turn.isOpen &&
      !turn.finalAssistant &&
      turn.details.length > 0

    if (hideIntermediateOnlyAssistant) {
      return
    }

    if (turn.finalAssistant || turn.details.length > 0) {
      rendered.push({
        key: `a-${index}`,
        role: 'assistant',
        content: turn.finalAssistant || 'No final text. Open details to inspect intermediate steps.',
        rawContent: turn.finalAssistant ? (turn.finalAssistantRaw || turn.finalAssistant) : undefined,
        details: turn.details,
      })
    }
  })

    return rendered
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="space-y-2 break-words text-left">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="whitespace-pre-wrap">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-400 pl-3 italic text-gray-700">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-gray-400 bg-gray-100 px-2 py-1 text-left">{children}</th>,
          td: ({ children }) => <td className="border border-gray-300 px-2 py-1 align-top">{children}</td>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded bg-gray-100 p-2 text-sm">{children}</pre>,
          code: ({ children, ...props }: any) => {
            const isInline = Boolean(props.inline)
            return isInline ? (
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em]">{children}</code>
            ) : (
              <code className="text-sm">{children}</code>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default function ChatPage() {
  const [showFileManager, setShowFileManager] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [panelMode, setPanelMode] = useState<'chat' | 'guide' | 'config'>('chat')
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [input, setInput] = useState('')
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingSessionTitle, setEditingSessionTitle] = useState('')
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null)
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(new Set())
  const [guideText, setGuideText] = useState('')
  const [guideLoading, setGuideLoading] = useState(false)
  const [guideError, setGuideError] = useState('')
  const [skillCatalog, setSkillCatalog] = useState<string[]>(FALLBACK_SKILLS)
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false)
  const [skillCatalogReady, setSkillCatalogReady] = useState(false)
  const [skillCatalogError, setSkillCatalogError] = useState('')
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PendingPermissionRequest | null>(null)
  const [permissionNote, setPermissionNote] = useState('')
  const [permissionSubmitting, setPermissionSubmitting] = useState(false)
  const [permissionMessage, setPermissionMessage] = useState('')
  const [settingsForm, setSettingsForm] = useState<SettingsUpdate>({
    llm_base_url: '',
    llm_api_key: '',
    llm_model_name: '',
  })
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [assistantViewModes, setAssistantViewModes] = useState<Record<string, AssistantViewMode>>({})

  const activeSessionIdRef = useRef<string | null>(null)
  const inFlightSessionsRef = useRef<Set<string>>(new Set())
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageInputRef = useRef<HTMLInputElement>(null)
  const skillOptionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const {
    sessions,
    currentSessionId,
    currentMessages,
    loadSessions,
    createSession,
    loadSessionMessages,
    setCurrentSession,
    updateSessionTitle,
    toggleSessionPin,
    deleteSession,
    addOptimisticMessage,
    clearCurrentSession,
  } = useSessionStore()

  const {
    projects,
    loadProjects,
    currentProjectId,
    setCurrentProject,
    createProject,
    deleteProject,
  } =
    useProjectStore()

  const nonProjectSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions.filter((s) => !s.project_id) : []),
    [sessions],
  )

  const projectSessions = (projectId: string) =>
    Array.isArray(sessions) ? sessions.filter((s) => s.project_id === projectId) : []

  const currentPending = currentSessionId ? pendingSessions.has(currentSessionId) : false
  const parsedTurns = useMemo(
    () => parseTurns((currentMessages as Message[]) || []),
    [currentMessages],
  )

  const renderMessages = useMemo(
    () =>
      buildRenderMessages(parsedTurns, {
        hideLastOpenIntermediate: currentPending,
      }),
    [parsedTurns, currentPending],
  )

  const pendingTurnDetails = useMemo(() => {
    if (!currentPending || parsedTurns.length === 0) return [] as IntermediateStep[]
    const lastTurn = parsedTurns[parsedTurns.length - 1]
    if (!lastTurn?.isOpen) return [] as IntermediateStep[]
    return Array.isArray(lastTurn.details) ? lastTurn.details : []
  }, [parsedTurns, currentPending])

  const shouldShowSkillPicker = !currentPending && input.startsWith('/')
  const skillQuery = shouldShowSkillPicker ? input.slice(1).trim().toLowerCase() : ''

  const filteredSkills = useMemo(() => {
    if (!shouldShowSkillPicker) return [] as string[]
    const normalized = skillCatalog
      .map((name) => (name || '').trim())
      .filter(Boolean)
    if (!skillQuery) return normalized
    return normalized.filter((name) => name.toLowerCase().includes(skillQuery))
  }, [shouldShowSkillPicker, skillCatalog, skillQuery])

  const filteredPermissionOptions = useMemo(() => {
    if (!shouldShowSkillPicker) return [] as SlashPickerOption[]
    const options: SlashPickerOption[] = [
      { id: 'perm-ask', label: 'Permission: ask', type: 'permission', permissionMode: 'ask' },
      { id: 'perm-auto', label: 'Permission: auto', type: 'permission', permissionMode: 'auto' },
    ]
    if (!skillQuery) return options
    return options.filter((option) => option.label.toLowerCase().includes(skillQuery))
  }, [shouldShowSkillPicker, skillQuery])

  const slashOptions = useMemo(() => {
    const skillOptions: SlashPickerOption[] = filteredSkills.map((skillName) => ({
      id: 'skill-' + skillName,
      label: skillName,
      type: 'skill',
      skillName,
    }))
    return [...skillOptions, ...filteredPermissionOptions]
  }, [filteredSkills, filteredPermissionOptions])

  useEffect(() => {
    if (!shouldShowSkillPicker) {
      setHighlightedSkillIndex(0)
      return
    }
    setHighlightedSkillIndex(0)
  }, [shouldShowSkillPicker, skillQuery])

  useEffect(() => {
    if (!shouldShowSkillPicker) return
    if (slashOptions.length === 0) {
      setHighlightedSkillIndex(0)
      return
    }
    setHighlightedSkillIndex((prev) => {
      if (prev < 0) return 0
      if (prev >= slashOptions.length) return slashOptions.length - 1
      return prev
    })
  }, [shouldShowSkillPicker, slashOptions.length])

  useEffect(() => {
    if (!shouldShowSkillPicker || slashOptions.length === 0) return
    const target = skillOptionRefs.current[highlightedSkillIndex]
    target?.scrollIntoView({ block: 'nearest' })
  }, [shouldShowSkillPicker, slashOptions, highlightedSkillIndex])

  useEffect(() => {
    void loadSessions()
    void loadProjects()
  }, [loadSessions, loadProjects])

  useEffect(() => {
    activeSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  useEffect(() => {
    if (!currentSessionId || !currentPending) return

    let disposed = false
    let polling = false
    const poll = async () => {
      if (disposed || polling) return
      polling = true
      try {
        await loadSessionMessages(currentSessionId)
      } catch {
        // Ignore polling errors; final refresh still runs after request completion.
      } finally {
        polling = false
      }
    }

    void poll()
    const intervalId = window.setInterval(() => {
      void poll()
    }, 1000)

    return () => {
      disposed = true
      window.clearInterval(intervalId)
    }
  }, [currentSessionId, currentPending, loadSessionMessages])

  useEffect(() => {
    if (panelMode !== 'chat') return
    if (!shouldAutoScroll) return
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
      return
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [renderMessages, currentPending, pendingTurnDetails.length, shouldAutoScroll, panelMode])

  useEffect(() => {
    setShouldAutoScroll(true)
    setAssistantViewModes({})
  }, [currentSessionId])

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-session-menu-root="true"]')) return
      setOpenSessionMenuId(null)
    }
    document.addEventListener('click', onDocumentClick)
    return () => document.removeEventListener('click', onDocumentClick)
  }, [])

  useEffect(() => {
    if (!shouldShowSkillPicker || skillCatalogReady || skillCatalogLoading) return

    let canceled = false
    const load = async () => {
      setSkillCatalogLoading(true)
      setSkillCatalogError('')
      try {
        const data = await getSkillCatalog()
        if (canceled) return
        setSkillCatalog(Array.isArray(data.skills) ? data.skills : [])
      } catch (error: any) {
        if (canceled) return
        setSkillCatalog(FALLBACK_SKILLS)
        setSkillCatalogError((error?.message || 'Failed to load skills') + ' (showing default skills)')
      } finally {
        if (!canceled) {
          setSkillCatalogReady(true)
          setSkillCatalogLoading(false)
        }
      }
    }

    void load()
    return () => {
      canceled = true
    }
  }, [shouldShowSkillPicker, skillCatalogReady, skillCatalogLoading])

  const markPending = (sessionId: string, pending: boolean) => {
    if (pending) inFlightSessionsRef.current.add(sessionId)
    else inFlightSessionsRef.current.delete(sessionId)

    setPendingSessions((prev) => {
      const next = new Set(prev)
      if (pending) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }

  const handlePermissionRequired = (sessionId: string, error: any): boolean => {
    const permission = extractPermissionRequired(error)
    if (!permission) return false

    setPendingPermission({
      sessionId,
      tool: permission.tool,
      args: permission.args || {},
      toolCallId: permission.tool_call_id,
    })
    setPermissionNote('')
    setPermissionMessage('')
    return true
  }

  const toggleAssistantViewMode = (messageKey: string) => {
    setAssistantViewModes((prev) => {
      const currentMode = prev[messageKey] || 'rendered'
      const nextMode: AssistantViewMode = currentMode === 'raw' ? 'rendered' : 'raw'
      return {
        ...prev,
        [messageKey]: nextMode,
      }
    })
  }

  const runResumeRequest = async (sessionId: string) => {
    markPending(sessionId, true)
    const controller = new AbortController()
    abortControllersRef.current.set(sessionId, controller)

    let wasCanceled = false
    try {
      await sendMessage(
        {
          session_id: sessionId,
          message: '',
          project_id: currentProjectId || undefined,
          resume: true,
        },
        controller.signal,
      )
    } catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') {
        wasCanceled = true
      } else if (!handlePermissionRequired(sessionId, error)) {
        console.error('Resume request failed:', error)
        addOptimisticMessage({
          role: 'assistant',
          content: `[Error] ${error?.message || 'Request failed'}`,
        })
      }
    } finally {
      abortControllersRef.current.delete(sessionId)
      markPending(sessionId, false)
      if (wasCanceled) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      await loadSessionMessages(sessionId).catch(() => {})
      await loadSessions().catch(() => {})
      window.setTimeout(() => {
        void loadSessions().catch(() => {})
      }, 1200)
    }
  }

  const handleSend = async () => {
    if (!input.trim()) return

    let sessionId = currentSessionId
    if (!sessionId) {
      const created = await createSession(currentProjectId || null)
      sessionId = created.id
      activeSessionIdRef.current = sessionId
    }

    if (inFlightSessionsRef.current.has(sessionId)) return

    const message = input.trim()
    setInput('')
    activeSessionIdRef.current = sessionId
    setShouldAutoScroll(true)

    addOptimisticMessage({ role: 'user', content: message })
    markPending(sessionId, true)
    const controller = new AbortController()
    abortControllersRef.current.set(sessionId, controller)
    let wasCanceled = false

    try {
      await sendMessage(
        {
          session_id: sessionId,
          message,
          project_id: currentProjectId || undefined,
        },
        controller.signal,
      )
    } catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') {
        wasCanceled = true
      } else if (!handlePermissionRequired(sessionId, error)) {
        console.error('Send message failed:', error)
        addOptimisticMessage({
          role: 'assistant',
          content: `[Error] ${error?.message || 'Request failed'}`,
        })
      }
    } finally {
      abortControllersRef.current.delete(sessionId)
      markPending(sessionId, false)
      if (wasCanceled) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      await loadSessionMessages(sessionId).catch(() => {})
      await loadSessions().catch(() => {})
      window.setTimeout(() => {
        void loadSessions().catch(() => {})
      }, 1500)
    }
  }

  const handleInterrupt = async () => {
    const sessionId = currentSessionId
    if (!sessionId || !inFlightSessionsRef.current.has(sessionId)) return
    try {
      await interruptSession(sessionId)
    } catch (error) {
      console.error('Interrupt request failed:', error)
    } finally {
      abortControllersRef.current.get(sessionId)?.abort()
    }
  }

  const handleNewChat = async () => {
    try {
      const created = await createSession(currentProjectId || null)
      await setCurrentSession(created.id)
      activeSessionIdRef.current = created.id
      setInput('')
    } catch (error) {
      console.error('Failed to create chat:', error)
    }
  }

  const handleNewProjectChat = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    try {
      setCurrentProject(projectId)
      const created = await createSession(projectId)
      await setCurrentSession(created.id)
      activeSessionIdRef.current = created.id
      setInput('')
    } catch (error) {
      console.error('Failed to create project chat:', error)
    }
  }

  const handleSelectProject = (projectId: string | null) => {
    setCurrentProject(projectId)
    clearCurrentSession()
    activeSessionIdRef.current = null
    setInput('')
    setShowProjects(false)
  }

  const handleSelectSession = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (session?.project_id) setCurrentProject(session.project_id)
    else setCurrentProject(null)

    setEditingSessionId(null)
    setOpenSessionMenuId(null)
    void setCurrentSession(sessionId)
    activeSessionIdRef.current = sessionId
  }

  const commitSessionRename = async (sessionId: string, originalTitle: string) => {
    const nextTitle = editingSessionTitle.trim()
    setEditingSessionId(null)
    setEditingSessionTitle('')
    if (!nextTitle || nextTitle === (originalTitle || '')) return
    await updateSessionTitle(sessionId, nextTitle)
  }

  const confirmAndDeleteSession = async (sessionId: string) => {
    if (!confirm('Delete this chat?')) return
    setOpenSessionMenuId(null)
    await deleteSession(sessionId)
    if (activeSessionIdRef.current === sessionId) {
      clearCurrentSession()
      activeSessionIdRef.current = null
      setInput('')
    }
  }

  const handleDeleteProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    if (!confirm('Delete this project and all project chats/files?')) return

    await deleteProject(projectId)

    if (currentProjectId === projectId) {
      setCurrentProject(null)
      clearCurrentSession()
      activeSessionIdRef.current = null
      setInput('')
    }
  }

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return
    try {
      await createProject({ name: newProjectName.trim() })
      setNewProjectName('')
      setShowNewProject(false)
      await loadProjects()
    } catch (error) {
      console.error('Failed to create project:', error)
    }
  }

  const handleOpenGuide = async () => {
    if (panelMode === 'guide') {
      setPanelMode('chat')
      return
    }
    setPanelMode('guide')
    setGuideError('')
    setSettingsSaved(false)
    if (guideText) return

    setGuideLoading(true)
    try {
      const data = await getAppGuide()
      setGuideText(data.guide || '')
    } catch (error: any) {
      console.error('Failed to load guide:', error)
      setGuideError(error?.message || 'Failed to load guide')
    } finally {
      setGuideLoading(false)
    }
  }

  const handleOpenConfig = async () => {
    if (panelMode === 'config') {
      setPanelMode('chat')
      return
    }
    setPanelMode('config')
    setSettingsSaved(false)
    try {
      const data = await getSettings()
      setSettingsForm({
        llm_base_url: data.llm_base_url || '',
        llm_api_key: '',
        llm_model_name: data.llm_model_name || '',
      })
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault()
    setSettingsLoading(true)
    setSettingsSaved(false)
    try {
      await updateSettings(settingsForm)
      setSettingsSaved(true)
      const data = await getSettings()
      setSettingsForm((prev) => ({
        ...prev,
        llm_base_url: data.llm_base_url || '',
        llm_api_key: '',
        llm_model_name: data.llm_model_name || '',
      }))
    } catch (error) {
      console.error('Failed to save settings:', error)
    } finally {
      setSettingsLoading(false)
    }
  }

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current
    if (!container) return
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const atBottom = distanceToBottom <= 80
    setShouldAutoScroll(atBottom)
  }

  const handleSelectSkill = (skillName: string) => {
    const normalizedName = (skillName || '').trim()
    if (!normalizedName) return
    setInput(`use skill: [${normalizedName}] `)
    window.setTimeout(() => {
      messageInputRef.current?.focus()
    }, 0)
  }

  const handleSelectPermissionMode = async (mode: 'ask' | 'auto') => {
    setInput('')
    setPermissionMessage(`Applying permission mode: ${mode}...`)

    try {
      let sessionId = currentSessionId
      if (!sessionId) {
        const created = await createSession(currentProjectId || null)
        sessionId = created.id
        activeSessionIdRef.current = sessionId
      }

      await setPermissionMode({ session_id: sessionId, mode })
      setPermissionMessage(`Permission mode set to ${mode} for this session.`)
    } catch (error: any) {
      console.error('Failed to switch permission mode:', error)
      setPermissionMessage(error?.message || 'Failed to switch permission mode')
    } finally {
      window.setTimeout(() => {
        messageInputRef.current?.focus()
      }, 0)
    }
  }

  const handleSelectSlashOption = async (option: SlashPickerOption) => {
    if (option.type === 'skill' && option.skillName) {
      handleSelectSkill(option.skillName)
      return
    }
    if (option.type === 'permission' && option.permissionMode) {
      await handleSelectPermissionMode(option.permissionMode)
    }
  }

  const handleRetrySkillCatalog = () => {
    setSkillCatalogLoading(false)
    setSkillCatalogReady(false)
    setSkillCatalogError('')
  }

  const handlePermissionDecision = async (
    action: 'allow_once' | 'allow_session' | 'deny' | 'retry_with_context' | 'switch_auto',
  ) => {
    if (!pendingPermission) return
    if (permissionSubmitting) return

    if (action === 'retry_with_context' && !permissionNote.trim()) {
      setPermissionMessage('Please add a retry note first.')
      return
    }

    setPermissionSubmitting(true)
    setPermissionMessage('')

    try {
      await confirmPermission({
        session_id: pendingPermission.sessionId,
        tool: pendingPermission.tool,
        args: pendingPermission.args,
        action,
        extra_instruction: action === 'retry_with_context' ? permissionNote.trim() : undefined,
      })

      const sessionId = pendingPermission.sessionId
      setPendingPermission(null)
      setPermissionNote('')

      if (action === 'deny') {
        await loadSessionMessages(sessionId).catch(() => {})
        await loadSessions().catch(() => {})
        return
      }

      await runResumeRequest(sessionId)
    } catch (error: any) {
      console.error('Permission confirmation failed:', error)
      setPermissionMessage(error?.message || 'Failed to apply permission decision')
    } finally {
      setPermissionSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen">
      <div className="flex w-64 flex-col border-r bg-gray-900 text-white">
        <div className="p-3">
          <button
            onClick={() => void handleNewChat()}
            className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-700"
          >
            + New Chat
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => setShowProjects(!showProjects)}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-gray-800"
          >
            <span>Projects</span>
            <span className="text-gray-400">{showProjects ? 'v' : '>'}</span>
          </button>

          {showProjects && (
            <div className="mt-1 space-y-1 pl-2">
              <div
                onClick={() => handleSelectProject(null)}
                className={`cursor-pointer rounded-lg px-3 py-2 text-sm hover:bg-gray-800 ${
                  !currentProjectId ? 'bg-gray-800' : ''
                }`}
              >
                Your Chats
              </div>

              {Array.isArray(projects) &&
                projects.map((project) => (
                  <div key={project.id}>
                    <div
                      onClick={() => handleSelectProject(project.id)}
                      className={`group flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-gray-800 ${
                        currentProjectId === project.id ? 'bg-gray-800' : ''
                      }`}
                    >
                      <span className="truncate">[P] {project.name}</span>
                      <div className="ml-1 flex flex-shrink-0 items-center gap-2">
                        <button
                          onClick={(e) => void handleNewProjectChat(e, project.id)}
                          className="text-gray-400 transition-colors hover:text-green-300"
                          title="New chat in this project"
                        >
                          +
                        </button>
                        <button
                          onClick={(e) => void handleDeleteProject(e, project.id)}
                          className="text-gray-500 transition-colors hover:text-red-400"
                          title="Delete project"
                        >
                          x
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

              {showNewProject ? (
                <div className="flex gap-1 px-2">
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleCreateProject()
                      if (e.key === 'Escape') setShowNewProject(false)
                    }}
                    placeholder="Project name"
                    className="flex-1 rounded bg-gray-700 px-2 py-1 text-sm text-white placeholder-gray-400"
                    autoFocus
                  />
                  <button
                    onClick={() => void handleCreateProject()}
                    className="rounded bg-blue-600 px-2 py-1 text-sm text-white"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewProject(true)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-800"
                >
                  <span>+</span> New Project
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          {(currentProjectId ? projectSessions(currentProjectId) : nonProjectSessions).map((session) => (
            <div
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              className={`group relative cursor-pointer rounded-lg px-3 py-2 text-sm transition-colors ${
                currentSessionId === session.id ? 'bg-gray-700' : 'hover:bg-gray-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                  {pendingSessions.has(session.id) && (
                    <span className="inline-block h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-green-400" />
                  )}
                  {Boolean(session.is_pinned) && (
                    <span className="rounded bg-gray-600 px-1 text-[10px] text-gray-200">PIN</span>
                  )}
                  {editingSessionId === session.id ? (
                    <input
                      value={editingSessionTitle}
                      onChange={(e) => setEditingSessionTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => void commitSessionRename(session.id, session.title || '')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void commitSessionRename(session.id, session.title || '')
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          setEditingSessionId(null)
                          setEditingSessionTitle('')
                        }
                      }}
                      className="min-w-0 flex-1 rounded bg-gray-600 px-2 py-0.5 text-sm text-white outline-none"
                      autoFocus
                    />
                  ) : (
                    <span className="truncate">{session.title || 'New chat'}</span>
                  )}
                </div>
                <div data-session-menu-root="true" className="relative ml-1 flex-shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenSessionMenuId((prev) => (prev === session.id ? null : session.id))
                    }}
                    className={`rounded px-2 py-1 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white ${
                      openSessionMenuId === session.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title="More"
                  >
                    ...
                  </button>
                  {openSessionMenuId === session.id && (
                    <div className="absolute right-0 top-8 z-10 w-32 rounded-md border border-gray-600 bg-gray-800 py-1 shadow-lg">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingSessionId(session.id)
                          setEditingSessionTitle(session.title || '')
                          setOpenSessionMenuId(null)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-700"
                      >
                        Rename
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenSessionMenuId(null)
                          void toggleSessionPin(session.id, !Boolean(session.is_pinned))
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-700"
                      >
                        {session.is_pinned ? 'Unpin' : 'Pin'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void confirmAndDeleteSession(session.id)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-red-300 hover:bg-gray-700"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="text-xs text-gray-500">{session.message_count} messages</div>
            </div>
          ))}
        </div>

        <div className="border-t border-gray-800 p-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => void handleOpenGuide()}
              className={`rounded-lg px-3 py-2 text-sm ${
                panelMode === 'guide'
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              Guide
            </button>
            <button
              onClick={() => void handleOpenConfig()}
              className={`rounded-lg px-3 py-2 text-sm ${
                panelMode === 'config'
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              Config
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        {panelMode === 'guide' && (
          <>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-lg font-semibold">Application Guide</h2>
              <button
                onClick={() => setPanelMode('chat')}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100"
              >
                Back to Chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {guideLoading && <div className="text-gray-500">Loading guide...</div>}
              {!guideLoading && guideError && (
                <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {guideError}
                </div>
              )}
              {!guideLoading && !guideError && (
                <pre className="whitespace-pre-wrap rounded border bg-gray-50 p-4 text-sm text-gray-800">
                  {guideText || 'No guide content available.'}
                </pre>
              )}
            </div>
          </>
        )}

        {panelMode === 'config' && (
          <>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-lg font-semibold">API Configuration</h2>
              <button
                onClick={() => setPanelMode('chat')}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100"
              >
                Back to Chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <form onSubmit={handleSaveConfig} className="mx-auto max-w-2xl space-y-4 rounded border p-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Base URL</label>
                  <input
                    type="text"
                    value={settingsForm.llm_base_url || ''}
                    onChange={(e) => setSettingsForm({ ...settingsForm, llm_base_url: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">API Key</label>
                  <input
                    type="password"
                    value={settingsForm.llm_api_key || ''}
                    onChange={(e) => setSettingsForm({ ...settingsForm, llm_api_key: e.target.value })}
                    placeholder="Leave empty to keep unchanged"
                    className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Model Name</label>
                  <input
                    type="text"
                    value={settingsForm.llm_model_name || ''}
                    onChange={(e) => setSettingsForm({ ...settingsForm, llm_model_name: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                {settingsSaved && (
                  <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                    Settings saved.
                  </div>
                )}
                <button
                  type="submit"
                  disabled={settingsLoading}
                  className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-400"
                >
                  {settingsLoading ? 'Saving...' : 'Save Settings'}
                </button>
              </form>
            </div>
          </>
        )}

        {panelMode === 'chat' && (
          <>
            <div
              ref={messagesContainerRef}
              onScroll={handleMessagesScroll}
              className="flex-1 overflow-y-auto p-4"
            >
              {renderMessages.map((msg) => (
                <div key={msg.key} className={`mb-4 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  <div
                    className={`inline-block max-w-2xl rounded-lg px-4 py-2 ${
                      msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-800'
                    }`}
                  >
                                        {msg.role === 'assistant' && msg.rawContent && (
                      <div className="mb-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => toggleAssistantViewMode(msg.key)}
                          className="rounded border border-gray-400 bg-white px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100"
                        >
                          {(assistantViewModes[msg.key] || 'rendered') === 'raw' ? 'Rendered' : 'Raw'}
                        </button>
                      </div>
                    )}

                    {msg.role === 'assistant' ? (
                      (assistantViewModes[msg.key] || 'rendered') === 'raw' ? (
                        <pre className="whitespace-pre-wrap">{msg.rawContent || msg.content}</pre>
                      ) : (
                        <MarkdownMessage content={msg.content} />
                      )
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                    {msg.role === 'assistant' && msg.details.length > 0 && (
                      <details className="mt-2 rounded border border-gray-300 bg-white/50 p-2 text-left text-xs">
                        <summary className="cursor-pointer text-gray-700">
                          Intermediate steps ({msg.details.length})
                        </summary>
                        <div className="mt-2 space-y-2">
                          {msg.details.map((detail, idx) => (
                            (() => {
                              const toolPreview =
                                detail.role === 'tool'
                                  ? truncateToolPreview(detail.content)
                                  : { content: detail.content, truncated: false }
                              return (
                                <div
                                  key={`${msg.key}-d-${idx}`}
                                  className="rounded bg-gray-100 p-2 text-gray-700"
                                >
                                  <div className="mb-1 font-semibold text-gray-600">
                                    {detail.role === 'assistant' ? 'Assistant' : 'Tool'}
                                  </div>
                                  <pre className="whitespace-pre-wrap">{toolPreview.content}</pre>
                                  {detail.role === 'tool' && toolPreview.truncated && (
                                    <div className="mt-1 text-[11px] text-gray-500">
                                      [truncated to 1000 chars or 20 lines]
                                    </div>
                                  )}
                                </div>
                              )
                            })()
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              ))}

              {currentPending && (
                <div className="mb-4 text-left">
                  <div className="inline-block max-w-2xl rounded-lg bg-gray-200 px-4 py-3 text-gray-700">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-gray-400"
                          style={{ animationDelay: '0ms' }}
                        />
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-gray-400"
                          style={{ animationDelay: '150ms' }}
                        />
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-gray-400"
                          style={{ animationDelay: '300ms' }}
                        />
                      </div>
                      <span className="text-sm">Running...</span>
                    </div>
                    <details className="mt-2 rounded border border-gray-300 bg-white/50 p-2 text-left text-xs">
                      <summary className="cursor-pointer text-gray-700">
                        In progress steps ({pendingTurnDetails.length})
                      </summary>
                      <div className="mt-2 space-y-2">
                        {pendingTurnDetails.length === 0 && (
                          <div className="rounded bg-gray-100 p-2 text-gray-600">
                            Waiting for the first intermediate step...
                          </div>
                        )}
                        {pendingTurnDetails.map((detail, idx) => {
                          const preview = truncateLiveStepPreview(detail.content)
                          const stepTitle =
                            detail.role === 'assistant' ? 'Assistant step' : 'Tool step'

                          return (
                            <details
                              key={`pending-step-${idx}`}
                              className="rounded bg-gray-100 p-2 text-gray-700"
                            >
                              <summary className="cursor-pointer font-medium text-gray-700">
                                {stepTitle} {idx + 1}: {summarizeStep(preview.content)}
                              </summary>
                              <pre className="mt-1 whitespace-pre-wrap">{preview.content}</pre>
                              {preview.truncated && (
                                <div className="mt-1 text-[11px] text-gray-500">
                                  [truncated to 360 chars or 6 lines]
                                </div>
                              )}
                            </details>
                          )
                        })}
                      </div>
                    </details>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="border-t p-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowFileManager(true)}
                  className="rounded-lg border border-gray-300 px-3 py-2 hover:bg-gray-100"
                  title="Files"
                >
                  Files
                </button>
                <div className="relative flex-1">
                  <input
                    ref={messageInputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (shouldShowSkillPicker && slashOptions.length > 0 && e.key === 'ArrowDown') {
                        e.preventDefault()
                        setHighlightedSkillIndex((prev) => (prev + 1) % slashOptions.length)
                        return
                      }
                      if (shouldShowSkillPicker && slashOptions.length > 0 && e.key === 'ArrowUp') {
                        e.preventDefault()
                        setHighlightedSkillIndex((prev) => (prev - 1 + slashOptions.length) % slashOptions.length)
                        return
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        if (shouldShowSkillPicker && slashOptions.length > 0) {
                          const safeIndex = Math.min(Math.max(highlightedSkillIndex, 0), slashOptions.length - 1)
                          void handleSelectSlashOption(slashOptions[safeIndex])
                          return
                        }
                        void handleSend()
                      }
                    }}
                    placeholder="Type a message..."
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                    disabled={currentPending || Boolean(pendingPermission)}
                  />
                  {shouldShowSkillPicker && (
                    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                      {skillCatalogLoading && (
                        <div className="px-3 py-2 text-sm text-gray-500">Loading skills...</div>
                      )}
                      {!skillCatalogLoading && skillCatalogError && (
                        <div className="px-3 py-2 text-sm text-red-600">
                          <div>{skillCatalogError}</div>
                          <button
                            type="button"
                            onClick={handleRetrySkillCatalog}
                            className="mt-1 rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {!skillCatalogLoading && slashOptions.length === 0 && !skillCatalogError && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching entries.</div>
                      )}
                      {slashOptions.length > 0 && (
                        <div
                          className="max-h-56 overflow-y-auto overscroll-contain py-1"
                          onWheel={(e) => e.stopPropagation()}
                        >
                          {slashOptions.map((option, idx) => (
                            <button
                              key={option.id}
                              type="button"
                              ref={(element) => {
                                skillOptionRefs.current[idx] = element
                              }}
                              onMouseEnter={() => setHighlightedSkillIndex(idx)}
                              onMouseDown={(e) => {
                                e.preventDefault()
                                void handleSelectSlashOption(option)
                              }}
                              className={`block w-full px-3 py-2 text-left text-sm ${
                                highlightedSkillIndex === idx
                                  ? 'bg-blue-50 text-blue-700'
                                  : 'text-gray-700 hover:bg-gray-100'
                              }`}
                            >
                              {option.type === 'permission' ? `[Permission] ${option.label}` : option.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (pendingPermission) return
                    if (currentPending) {
                      void handleInterrupt()
                      return
                    }
                    void handleSend()
                  }}
                  disabled={currentPending ? false : !input.trim() || Boolean(pendingPermission)}
                  className={`rounded-lg px-6 py-2 text-white ${
                    currentPending
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400'
                  }`}
                >
                  {currentPending ? 'Interrupt' : 'Send'}
                </button>
              </div>
              {permissionMessage && (
                <div className="mt-2 text-sm text-gray-600">{permissionMessage}</div>
              )}
            </div>
          </>
        )}
      </div>

      {pendingPermission && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-lg bg-white p-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Permission Request</h3>
            <div className="mt-3 space-y-2 text-sm text-gray-700">
              <div>
                <span className="font-semibold">Tool:</span> {pendingPermission.tool}
              </div>
              <div>
                <span className="font-semibold">Arguments:</span>
                <pre className="mt-1 max-h-36 overflow-auto rounded bg-gray-100 p-2 text-xs">
                  {JSON.stringify(pendingPermission.args || {}, null, 2)}
                </pre>
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium text-gray-700">Retry note (optional)</label>
              <input
                type="text"
                value={permissionNote}
                onChange={(e) => setPermissionNote(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="Add extra instruction and retry"
              />
            </div>

            {permissionMessage && (
              <div className="mt-2 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">
                {permissionMessage}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                disabled={permissionSubmitting}
                onClick={() => void handlePermissionDecision('allow_once')}
                className="rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:bg-gray-400"
              >
                Allow once
              </button>
              <button
                disabled={permissionSubmitting}
                onClick={() => void handlePermissionDecision('allow_session')}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:bg-gray-400"
              >
                Allow this session
              </button>
              <button
                disabled={permissionSubmitting}
                onClick={() => void handlePermissionDecision('deny')}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:bg-gray-400"
              >
                Deny
              </button>
              <button
                disabled={permissionSubmitting}
                onClick={() => void handlePermissionDecision('retry_with_context')}
                className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-800 disabled:bg-gray-400"
              >
                Retry with note
              </button>
              <button
                disabled={permissionSubmitting}
                onClick={() => void handlePermissionDecision('switch_auto')}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:bg-gray-100"
              >
                Auto mode
              </button>
            </div>
          </div>
        </div>
      )}

      <FileManager
        isOpen={showFileManager}
        onClose={() => setShowFileManager(false)}
        sessionId={currentSessionId}
        projectId={currentProjectId}
      />
    </div>
  )
}




