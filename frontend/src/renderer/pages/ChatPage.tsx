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

interface PendingDeleteAction {
  type: 'session' | 'project'
  id: string
  title: string
  message: string
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

const GLOBAL_DRAFT_KEY = '__global__'

function draftKeyForSession(sessionId: string | null): string {
  return sessionId ? `session:${sessionId}` : GLOBAL_DRAFT_KEY
}

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
      turn = {
        userContent: '',
        finalAssistant: '',
        finalAssistantRaw: '',
        details: [],
        isOpen: true,
      }
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

      const reasoningBlocks = Array.isArray(msg.reasoning_blocks) ? msg.reasoning_blocks : []
      reasoningBlocks.forEach((block) => {
        const text = (block?.content || '').trim()
        if (!text) return
        activeTurn.details.push({
          role: 'assistant',
          content: text,
        })
      })

      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
      const protocolFlags = Array.isArray(msg.protocol_flags) ? msg.protocol_flags : []
      const assistantText = (visible || raw || '').trim()
      const isFakeToolCall = protocolFlags.includes('fake_textual_tool_call')
      if (hasToolCalls) {
        if (assistantText) {
          activeTurn.details.push({
            role: 'assistant',
            content: assistantText,
          })
        }
      } else if (isFakeToolCall) {
        if (assistantText) {
          activeTurn.details.push({
            role: 'assistant',
            content: assistantText,
          })
        }
        activeTurn.details.push({
          role: 'assistant',
          content: '[warning] Provider returned a textual tool call; no real tool execution was recorded.',
        })
        activeTurn.finalAssistant =
          'Provider returned a textual tool call. Open intermediate steps to inspect the raw response.'
        activeTurn.finalAssistantRaw = (raw || '').trim() || assistantText
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
    if ((turn.userContent || '').trim()) {
      rendered.push({
        key: `u-${index}`,
        role: 'user',
        content: turn.userContent,
        details: [],
      })
    }

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
  const [showComposerToolsMenu, setShowComposerToolsMenu] = useState(false)
  const [showComposerTooltip, setShowComposerTooltip] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [panelMode, setPanelMode] = useState<'chat' | 'guide' | 'config'>('chat')
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [input, setInput] = useState('')
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({})
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
  const [pendingDeleteAction, setPendingDeleteAction] = useState<PendingDeleteAction | null>(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [permissionNote, setPermissionNote] = useState('')
  const [permissionSubmitting, setPermissionSubmitting] = useState(false)
  const [permissionMessage, setPermissionMessage] = useState('')
  const [settingsForm, setSettingsForm] = useState<SettingsUpdate>({
    llm_provider: 'openai',
    llm_base_url: '',
    llm_api_key: '',
    llm_model_name: '',
  })
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [assistantViewModes, setAssistantViewModes] = useState<Record<string, AssistantViewMode>>({})
  const [composerExpanded, setComposerExpanded] = useState(false)

  const activeSessionIdRef = useRef<string | null>(null)
  const inFlightSessionsRef = useRef<Set<string>>(new Set())
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
  const requestEpochRef = useRef<Map<string, number>>(new Map())
  const pendingSinceRef = useRef<Map<string, number>>(new Map())
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageInputRef = useRef<HTMLTextAreaElement>(null)
  const skillOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const composerToolsRef = useRef<HTMLDivElement>(null)
  const pendingComposerSelectionRef = useRef<number | null>(null)

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

  const getDraft = (sessionId: string | null) => sessionDrafts[draftKeyForSession(sessionId)] || ''

  const setDraft = (sessionId: string | null, value: string) => {
    const key = draftKeyForSession(sessionId)
    setSessionDrafts((prev) => {
      if ((prev[key] || '') === value) return prev
      return { ...prev, [key]: value }
    })
  }

  const clearSessionDraft = (sessionId: string | null) => {
    const key = draftKeyForSession(sessionId)
    setSessionDrafts((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const focusComposerSoon = () => {
    window.setTimeout(() => {
      messageInputRef.current?.focus()
      window.requestAnimationFrame(() => {
        messageInputRef.current?.focus()
      })
    }, 0)
  }

  const applyPendingComposerSelection = () => {
    const selection = pendingComposerSelectionRef.current
    if (selection === null) return
    const inputEl = messageInputRef.current
    if (!inputEl) return
    inputEl.focus()
    inputEl.setSelectionRange(selection, selection)
    pendingComposerSelectionRef.current = null
  }

  const prependToInput = (prefix: string) => {
    const normalizedPrefix = prefix.trim()
    if (!normalizedPrefix) return

    const currentValue = input || ''
    if (
      currentValue === normalizedPrefix ||
      currentValue.startsWith(`${normalizedPrefix}\n`)
    ) {
      pendingComposerSelectionRef.current = normalizedPrefix.length + 1
      focusComposerSoon()
      window.requestAnimationFrame(applyPendingComposerSelection)
      return
    }

    const remainder = currentValue.trim() ? `\n${currentValue}` : '\n'
    const nextValue = `${normalizedPrefix}${remainder}`
    pendingComposerSelectionRef.current = normalizedPrefix.length + 1
    setInput(nextValue)
    setDraft(currentSessionId, nextValue)
    focusComposerSoon()
    window.requestAnimationFrame(() => {
      syncComposerHeight()
      applyPendingComposerSelection()
    })
  }

  const closeComposerTools = () => {
    setShowComposerToolsMenu(false)
    setShowComposerTooltip(false)
  }

  const handleOpenComposerTools = () => {
    setShowComposerTooltip(false)
    setShowComposerToolsMenu((prev) => !prev)
  }

  const handleSelectAddFiles = () => {
    closeComposerTools()
    setShowFileManager(true)
  }

  const handleSelectTaskMode = () => {
    closeComposerTools()
    prependToInput('use skill: planwithfiles')
  }

  const handleSelectSetAgentsMenu = () => {
    closeComposerTools()
    prependToInput(
      '\u5728input\u76ee\u5f55\uff0c\u521b\u5efaAGENTS.md\u6587\u6863\uff08\u5fc5\u987b\u5927\u5199\uff09\uff0c\u5185\u5bb9\u5982\u4e0b\uff1a',
    )
  }


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

    const source = Array.isArray(skillCatalog) && skillCatalog.length > 0
      ? skillCatalog
      : FALLBACK_SKILLS

    const normalized = Array.from(
      new Set(
        source
          .map((name) => String(name || '').trim())
          .filter(Boolean),
      ),
    )

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
    setInput(getDraft(currentSessionId))
  }, [currentSessionId])

  useEffect(() => {
    if (panelMode !== 'chat') return
    if (currentPending) return
    if (pendingPermission) return
    if (pendingDeleteAction) return
    if (editingSessionId) return
    if (showNewProject) return
    focusComposerSoon()
  }, [
    panelMode,
    currentSessionId,
    currentPending,
    pendingPermission,
    pendingDeleteAction,
    editingSessionId,
    showNewProject,
  ])

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
    if (!currentSessionId || !currentPending) return
    const controller = abortControllersRef.current.get(currentSessionId)
    if (controller) return

    // Recover from stale UI state: pending flag left behind without an active request.
    clearSessionRuntimeState(currentSessionId, false)
    void loadSessionMessages(currentSessionId).catch(() => {})
    void loadSessions().catch(() => {})
  }, [currentSessionId, currentPending, loadSessionMessages, loadSessions])

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
    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (composerToolsRef.current?.contains(target)) return
      closeComposerTools()
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeComposerTools()
      }
    }

    document.addEventListener('mousedown', onDocumentMouseDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [])

  useEffect(() => {
    closeComposerTools()
  }, [panelMode, currentSessionId])

  useEffect(() => {
    if (!shouldShowSkillPicker || skillCatalogReady) return

    let canceled = false
    const hardTimeoutId = window.setTimeout(() => {
      if (canceled) return
      setSkillCatalog((prev) => (Array.isArray(prev) && prev.length > 0 ? prev : FALLBACK_SKILLS))
      setSkillCatalogError('Skill catalog request timed out (showing default skills)')
      setSkillCatalogReady(true)
      setSkillCatalogLoading(false)
    }, 4000)

    const load = async () => {
      setSkillCatalogLoading(true)
      setSkillCatalogError('')
      try {
        const data = await getSkillCatalog()
        if (canceled) return
        const normalized = Array.isArray(data.skills)
          ? data.skills.map((name) => String(name || '').trim()).filter(Boolean)
          : []
        if (normalized.length > 0) {
          setSkillCatalog(normalized)
        } else {
          setSkillCatalog(FALLBACK_SKILLS)
          setSkillCatalogError('No skills discovered from backend (showing default skills)')
        }
      } catch (error: any) {
        if (canceled) return
        setSkillCatalog(FALLBACK_SKILLS)
        setSkillCatalogError((error?.message || 'Failed to load skills') + ' (showing default skills)')
      } finally {
        window.clearTimeout(hardTimeoutId)
        if (!canceled) {
          setSkillCatalogReady(true)
          setSkillCatalogLoading(false)
        }
      }
    }

    void load()
    return () => {
      canceled = true
      window.clearTimeout(hardTimeoutId)
    }
  }, [shouldShowSkillPicker, skillCatalogReady])

  const syncComposerHeight = () => {
    const el = messageInputRef.current
    if (!el) return

    if (composerExpanded) {
      const expandedHeight = Math.max(280, Math.floor(window.innerHeight * 0.5))
      el.style.height = `${expandedHeight}px`
      el.style.overflowY = 'auto'
      return
    }

    const styles = window.getComputedStyle(el)
    const lineHeight = Number.parseFloat(styles.lineHeight) || 24
    const paddingY = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0)
    const borderY = (Number.parseFloat(styles.borderTopWidth) || 0) + (Number.parseFloat(styles.borderBottomWidth) || 0)
    const maxRows = 5
    const singleLineHeight = 48
    const maxHeight = lineHeight * maxRows + paddingY + borderY

    el.style.height = 'auto'
    const nextHeight = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${Math.max(singleLineHeight, nextHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }

  useEffect(() => {
    syncComposerHeight()
  }, [input, composerExpanded, currentSessionId, panelMode])

  useEffect(() => {
    const handleResize = () => syncComposerHeight()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [composerExpanded, input])
  const markPending = (sessionId: string, pending: boolean) => {
    if (pending) {
      inFlightSessionsRef.current.add(sessionId)
      pendingSinceRef.current.set(sessionId, Date.now())
    } else {
      inFlightSessionsRef.current.delete(sessionId)
      pendingSinceRef.current.delete(sessionId)
    }

    setPendingSessions((prev) => {
      const next = new Set(prev)
      if (pending) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }
  const clearSessionRuntimeState = (sessionId: string | null | undefined, abort = false) => {
    if (!sessionId) return

    requestEpochRef.current.set(sessionId, (requestEpochRef.current.get(sessionId) || 0) + 1)

    if (abort) {
      const controller = abortControllersRef.current.get(sessionId)
      if (controller) {
        controller.abort()
      }
    }
    abortControllersRef.current.delete(sessionId)
    inFlightSessionsRef.current.delete(sessionId)
    pendingSinceRef.current.delete(sessionId)
    setPendingSessions((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }
  const nextRequestEpoch = (sessionId: string): number => {
    const next = (requestEpochRef.current.get(sessionId) || 0) + 1
    requestEpochRef.current.set(sessionId, next)
    return next
  }

  const isRequestCurrent = (sessionId: string, epoch: number): boolean => {
    return (requestEpochRef.current.get(sessionId) || 0) === epoch
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
    const epoch = nextRequestEpoch(sessionId)
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
      if (abortControllersRef.current.get(sessionId) === controller) {
        abortControllersRef.current.delete(sessionId)
      }
      if (!isRequestCurrent(sessionId, epoch)) {
        return
      }

      markPending(sessionId, false)
      if (wasCanceled) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      await loadSessionMessages(sessionId).catch(() => {})
      await loadSessions().catch(() => {})
      window.setTimeout(() => {
        if (!isRequestCurrent(sessionId, epoch)) return
        void loadSessions().catch(() => {})
      }, 1200)
    }
  }

  const handleSend = async () => {
    if (!input.trim()) return

    const sourceSessionId = currentSessionId
    let sessionId = currentSessionId
    if (!sessionId) {
      const created = await createSession(currentProjectId || null)
      sessionId = created.id
      activeSessionIdRef.current = sessionId
    }

    if (inFlightSessionsRef.current.has(sessionId)) {
      const activeController = abortControllersRef.current.get(sessionId)
      const hasPendingFlag = pendingSessions.has(sessionId)
      const stale = !activeController || activeController.signal.aborted
      if (stale && !hasPendingFlag) {
        clearSessionRuntimeState(sessionId, false)
      } else {
        return
      }
    }

    const message = input.trim()
    setDraft(sourceSessionId, '')
    if (sessionId !== sourceSessionId) {
      setDraft(sessionId, '')
    }
    setInput('')
    activeSessionIdRef.current = sessionId
    setShouldAutoScroll(true)

    addOptimisticMessage({ role: 'user', content: message })

    const epoch = nextRequestEpoch(sessionId)
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
      if (abortControllersRef.current.get(sessionId) === controller) {
        abortControllersRef.current.delete(sessionId)
      }
      if (!isRequestCurrent(sessionId, epoch)) {
        return
      }

      markPending(sessionId, false)
      if (wasCanceled) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      await loadSessionMessages(sessionId).catch(() => {})
      await loadSessions().catch(() => {})
      window.setTimeout(() => {
        if (!isRequestCurrent(sessionId, epoch)) return
        void loadSessions().catch(() => {})
      }, 1500)
    }
  }

  const handleInterrupt = async () => {
    const sessionId = currentSessionId
    if (!sessionId || !pendingSessions.has(sessionId)) return

    // Invalidate current request epoch first so stale finally callbacks
    // cannot overwrite optimistic messages from the next send.
    nextRequestEpoch(sessionId)

    // Release pending state immediately so the follow-up user input can be sent
    // right after interrupt and be persisted as the next round context.
    markPending(sessionId, false)
    pendingSinceRef.current.delete(sessionId)

    const controller = abortControllersRef.current.get(sessionId)
    if (controller) {
      controller.abort()
      abortControllersRef.current.delete(sessionId)
    }

    try {
      await interruptSession(sessionId)
    } catch (error) {
      console.error('Interrupt request failed:', error)
    }

    await loadSessionMessages(sessionId).catch(() => {})
    await loadSessions().catch(() => {})
    window.setTimeout(() => {
      if (activeSessionIdRef.current !== sessionId) return
      void loadSessionMessages(sessionId).catch(() => {})
      void loadSessions().catch(() => {})
    }, 1200)
    focusComposerSoon()
  }

  const handleNewChat = async () => {
    try {
      const created = await createSession(currentProjectId || null)
      clearSessionDraft(created.id)
      await setCurrentSession(created.id)
      activeSessionIdRef.current = created.id
      focusComposerSoon()
    } catch (error) {
      console.error('Failed to create chat:', error)
    }
  }

  const handleNewProjectChat = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    try {
      setCurrentProject(projectId)
      const created = await createSession(projectId)
      clearSessionDraft(created.id)
      await setCurrentSession(created.id)
      activeSessionIdRef.current = created.id
      focusComposerSoon()
    } catch (error) {
      console.error('Failed to create project chat:', error)
    }
  }

  const handleSelectProject = (projectId: string | null) => {
    setCurrentProject(projectId)
    clearCurrentSession()
    activeSessionIdRef.current = null
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
    focusComposerSoon()
  }

  const commitSessionRename = async (sessionId: string, originalTitle: string) => {
    const nextTitle = editingSessionTitle.trim()
    setEditingSessionId(null)
    setEditingSessionTitle('')
    if (!nextTitle || nextTitle === (originalTitle || '')) return
    await updateSessionTitle(sessionId, nextTitle)
  }

  const requestDeleteSession = (sessionId: string) => {
    setOpenSessionMenuId(null)
    const session = sessions.find((item) => item.id === sessionId)
    setPendingDeleteAction({
      type: 'session',
      id: sessionId,
      title: 'Delete chat?',
      message: `Delete "${session?.title || 'New chat'}"? This action cannot be undone.`,
    })
  }

  const performDeleteSession = async (sessionId: string) => {
    clearSessionRuntimeState(sessionId, true)
    clearSessionDraft(sessionId)
    setPendingPermission((prev) => (prev?.sessionId === sessionId ? null : prev))
    await deleteSession(sessionId)
    if (activeSessionIdRef.current === sessionId) {
      clearCurrentSession()
      activeSessionIdRef.current = null
    }
  }

  const requestDeleteProject = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation()
    const project = projects.find((item) => item.id === projectId)
    setPendingDeleteAction({
      type: 'project',
      id: projectId,
      title: 'Delete project?',
      message: `Delete project "${project?.name || projectId}" and all its chats/files? This action cannot be undone.`,
    })
  }

  const performDeleteProject = async (projectId: string) => {
    await deleteProject(projectId)

    if (currentProjectId === projectId) {
      setCurrentProject(null)
      clearCurrentSession()
      activeSessionIdRef.current = null
    }
  }

  const handleConfirmDelete = async () => {
    if (!pendingDeleteAction || deleteSubmitting) return
    setDeleteSubmitting(true)
    try {
      if (pendingDeleteAction.type === 'session') {
        await performDeleteSession(pendingDeleteAction.id)
      } else {
        await performDeleteProject(pendingDeleteAction.id)
      }
      setPendingDeleteAction(null)
    } catch (error) {
      console.error('Delete failed:', error)
    } finally {
      setDeleteSubmitting(false)
      focusComposerSoon()
    }
  }

  const handleCancelDelete = () => {
    if (deleteSubmitting) return
    setPendingDeleteAction(null)
    focusComposerSoon()
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
        llm_provider: data.llm_provider || 'openai',
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
        llm_provider: data.llm_provider || prev.llm_provider || 'openai',
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
    const nextInput = `use skill: [${normalizedName}] `
    setInput(nextInput)
    setDraft(currentSessionId, nextInput)
    focusComposerSoon()
  }

  const handleSelectPermissionMode = async (mode: 'ask' | 'auto') => {
    setInput('')
    setDraft(currentSessionId, '')
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
      focusComposerSoon()
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
    <div className="flex h-screen bg-[var(--app-surface)] text-[var(--app-text)]">
      <div className="flex w-64 flex-col border-r border-[var(--app-border)] bg-[var(--app-sidebar)] text-[var(--app-sidebar-text)]">
        <div className="p-3">
          <button
            onClick={() => void handleNewChat()}
            className="w-full rounded-xl border border-white/10 bg-[var(--app-sidebar-hover)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--app-sidebar-active)]"
          >
            + New Chat
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => setShowProjects(!showProjects)}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors hover:bg-[var(--app-sidebar-hover)]"
          >
            <span>Projects</span>
            <span className="text-[var(--app-sidebar-text-muted)]">{showProjects ? 'v' : '>'}</span>
          </button>

          {showProjects && (
            <div className="mt-1 space-y-1 pl-2">
              <div
                onClick={() => handleSelectProject(null)}
                className={`cursor-pointer rounded-xl px-3 py-2 text-sm transition-colors hover:bg-[var(--app-sidebar-hover)] ${
                  !currentProjectId ? 'bg-[var(--app-sidebar-active)]' : ''
                }`}
              >
                Your Chats
              </div>

              {Array.isArray(projects) &&
                projects.map((project) => (
                  <div key={project.id}>
                    <div
                      onClick={() => handleSelectProject(project.id)}
                      className={`group flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors hover:bg-[var(--app-sidebar-hover)] ${
                        currentProjectId === project.id ? 'bg-[var(--app-sidebar-active)]' : ''
                      }`}
                    >
                      <span className="truncate">[P] {project.name}</span>
                      <div className="ml-1 flex flex-shrink-0 items-center gap-2">
                        <button
                          onClick={(e) => void handleNewProjectChat(e, project.id)}
                          className="text-[var(--app-sidebar-text-muted)] transition-colors hover:text-[var(--app-sidebar-text)]"
                          title="New chat in this project"
                        >
                          +
                        </button>
                        <button
                          onClick={(e) => requestDeleteProject(e, project.id)}
                          className="text-[var(--app-sidebar-text-muted)] transition-colors hover:text-red-300"
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
                    className="flex-1 rounded-lg border border-white/10 bg-[var(--app-sidebar-active)] px-2 py-1 text-sm text-[var(--app-sidebar-text)] placeholder:text-[var(--app-sidebar-text-muted)]"
                    autoFocus
                  />
                  <button
                    onClick={() => void handleCreateProject()}
                    className="rounded-lg bg-[var(--app-accent)] px-2 py-1 text-sm text-white transition-colors hover:bg-[var(--app-accent-hover)]"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewProject(true)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--app-sidebar-text-muted)] transition-colors hover:bg-[var(--app-sidebar-hover)]"
                >
                  <span>+</span> New Project
                </button>
              )}
            </div>
          )}
        </div>

        <div className="app-scrollbar flex-1 space-y-1 overflow-y-auto px-3 pt-3">
          {(currentProjectId ? projectSessions(currentProjectId) : nonProjectSessions).map((session) => (
            <div
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              className={`group relative cursor-pointer rounded-xl px-3 py-2 text-sm transition-colors ${
                currentSessionId === session.id ? 'bg-[var(--app-sidebar-active)]' : 'hover:bg-[var(--app-sidebar-hover)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                  {pendingSessions.has(session.id) && (
                    <span className="inline-block h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-emerald-300" />
                  )}
                  {Boolean(session.is_pinned) && (
                    <span className="rounded bg-white/10 px-1 text-[10px] text-[var(--app-sidebar-text)]">PIN</span>
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
                      className="min-w-0 flex-1 rounded bg-white/10 px-2 py-0.5 text-sm text-[var(--app-sidebar-text)] outline-none"
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
                    className={`rounded px-2 py-1 text-[var(--app-sidebar-text-muted)] transition-colors hover:bg-[var(--app-sidebar-active)] hover:text-[var(--app-sidebar-text)] ${
                      openSessionMenuId === session.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title="More"
                  >
                    ...
                  </button>
                  {openSessionMenuId === session.id && (
                    <div className="absolute right-0 top-8 z-10 w-32 rounded-xl border border-white/10 bg-[var(--app-sidebar-hover)] py-1 shadow-lg">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingSessionId(session.id)
                          setEditingSessionTitle(session.title || '')
                          setOpenSessionMenuId(null)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-[var(--app-sidebar-text)] hover:bg-[var(--app-sidebar-active)]"
                      >
                        Rename
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenSessionMenuId(null)
                          void toggleSessionPin(session.id, !Boolean(session.is_pinned))
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-[var(--app-sidebar-text)] hover:bg-[var(--app-sidebar-active)]"
                      >
                        {session.is_pinned ? 'Unpin' : 'Pin'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          requestDeleteSession(session.id)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-red-300 hover:bg-[var(--app-sidebar-active)]"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="text-xs text-[var(--app-sidebar-text-muted)]">{session.message_count} messages</div>
            </div>
          ))}
        </div>

        <div className="px-3 pb-3 pt-0">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => void handleOpenGuide()}
              className={`rounded-lg px-3 py-2 text-sm ${
                panelMode === 'guide'
                  ? 'bg-[var(--app-sidebar-active)] text-[var(--app-sidebar-text)]'
                  : 'bg-[var(--app-sidebar-hover)] text-[var(--app-sidebar-text-muted)] hover:bg-[var(--app-sidebar-active)] hover:text-[var(--app-sidebar-text)]'
              }`}
            >
              Guide
            </button>
            <button
              onClick={() => void handleOpenConfig()}
              className={`rounded-lg px-3 py-2 text-sm ${
                panelMode === 'config'
                  ? 'bg-[var(--app-sidebar-active)] text-[var(--app-sidebar-text)]'
                  : 'bg-[var(--app-sidebar-hover)] text-[var(--app-sidebar-text-muted)] hover:bg-[var(--app-sidebar-active)] hover:text-[var(--app-sidebar-text)]'
              }`}
            >
              Config
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col bg-[var(--app-surface)]">
        {panelMode === 'guide' && (
          <>
            <div className="flex items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-surface-elevated)] px-4 py-3">
              <h2 className="text-lg font-semibold">Application Guide</h2>
              <button
                onClick={() => setPanelMode('chat')}
                className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)]"
              >
                Back to Chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-[var(--app-surface)] p-4">
              {guideLoading && <div className="text-[var(--app-text-muted)]">Loading guide...</div>}
              {!guideLoading && guideError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {guideError}
                </div>
              )}
              {!guideLoading && !guideError && (
                <pre className="whitespace-pre-wrap rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4 text-sm text-[var(--app-text)] shadow-sm">
                  {guideText || 'No guide content available.'}
                </pre>
              )}
            </div>
          </>
        )}

        {panelMode === 'config' && (
          <>
            <div className="flex items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-surface-elevated)] px-4 py-3">
              <h2 className="text-lg font-semibold">API Configuration</h2>
              <button
                onClick={() => setPanelMode('chat')}
                className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)]"
              >
                Back to Chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-[var(--app-surface)] p-4">
              <form onSubmit={handleSaveConfig} className="mx-auto max-w-2xl space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-5 shadow-sm">
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">Provider</label>
                  <select
                    value={settingsForm.llm_provider || 'openai'}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        llm_provider: e.target.value as SettingsUpdate['llm_provider'],
                      })
                    }
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="minimax">MiniMax</option>
                    <option value="zhipu">Zhipu</option>
                    <option value="kimi">Kimi</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">Base URL</label>
                  <input
                    type="text"
                    value={settingsForm.llm_base_url || ''}
                    onChange={(e) => setSettingsForm({ ...settingsForm, llm_base_url: e.target.value })}
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">API Key</label>
                  <input
                    type="password"
                    value={settingsForm.llm_api_key || ''}
                    onChange={(e) => setSettingsForm({ ...settingsForm, llm_api_key: e.target.value })}
                    placeholder="Leave empty to keep unchanged"
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">Model Name</label>
                  <input
                    type="text"
                    value={settingsForm.llm_model_name || ''}
                    onChange={(e) => setSettingsForm({ ...settingsForm, llm_model_name: e.target.value })}
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                  />
                </div>
                {settingsSaved && (
                  <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                    Settings saved.
                  </div>
                )}
                <button
                  type="submit"
                  disabled={settingsLoading}
                  className="rounded-xl bg-[var(--app-accent)] px-4 py-2 text-white hover:bg-[var(--app-accent-hover)] disabled:bg-gray-400"
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
              className="app-scrollbar flex-1 overflow-y-auto p-4"
            >
              {renderMessages.map((msg) => (
                <div key={msg.key} className={`mb-4 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  <div
                    className={`inline-block max-w-2xl rounded-2xl px-4 py-2 text-left shadow-sm ${
                      msg.role === 'user'
                        ? 'bg-[var(--app-user-bubble)] text-[var(--app-user-bubble-text)]'
                        : 'bg-[var(--app-assistant-bubble)] text-[var(--app-assistant-bubble-text)]'
                    }`}
                  >
                                        {msg.role === 'assistant' && msg.rawContent && (
                      <div className="mb-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => toggleAssistantViewMode(msg.key)}
                          title={(assistantViewModes[msg.key] || 'rendered') === 'raw' ? 'Switch to rendered view' : 'Switch to raw view'}
                          className="rounded-full border border-black/8 bg-black/5 px-2 py-[2px] text-[11px] font-medium text-[var(--app-text-soft)] transition-colors hover:bg-black/8 hover:text-[var(--app-text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent-soft)]"
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
                      <div className="whitespace-pre-wrap break-words text-left" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{msg.content}</div>
                    )}
                    {msg.role === 'assistant' && msg.details.length > 0 && (
                      <details className="mt-2 rounded-xl border border-[var(--app-border)] bg-white/70 p-2 text-left text-xs">
                        <summary className="cursor-pointer text-[var(--app-text-muted)]">
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
                                  className="rounded-lg bg-[var(--app-surface-muted)] p-2 text-[var(--app-text)]"
                                >
                                  <div className="mb-1 font-semibold text-[var(--app-text-muted)]">
                                    {detail.role === 'assistant' ? 'Assistant' : 'Tool'}
                                  </div>
                                  <pre className="whitespace-pre-wrap">{toolPreview.content}</pre>
                                  {detail.role === 'tool' && toolPreview.truncated && (
                                      <div className="mt-1 text-[11px] text-[var(--app-text-soft)]">
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

              {!currentPending && renderMessages.length === 0 && (
                <div className="mb-4 text-left">
                  <div className="inline-block max-w-2xl rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-surface-muted)] px-4 py-3 text-sm text-[var(--app-text-muted)]">
                    This chat is empty. Type a message to start.
                  </div>
                </div>
              )}

              {currentPending && (
                <div className="mb-4 text-left">
                  <div className="inline-block max-w-2xl rounded-xl bg-[var(--app-assistant-bubble)] px-4 py-3 text-[var(--app-assistant-bubble-text)]">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-[var(--app-text-soft)]"
                          style={{ animationDelay: '0ms' }}
                        />
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-[var(--app-text-soft)]"
                          style={{ animationDelay: '150ms' }}
                        />
                        <span
                          className="inline-block h-2 w-2 animate-bounce rounded-full bg-[var(--app-text-soft)]"
                          style={{ animationDelay: '300ms' }}
                        />
                      </div>
                      <span className="text-sm">Running...</span>
                    </div>
                    <details className="mt-2 rounded-xl border border-[var(--app-border)] bg-white/70 p-2 text-left text-xs">
                      <summary className="cursor-pointer text-[var(--app-text-muted)]">
                        In progress steps ({pendingTurnDetails.length})
                      </summary>
                      <div className="mt-2 space-y-2">
                        {pendingTurnDetails.length === 0 && (
                          <div className="rounded-lg bg-[var(--app-surface-muted)] p-2 text-[var(--app-text-muted)]">
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
                              className="rounded-lg bg-[var(--app-surface-muted)] p-2 text-[var(--app-text)]"
                            >
                              <summary className="cursor-pointer font-medium text-[var(--app-text)]">
                                {stepTitle} {idx + 1}: {summarizeStep(preview.content)}
                              </summary>
                              <pre className="mt-1 whitespace-pre-wrap">{preview.content}</pre>
                              {preview.truncated && (
                                <div className="mt-1 text-[11px] text-[var(--app-text-soft)]">
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

            <div className="border-t border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4">
              <div className="flex items-end gap-2">
                <div
                  ref={composerToolsRef}
                  className="group relative h-12 w-12 flex-shrink-0 self-end"
                  onMouseEnter={() => {
                    if (!showComposerToolsMenu) setShowComposerTooltip(true)
                  }}
                  onMouseLeave={() => {
                    setShowComposerTooltip(false)
                  }}
                >
                  {showComposerTooltip && !showComposerToolsMenu && (
                    <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 whitespace-nowrap rounded-xl border border-white/10 bg-[#171b22] px-3 py-2 text-xs font-medium text-[#e8edf5] shadow-[0_16px_40px_rgba(0,0,0,0.38)]">
                      add files or more
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleOpenComposerTools}
                    className="absolute inset-0 z-10 flex items-center justify-center rounded-full text-[var(--app-text)] transition-colors hover:text-[var(--app-accent)]"
                    title="add files or more"
                    aria-label="Open tools menu"
                  >
                    <svg
                      className="block"
                      width="18"
                      height="18"
                      viewBox="0 0 18 18"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <path d="M9 3.25V14.75" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      <path d="M3.25 9H14.75" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                    </svg>
                  </button>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute left-1/2 top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--app-accent-soft)] opacity-0 transition duration-200 ${
                      showComposerToolsMenu ? 'opacity-100' : 'group-hover:opacity-100'
                    }`}
                  />

                  {showComposerToolsMenu && (
                    <div className="absolute bottom-full left-0 z-40 mb-3 w-60 overflow-hidden rounded-2xl border border-white/10 bg-[#171b22]/95 p-2 text-sm text-[#e8edf5] shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur">
                      <div className="mb-2 px-2 pt-1 text-[11px] uppercase tracking-[0.22em] text-[#8a95a8]">
                        quick actions
                      </div>
                      <button
                        type="button"
                        onClick={handleSelectAddFiles}
                        className="flex w-full items-center rounded-xl px-3 py-3 text-left text-sm text-[#f5f7fb] transition hover:bg-white/8"
                      >
                        add files/folders
                      </button>
                      <button
                        type="button"
                        onClick={handleSelectTaskMode}
                        className="mt-1 flex w-full items-center rounded-xl px-3 py-3 text-left text-sm text-[#f5f7fb] transition hover:bg-white/8"
                      >
                        task mode
                      </button>
                      <button
                        type="button"
                        onClick={handleSelectSetAgentsMenu}
                        className="mt-1 flex w-full items-center rounded-xl px-3 py-3 text-left text-sm text-[#f5f7fb] transition hover:bg-white/8"
                      >
                        set AGENTS.md
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative flex-1 self-end">
                  <textarea
                    ref={messageInputRef}
                    rows={1}
                    value={input}
                    onChange={(e) => {
                      const nextValue = e.target.value
                      setInput(nextValue)
                      setDraft(currentSessionId, nextValue)
                      window.requestAnimationFrame(syncComposerHeight)
                    }}
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
                    className="block h-12 min-h-12 w-full resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] px-4 py-[11px] pr-10 leading-6 text-[var(--app-text)] whitespace-pre-wrap break-words focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                    disabled={Boolean(pendingPermission)} style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                  />
                  <button
                    type="button"
                    onClick={() => setComposerExpanded((prev) => !prev)}
                    className="absolute bottom-2 right-2 rounded border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-1 text-[var(--app-text-muted)] hover:bg-[var(--app-surface-muted)]"
                    title={composerExpanded ? 'Collapse input' : 'Expand input'}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3 5V3H5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M11 9V11H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M5 3L3 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                      <path d="M9 11L11 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                  </button>
                  {shouldShowSkillPicker && (
                    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] shadow-lg">
                      {skillCatalogLoading && (
                        <div className="px-3 py-2 text-sm text-[var(--app-text-muted)]">Loading skills...</div>
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
                        <div className="px-3 py-2 text-sm text-[var(--app-text-muted)]">No matching entries.</div>
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
                              onClick={() => {
                                void handleSelectSlashOption(option)
                              }}
                              className={`block w-full px-3 py-2 text-left text-sm ${
                                highlightedSkillIndex === idx
                                  ? 'bg-[var(--app-accent-soft)] text-[var(--app-accent)]'
                                  : 'text-[var(--app-text)] hover:bg-[var(--app-surface-muted)]'
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
                  className={`h-12 self-end rounded-xl px-6 text-white ${
                    currentPending
                      ? 'bg-red-700 hover:bg-red-800'
                      : 'bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:bg-gray-400'
                  }`}
                >
                  {currentPending ? 'Interrupt' : 'Send'}
                </button>
              </div>
              {permissionMessage && (
                <div className="mt-2 text-sm text-[var(--app-text-muted)]">{permissionMessage}</div>
              )}
            </div>
          </>
        )}
      </div>

      {pendingDeleteAction && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--app-overlay)] p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">{pendingDeleteAction.title}</h3>
            <p className="mt-3 text-sm text-gray-700">{pendingDeleteAction.message}</p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                disabled={deleteSubmitting}
                onClick={handleCancelDelete}
                className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)] disabled:bg-gray-100"
              >
                Cancel
              </button>
              <button
                disabled={deleteSubmitting}
                onClick={() => void handleConfirmDelete()}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:bg-gray-400"
              >
                {deleteSubmitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingPermission && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--app-overlay)] p-4">
          <div className="w-full max-w-xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Permission Request</h3>
            <div className="mt-3 space-y-2 text-sm text-gray-700">
              <div>
                <span className="font-semibold">Tool:</span> {pendingPermission.tool}
              </div>
              <div>
                <span className="font-semibold">Arguments:</span>
                <pre className="mt-1 max-h-36 overflow-auto rounded-xl bg-[var(--app-surface-muted)] p-2 text-xs">
                  {JSON.stringify(pendingPermission.args || {}, null, 2)}
                </pre>
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">Retry note (optional)</label>
              <input
                type="text"
                value={permissionNote}
                onChange={(e) => setPermissionNote(e.target.value)}
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                placeholder="Add extra instruction and retry"
              />
            </div>

            {permissionMessage && (
              <div className="mt-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-2 py-1 text-xs text-[var(--app-text-muted)]">
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
                className="rounded-xl bg-[var(--app-accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--app-accent-hover)] disabled:bg-gray-400"
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
                className="rounded-xl bg-[var(--app-sidebar)] px-3 py-1.5 text-sm text-white hover:bg-[var(--app-sidebar-hover)] disabled:bg-gray-400"
              >
                Retry with note
              </button>
              <button
                disabled={permissionSubmitting}
                onClick={() => void handlePermissionDecision('switch_auto')}
                className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-surface-muted)] disabled:bg-gray-100"
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





















