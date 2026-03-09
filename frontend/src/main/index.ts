import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import path from 'path'
import { shell } from 'electron'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { createServer } from 'net'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import {
  BACKEND_APP_ID,
  BACKEND_APP_ID_ENV_VAR,
  BACKEND_APP_VERSION_ENV_VAR,
  BACKEND_HOST_ENV_VAR,
  BACKEND_PORT_ENV_VAR,
  DEFAULT_BACKEND_HOST,
  DEFAULT_BACKEND_PORT,
  buildBackendRuntimeUrls,
} from '../shared/backendConfig'
import type { AppRuntimeStatus, AppStartupState } from '../shared/appRuntime'

let mainWindow: BrowserWindow | null = null
let pythonProcess: ChildProcess | null = null
let isAppQuitting = false
let backendStartupState: AppStartupState = 'starting'
let backendStartupFailureReason: string | null = null

const BACKEND_READY_TIMEOUT_MS = 30_000
const BACKEND_POLL_INTERVAL_MS = 500
const WINDOWS_DATA_ROOT = path.join('D:\\', 'PaimonData')
const MACOS_DATA_ROOT = path.join(app.getPath('home'), 'PaimonData')
const PYTHON_PROBE_TIMEOUT_MS = readPositiveIntEnv('SKILLS_MCP_PYTHON_PROBE_TIMEOUT_MS', 100_000)
const BACKEND_MAX_RETRIES = readPositiveIntEnv('SKILLS_MCP_BACKEND_MAX_RETRIES', 5)
const BACKEND_RETRY_BASE_MS = readPositiveIntEnv('SKILLS_MCP_BACKEND_RETRY_BASE_MS', 1_000)
const BACKEND_STARTUP_LOG_FILE = 'backend-startup.log'
const INTERCEPT_ERROR_CODES = new Set(['EPERM', 'EACCES', 'UNKNOWN'])

let backendStartupLogPath: string | null = null

type BackendLaunchChannel = 'direct' | 'cmd-wrapper'

interface BackendRuntimeInfo {
  host: string
  port: number
  origin: string
  apiBaseUrl: string
  healthUrl: string
  appId: string
  appVersion: string
}

interface BackendHealthPayload {
  status?: string
  app_id?: string
  app_version?: string
}

let backendRuntimeInfo: BackendRuntimeInfo = {
  host: DEFAULT_BACKEND_HOST,
  port: DEFAULT_BACKEND_PORT,
  ...buildBackendRuntimeUrls(DEFAULT_BACKEND_HOST, DEFAULT_BACKEND_PORT),
  appId: BACKEND_APP_ID,
  appVersion: 'unknown',
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getBackendStartupLogPath(): string {
  if (backendStartupLogPath) {
    return backendStartupLogPath
  }
  const logsDir = app.getPath('logs')
  ensureDir(logsDir)
  backendStartupLogPath = path.join(logsDir, BACKEND_STARTUP_LOG_FILE)
  return backendStartupLogPath
}

function logBackendStartup(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
  try {
    appendFileSync(getBackendStartupLogPath(), `${line}\n`, 'utf-8')
  } catch (error) {
    console.error(`[Backend Startup Log] Failed to write log file: ${String(error)}`)
  }
}

function setBackendStartupStatus(state: AppStartupState, reason: string | null = null): void {
  backendStartupState = state
  backendStartupFailureReason = reason
}

function createBackendRuntimeInfo(host: string, port: number): BackendRuntimeInfo {
  return {
    host,
    port,
    ...buildBackendRuntimeUrls(host, port),
    appId: BACKEND_APP_ID,
    appVersion: app.getVersion(),
  }
}

function getRuntimeStatusSnapshot(): AppRuntimeStatus {
  return {
    backendOrigin: backendRuntimeInfo.origin,
    backendApiBaseUrl: backendRuntimeInfo.apiBaseUrl,
    backendHealthUrl: backendRuntimeInfo.healthUrl,
    startupState: backendStartupState,
    startupFailureReason: backendStartupFailureReason,
    logPath: getBackendStartupLogPath(),
  }
}

function reserveLoopbackPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve backend port.')))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function allocateBackendRuntimeInfo(host: string): Promise<BackendRuntimeInfo> {
  const port = await reserveLoopbackPort(host)
  return createBackendRuntimeInfo(host, port)
}

function isExpectedBackendHealth(
  payload: BackendHealthPayload,
  runtimeInfo: BackendRuntimeInfo,
): boolean {
  return (
    payload.status === 'ok' &&
    payload.app_id === runtimeInfo.appId &&
    payload.app_version === runtimeInfo.appVersion
  )
}

function resolveWindowsDataRoot(): string {
  const override = (process.env.SKILLS_MCP_DATA_ROOT || '').trim()
  const candidate = override || WINDOWS_DATA_ROOT
  const normalized = path.resolve(candidate)

  if (/^[A-Za-z]:/.test(normalized) && normalized.slice(0, 2).toUpperCase() !== 'D:') {
    console.warn(`[Windows Data Root] Reject non-D drive path override: ${candidate}`)
    ensureDir(WINDOWS_DATA_ROOT)
    return WINDOWS_DATA_ROOT
  }

  ensureDir(normalized)
  return normalized
}

function resolveMacDataRoot(): string {
  const override = (process.env.SKILLS_MCP_DATA_ROOT || '').trim()
  const candidate = override || MACOS_DATA_ROOT
  const normalized = path.resolve(candidate)
  const allowedRoot = path.resolve(MACOS_DATA_ROOT)
  const allowedPrefix = `${allowedRoot}${path.sep}`

  if (normalized !== allowedRoot && !normalized.startsWith(allowedPrefix)) {
    console.warn(`[macOS Data Root] Reject override outside ~/PaimonData: ${candidate}`)
    ensureDir(allowedRoot)
    return allowedRoot
  }

  ensureDir(normalized)
  return normalized
}

function configureAppPathsForDataRoot(dataRoot: string): void {
  const appDataDir = path.join(dataRoot, 'electron', 'appData')
  const userDataDir = path.join(dataRoot, 'electron', 'userData')
  const sessionDataDir = path.join(dataRoot, 'electron', 'sessionData')
  const cacheDir = path.join(dataRoot, 'electron', 'cache')
  const logsDir = path.join(dataRoot, 'electron', 'logs')
  const tempDir = path.join(dataRoot, 'tmp')
  const crashDumpsDir = path.join(dataRoot, 'electron', 'crashDumps')

  for (const dir of [appDataDir, userDataDir, sessionDataDir, cacheDir, logsDir, tempDir, crashDumpsDir]) {
    ensureDir(dir)
  }

  app.setPath('appData', appDataDir)
  app.setPath('userData', userDataDir)
  app.setPath('sessionData', sessionDataDir)
  app.setPath('cache', cacheDir)
  app.setPath('temp', tempDir)
  app.setPath('crashDumps', crashDumpsDir)
  app.setAppLogsPath(logsDir)
}

function configurePlatformAppPaths(): void {
  if (process.platform === 'win32') {
    configureAppPathsForDataRoot(resolveWindowsDataRoot())
    return
  }

  if (process.platform === 'darwin') {
    configureAppPathsForDataRoot(resolveMacDataRoot())
  }
}

interface PythonCandidate {
  command: string
  argsPrefix: string[]
  label: string
}

interface PythonProbeResult {
  candidate: PythonCandidate
  ok: boolean
  durationMs: number
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  errorCode: string | null
  errorMessage: string | null
}

interface PythonLaunchState {
  channel: BackendLaunchChannel
  startedAtMs: number
  spawnErrorCode: string | null
  spawnErrorMessage: string | null
  closeCode: number | null
  closeSignal: NodeJS.Signals | null
}

function getBackendScriptPath(): string {
  if (!app.isPackaged) {
    return path.join(__dirname, '../../../agent/server/app.py')
  }
  return path.join(process.resourcesPath, 'agent', 'server', 'app.py')
}

function getBundledPythonPath(): string {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.resourcesPath, 'python', 'python.exe'),
          path.join(process.resourcesPath, 'python', 'Scripts', 'python.exe'),
          path.join(process.resourcesPath, 'python', 'bin', 'python.exe'),
        ]
      : [
          path.join(process.resourcesPath, 'python', 'bin', 'python3'),
          path.join(process.resourcesPath, 'python', 'python3'),
        ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[0]
}

function getBundledNodePath(): string {
  if (process.platform === 'win32') {
    return path.join(process.resourcesPath, 'node', 'node.exe')
  }
  return path.join(process.resourcesPath, 'node', 'bin', 'node')
}

function getBundledRuntimeRootFromExecutable(executablePath: string): string {
  const executableDir = path.dirname(executablePath)
  const dirName = path.basename(executableDir).toLowerCase()
  if (dirName === 'bin' || dirName === 'scripts') {
    return path.dirname(executableDir)
  }
  return executableDir
}

function getBundledPlaywrightBrowsersPath(): string {
  return path.join(process.resourcesPath, 'playwright-browsers')
}

function getBundledToolsPathEntries(): string[] {
  const toolsRoot = path.join(process.resourcesPath, 'tools')
  if (!existsSync(toolsRoot)) return []

  const entries: string[] = []
  for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const payloadRoot = path.join(toolsRoot, entry.name, 'payload')
    const candidates = [
      payloadRoot,
      path.join(payloadRoot, 'bin'),
      path.join(payloadRoot, 'Contents', 'MacOS'),
      path.join(payloadRoot, 'LibreOffice.app', 'Contents', 'MacOS'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        entries.push(candidate)
      }
    }
  }

  return Array.from(new Set(entries))
}

function getWindowsPlaywrightBrowsersPath(): string | null {
  if (process.platform !== 'win32') return null

  const dataRoot = resolveWindowsDataRoot()
  const localAppDataDir = path.join(dataRoot, 'Local')
  const browsersPath = path.join(localAppDataDir, 'ms-playwright')

  ensureDir(localAppDataDir)
  ensureDir(browsersPath)
  return browsersPath
}

function listPlaywrightAssets(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function seedPlaywrightBrowsersFromBundled(
  bundledPath: string | null,
  runtimePath: string | null,
): void {
  if (!bundledPath || !runtimePath) return

  if (!existsSync(bundledPath)) {
    console.warn(
      `[Playwright Runtime] Bundled browsers path missing, skip seed: ${bundledPath}. Runtime can still auto-download browsers into ${runtimePath}.`,
    )
    return
  }

  const runtimeAssets = listPlaywrightAssets(runtimePath)
  if (runtimeAssets.length > 0) {
    console.log(
      `[Playwright Runtime] Skip seed, runtime browsers already exist at ${runtimePath} | assets: ${runtimeAssets.join(', ')}`,
    )
    return
  }

  const bundledAssets = listPlaywrightAssets(bundledPath)
  if (bundledAssets.length === 0) {
    console.warn(
      `[Playwright Runtime] Bundled browsers path is empty, skip seed: ${bundledPath}. Runtime can still auto-download browsers into ${runtimePath}.`,
    )
    return
  }

  try {
    cpSync(bundledPath, runtimePath, { recursive: true, force: false })
    const seededAssets = listPlaywrightAssets(runtimePath)
    console.log(
      `[Playwright Runtime] Seeded runtime browsers: ${bundledPath} -> ${runtimePath} | assets: ${seededAssets.join(', ')}`,
    )
  } catch (error) {
    console.warn(
      `[Playwright Runtime] Failed to seed runtime browsers ${bundledPath} -> ${runtimePath}: ${String(error)}. Runtime can still auto-download browsers.`,
    )
  }
}

function getPythonCandidates(packagedCandidates?: string[]): PythonCandidate[] {
  const candidates: PythonCandidate[] = []

  if (app.isPackaged) {
    const packagedList = Array.isArray(packagedCandidates) && packagedCandidates.length > 0
      ? packagedCandidates
      : [getBundledPythonPath()]

    for (const command of packagedList) {
      candidates.push({ command, argsPrefix: [], label: `bundled:${command}` })
    }
  } else {
    const envPython = process.env.SKILLS_MCP_PYTHON || process.env.PYTHON
    if (envPython) {
      candidates.push({ command: envPython, argsPrefix: [], label: `env:${envPython}` })
    }

    candidates.push({ command: 'python', argsPrefix: [], label: 'python' })
    if (process.platform !== 'win32') {
      candidates.push({ command: 'python3', argsPrefix: [], label: 'python3' })
    } else {
      candidates.push({ command: 'py', argsPrefix: ['-3'], label: 'py -3' })
    }
  }

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.command} ${candidate.argsPrefix.join(' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function sanitizeBundledRuntimeEnv(env: NodeJS.ProcessEnv): string[] {
  const blockedExact = new Set([
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PYTHONUSERBASE',
    'PIP_CONFIG_FILE',
    'PIP_REQUIRE_VIRTUALENV',
    'PIP_TARGET',
    'PIP_PREFIX',
    'VIRTUAL_ENV',
    'NODE_OPTIONS',
    'NPM_CONFIG_PREFIX',
    'NPM_CONFIG_USERCONFIG',
  ])
  const blockedPrefixes = ['CONDA_', 'PYENV_', 'POETRY_', 'PIPENV_', 'UV_']
  const removed: string[] = []

  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase()
    if (blockedExact.has(normalized) || blockedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      delete env[key]
      removed.push(key)
    }
  }
  return removed
}

function buildPythonProbeEnv(candidate: PythonCandidate): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: '1', PIP_USER: '0' }
  if (app.isPackaged) {
    sanitizeBundledRuntimeEnv(env)
  }
  if (candidate.command.includes(path.sep) || path.isAbsolute(candidate.command)) {
    for (const p of getBundledPythonPathEntries(candidate.command)) {
      if (existsSync(p)) {
        env.PATH = prependPath(env.PATH, p)
      }
    }
  }
  return env
}

function probePythonCandidate(candidate: PythonCandidate): PythonProbeResult {
  const startedAt = Date.now()
  if (candidate.command.includes(path.sep) || path.isAbsolute(candidate.command)) {
    if (!existsSync(candidate.command)) {
      return {
        candidate,
        ok: false,
        durationMs: Date.now() - startedAt,
        status: null,
        signal: null,
        timedOut: false,
        errorCode: 'ENOENT',
        errorMessage: `Python candidate not found: ${candidate.command}`,
      }
    }
  }

  const dependencyCheck = 'import fastapi,uvicorn,openai,yaml,fastmcp,tiktoken,send2trash'
  const probe = spawnSync(candidate.command, [...candidate.argsPrefix, '-s', '-c', dependencyCheck], {
    windowsHide: true,
    timeout: PYTHON_PROBE_TIMEOUT_MS,
    stdio: 'ignore',
    env: buildPythonProbeEnv(candidate),
  })
  const error = probe.error as NodeJS.ErrnoException | undefined
  return {
    candidate,
    ok: !error && probe.status === 0,
    durationMs: Date.now() - startedAt,
    status: probe.status,
    signal: probe.signal,
    timedOut: error?.code === 'ETIMEDOUT',
    errorCode: error?.code || null,
    errorMessage: error?.message || null,
  }
}

function probeSummary(result: PythonProbeResult): string {
  if (result.ok) {
    return `${result.candidate.label} probe ok (${result.durationMs}ms)`
  }
  const parts = [
    `${result.candidate.label} probe failed`,
    `duration=${result.durationMs}ms`,
    `status=${result.status === null ? 'null' : result.status}`,
  ]
  if (result.signal) {
    parts.push(`signal=${result.signal}`)
  }
  if (result.errorCode) {
    parts.push(`error=${result.errorCode}`)
  }
  if (result.timedOut) {
    parts.push('timedOut=true')
  }
  if (result.errorMessage) {
    parts.push(`message=${result.errorMessage}`)
  }
  return parts.join(', ')
}

function prependPath(currentPath: string | undefined, newDir: string): string {
  if (!currentPath) {
    return newDir
  }
  const parts = currentPath.split(path.delimiter).filter(Boolean)
  if (parts.includes(newDir)) {
    return currentPath
  }
  return `${newDir}${path.delimiter}${currentPath}`
}

function getBundledPythonPathEntries(pythonExe: string): string[] {
  const entries: string[] = []
  const pythonRoot = getBundledRuntimeRootFromExecutable(pythonExe)
  const pythonDir = path.dirname(pythonExe)

  entries.push(pythonDir)

  if (process.platform === 'win32') {
    entries.push(path.join(pythonRoot, 'Scripts'))
    entries.push(path.join(pythonRoot, 'Library', 'bin'))
    entries.push(path.join(pythonRoot, 'Library', 'usr', 'bin'))
    entries.push(path.join(pythonRoot, 'DLLs'))
  } else {
    entries.push(path.join(pythonRoot, 'bin'))
    entries.push(path.join(pythonRoot, 'lib'))
  }

  return entries
}

function buildBackendEnv(
  selectedPython: PythonCandidate,
  runtimeRoot: string,
  runtimeInfo: BackendRuntimeInfo,
  bundledNodePath: string | null,
  playwrightBrowsersPath: string | null,
  bundledToolsPathEntries: string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    SKILLS_MCP_RUNTIME_ROOT: runtimeRoot,
    SKILLS_MCP_PYTHON: selectedPython.command,
    [BACKEND_HOST_ENV_VAR]: runtimeInfo.host,
    [BACKEND_PORT_ENV_VAR]: String(runtimeInfo.port),
    [BACKEND_APP_ID_ENV_VAR]: runtimeInfo.appId,
    [BACKEND_APP_VERSION_ENV_VAR]: runtimeInfo.appVersion,
    PYTHONNOUSERSITE: '1',
    PIP_USER: '0',
  }

  if (app.isPackaged) {
    const removed = sanitizeBundledRuntimeEnv(env)
    if (removed.length > 0) {
      logBackendStartup('info', `[Backend Env] Cleared inherited variables: ${removed.join(', ')}`)
    }
  }

  let dataRootForEnv: string | null = null
  if (process.platform === 'win32') {
    dataRootForEnv = resolveWindowsDataRoot()
  } else if (process.platform === 'darwin') {
    dataRootForEnv = resolveMacDataRoot()
  }

  if (dataRootForEnv) {
    env.SKILLS_MCP_DATA_ROOT = dataRootForEnv
  }

  if (process.platform === 'win32' || process.platform === 'darwin') {
    const dataRoot = dataRootForEnv || runtimeRoot
    const homeDir = path.join(dataRoot, 'home')
    const appDataDir =
      process.platform === 'win32' ? path.join(dataRoot, 'Roaming') : path.join(dataRoot, 'electron', 'appData')
    const localAppDataDir =
      process.platform === 'win32' ? path.join(dataRoot, 'Local') : path.join(dataRoot, 'electron', 'cache')
    const tempDir = path.join(dataRoot, 'tmp')
    const xdgDataDir = path.join(dataRoot, 'xdg', 'data')
    const xdgStateDir = path.join(dataRoot, 'xdg', 'state')

    for (const dir of [homeDir, appDataDir, localAppDataDir, tempDir, xdgDataDir, xdgStateDir]) {
      ensureDir(dir)
    }

    env.HOME = homeDir
    env.USERPROFILE = homeDir
    env.APPDATA = appDataDir
    env.LOCALAPPDATA = localAppDataDir
    env.TEMP = tempDir
    env.TMP = tempDir
    env.TMPDIR = tempDir

    if (process.platform === 'darwin') {
      env.XDG_CONFIG_HOME = appDataDir
      env.XDG_CACHE_HOME = localAppDataDir
      env.XDG_DATA_HOME = xdgDataDir
      env.XDG_STATE_HOME = xdgStateDir
    }
  }

  if (bundledNodePath) {
    env.SKILLS_MCP_NODE = bundledNodePath
    const bundledNodeDir = path.dirname(bundledNodePath)
    const bundledNodeRoot = getBundledRuntimeRootFromExecutable(bundledNodePath)
    env.PATH = prependPath(env.PATH, bundledNodeDir)
    env.NODE_PATH = prependPath(env.NODE_PATH, path.join(bundledNodeRoot, 'node_modules'))
  }

  if (playwrightBrowsersPath) {
    ensureDir(playwrightBrowsersPath)
    env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath
    env.SKILLS_MCP_PLAYWRIGHT_BROWSERS = playwrightBrowsersPath
  }

  if (selectedPython.command.includes(path.sep) || path.isAbsolute(selectedPython.command)) {
    for (const p of getBundledPythonPathEntries(selectedPython.command)) {
      if (existsSync(p)) {
        env.PATH = prependPath(env.PATH, p)
      }
    }
  }

  if (bundledToolsPathEntries.length > 0) {
    env.SKILLS_MCP_TOOLS_PATHS = bundledToolsPathEntries.join(path.delimiter)
    for (const toolsPathEntry of bundledToolsPathEntries) {
      env.PATH = prependPath(env.PATH, toolsPathEntry)
    }
  }

  return env
}
function resolveRuntimeRoot(): string {
  const override = (process.env.SKILLS_MCP_RUNTIME_ROOT || '').trim()

  if (process.platform === 'win32') {
    const dataRoot = resolveWindowsDataRoot()

    if (override) {
      const normalizedOverride = path.resolve(override)
      const dataRootLower = dataRoot.toLowerCase()
      const normalizedLower = normalizedOverride.toLowerCase()
      const allowedPrefix = `${dataRootLower}${path.sep}`

      if (normalizedLower === dataRootLower || normalizedLower.startsWith(allowedPrefix)) {
        ensureDir(normalizedOverride)
        return normalizedOverride
      }

      console.warn(`[Runtime Root] Reject override outside Windows data root: ${override}`)
    }

    const runtimeRoot = path.join(dataRoot, 'workspace-root')
    ensureDir(runtimeRoot)
    return runtimeRoot
  }

  if (process.platform === 'darwin') {
    const dataRoot = resolveMacDataRoot()

    if (override) {
      const normalizedOverride = path.resolve(override)
      const allowedPrefix = `${dataRoot}${path.sep}`

      if (normalizedOverride === dataRoot || normalizedOverride.startsWith(allowedPrefix)) {
        ensureDir(normalizedOverride)
        return normalizedOverride
      }

      console.warn(`[Runtime Root] Reject override outside macOS data root: ${override}`)
    }

    const runtimeRoot = path.join(dataRoot, 'workspace-root')
    ensureDir(runtimeRoot)
    return runtimeRoot
  }

  if (override) {
    const normalizedOverride = path.resolve(override)
    ensureDir(normalizedOverride)
    return normalizedOverride
  }

  const runtimeRoot = path.join(app.getPath('userData'), 'workspace-root')
  ensureDir(runtimeRoot)
  return runtimeRoot
}

function quoteForCmd(arg: string): string {
  const escaped = arg.replace(/"/g, '""')
  return `"${escaped}"`
}

function stopPythonProcess(reason: string): void {
  if (!pythonProcess) return
  const running = pythonProcess
  const pid = running.pid
  try {
    running.kill()
  } catch (error) {
    logBackendStartup('warn', `[Python Backend] Failed to stop pid=${pid}: ${String(error)}`)
  } finally {
    if (pythonProcess?.pid === running.pid) {
      pythonProcess = null
    }
  }
  logBackendStartup('warn', `[Python Backend] Stopped pid=${pid} (${reason})`)
}

function classifyLaunchFailure(state: PythonLaunchState): string {
  if (state.spawnErrorCode || state.spawnErrorMessage) {
    const maybeIntercepted = state.spawnErrorCode && INTERCEPT_ERROR_CODES.has(state.spawnErrorCode.toUpperCase())
    return `spawn error code=${state.spawnErrorCode || 'unknown'} message=${state.spawnErrorMessage || 'unknown'}${
      maybeIntercepted ? ' (possible process interception)' : ''
    }`
  }
  if (state.closeCode !== null || state.closeSignal) {
    return `exited early code=${state.closeCode === null ? 'null' : state.closeCode} signal=${
      state.closeSignal || 'null'
    }`
  }
  return 'health check timed out while process stayed alive'
}

function getRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  return BACKEND_RETRY_BASE_MS * Math.pow(2, exponent)
}

function spawnBackendProcess(
  selected: PythonCandidate,
  scriptPath: string,
  runtimeRoot: string,
  backendEnv: NodeJS.ProcessEnv,
  channel: BackendLaunchChannel,
): { ok: boolean; reason?: string; state?: PythonLaunchState } {
  const runArgs = [...selected.argsPrefix, '-s', scriptPath]
  const launchState: PythonLaunchState = {
    channel,
    startedAtMs: Date.now(),
    spawnErrorCode: null,
    spawnErrorMessage: null,
    closeCode: null,
    closeSignal: null,
  }

  let child: ChildProcess
  try {
    if (channel === 'direct') {
      child = spawn(selected.command, runArgs, {
        cwd: runtimeRoot,
        env: backendEnv,
        windowsHide: true,
      })
    } else {
      if (process.platform !== 'win32') {
        return { ok: false, reason: 'cmd-wrapper channel is only available on Windows.' }
      }
      const cmdExe = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      const cmdLine = [selected.command, ...runArgs].map(quoteForCmd).join(' ')
      child = spawn(cmdExe, ['/d', '/s', '/c', cmdLine], {
        cwd: runtimeRoot,
        env: backendEnv,
        windowsHide: false,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    launchState.spawnErrorMessage = message
    return { ok: false, reason: message, state: launchState }
  }

  pythonProcess = child
  logBackendStartup(
    'info',
    `[Backend Startup] Spawned python pid=${child.pid || 'unknown'} channel=${channel} runtime=${selected.label}`,
  )

  child.stdout?.on('data', (data) => {
    logBackendStartup('info', `[Python Backend] ${String(data).trimEnd()}`)
  })

  child.stderr?.on('data', (data) => {
    logBackendStartup('warn', `[Python Backend Error] ${String(data).trimEnd()}`)
  })

  child.on('error', (error) => {
    const nodeErr = error as NodeJS.ErrnoException
    launchState.spawnErrorCode = nodeErr.code || null
    launchState.spawnErrorMessage = nodeErr.message || String(error)
    logBackendStartup(
      'error',
      `[Python Backend Spawn Error] channel=${channel} code=${launchState.spawnErrorCode || 'unknown'} message=${
        launchState.spawnErrorMessage || 'unknown'
      }`,
    )
  })

  child.on('close', (code, signal) => {
    launchState.closeCode = code
    launchState.closeSignal = signal
    logBackendStartup('warn', `[Python Backend] Exited with code=${code}, signal=${signal}, channel=${channel}`)
    if (pythonProcess?.pid === child.pid) {
      pythonProcess = null
    }
  })

  return { ok: true, state: launchState }
}

async function startPythonBackend(): Promise<{ ok: boolean; reason?: string }> {
  setBackendStartupStatus('starting')
  const scriptPath = getBackendScriptPath()
  const runtimeRoot = resolveRuntimeRoot()
  if (!existsSync(scriptPath)) {
    const reason = `Backend script not found: ${scriptPath}`
    setBackendStartupStatus('failed', reason)
    return { ok: false, reason }
  }

  let bundledNodePath: string | null = null
  let bundledPlaywrightBrowsersPath: string | null = null
  let runtimePlaywrightBrowsersPath: string | null = getWindowsPlaywrightBrowsersPath()
  let bundledToolsPathEntries: string[] = []

  if (app.isPackaged) {
    bundledNodePath = getBundledNodePath()
    if (!existsSync(bundledNodePath)) {
      const reason = `Bundled Node runtime not found: ${bundledNodePath}. Package runtime/node before building.`
      setBackendStartupStatus('failed', reason)
      return {
        ok: false,
        reason,
      }
    }

    bundledPlaywrightBrowsersPath = getBundledPlaywrightBrowsersPath()
    bundledToolsPathEntries = getBundledToolsPathEntries()
    if (process.platform !== 'win32') {
      if (!existsSync(bundledPlaywrightBrowsersPath)) {
        const reason = `Bundled Playwright browsers not found: ${bundledPlaywrightBrowsersPath}. Package runtime/playwright-browsers before building.`
        setBackendStartupStatus('failed', reason)
        return {
          ok: false,
          reason,
        }
      }
      runtimePlaywrightBrowsersPath = bundledPlaywrightBrowsersPath
    } else {
      seedPlaywrightBrowsersFromBundled(bundledPlaywrightBrowsersPath, runtimePlaywrightBrowsersPath)
    }
  }

  const candidates = getPythonCandidates()
  if (candidates.length === 0) {
    if (app.isPackaged) {
      const expectedPython = getBundledPythonPath()
      const reason = `Bundled Python runtime not found: ${expectedPython}. Package runtime/python before building.`
      setBackendStartupStatus('failed', reason)
      return {
        ok: false,
        reason,
      }
    }
    const reason =
      'No Python runtime candidates found. Set SKILLS_MCP_PYTHON or install Python, then ensure required dependencies are available.'
    setBackendStartupStatus('failed', reason)
    return {
      ok: false,
      reason,
    }
  }

  const probeResults = candidates.map(probePythonCandidate)
  for (const result of probeResults) {
    logBackendStartup(result.ok ? 'info' : 'warn', `[Python Probe] ${probeSummary(result)}`)
  }

  const runnable = probeResults.filter((result) => result.ok).map((result) => result.candidate)
  const selected = runnable.length > 0 ? runnable[0] : candidates[0]
  if (runnable.length === 0) {
    logBackendStartup(
      'warn',
      `[Backend Startup] No probe passed within ${PYTHON_PROBE_TIMEOUT_MS}ms; attempting startup with fallback candidate: ${selected.label}`,
    )
  }

  logBackendStartup('info', `[Python Backend] Using runtime: ${selected.label}`)
  if (bundledNodePath) {
    logBackendStartup('info', `[Node Runtime] Using bundled node: ${bundledNodePath}`)
  }
  if (runtimePlaywrightBrowsersPath) {
    const runtimeAssets = listPlaywrightAssets(runtimePlaywrightBrowsersPath)
    logBackendStartup(
      'info',
      `[Playwright Runtime] Using browsers path: ${runtimePlaywrightBrowsersPath} | assets: ${
        runtimeAssets.length > 0 ? runtimeAssets.join(', ') : '(empty)'
      }`,
    )
  }
  if (process.platform === 'win32' && bundledPlaywrightBrowsersPath && existsSync(bundledPlaywrightBrowsersPath)) {
    const bundledAssets = listPlaywrightAssets(bundledPlaywrightBrowsersPath)
    logBackendStartup(
      'info',
      `[Playwright Runtime] Bundled seed path: ${bundledPlaywrightBrowsersPath} | assets: ${
        bundledAssets.length > 0 ? bundledAssets.join(', ') : '(empty)'
      }`,
    )
  } else if (app.isPackaged && process.platform === 'win32' && bundledPlaywrightBrowsersPath) {
    logBackendStartup(
      'warn',
      `[Playwright Runtime] Bundled seed path not found: ${bundledPlaywrightBrowsersPath}. Runtime auto-download remains available.`,
    )
  }

  let lastFailure = 'Backend startup did not complete.'

  for (let attempt = 1; attempt <= BACKEND_MAX_RETRIES; attempt += 1) {
    let runtimeInfo: BackendRuntimeInfo
    try {
      runtimeInfo = await allocateBackendRuntimeInfo(DEFAULT_BACKEND_HOST)
    } catch (error) {
      lastFailure = `Attempt ${attempt}/${BACKEND_MAX_RETRIES} failed to reserve backend port: ${String(error)}`
      logBackendStartup('error', `[Backend Startup] ${lastFailure}`)
      if (attempt < BACKEND_MAX_RETRIES) {
        const delayMs = getRetryDelayMs(attempt)
        logBackendStartup('info', `[Backend Startup] Retry in ${delayMs}ms`)
        await sleep(delayMs)
      }
      continue
    }
    backendRuntimeInfo = runtimeInfo
    const backendEnv = buildBackendEnv(
      selected,
      runtimeRoot,
      runtimeInfo,
      bundledNodePath,
      runtimePlaywrightBrowsersPath,
      bundledToolsPathEntries,
    )
    const channel: BackendLaunchChannel =
      process.platform === 'win32' && attempt > 1 ? 'cmd-wrapper' : 'direct'
    logBackendStartup(
      'info',
      `[Backend Startup] Attempt ${attempt}/${BACKEND_MAX_RETRIES} channel=${channel} origin=${runtimeInfo.origin}`,
    )

    const launch = spawnBackendProcess(selected, scriptPath, runtimeRoot, backendEnv, channel)
    if (!launch.ok || !launch.state) {
      lastFailure = `Attempt ${attempt}/${BACKEND_MAX_RETRIES} failed to spawn backend via ${channel}: ${
        launch.reason || 'unknown error'
      }`
      logBackendStartup('error', `[Backend Startup] ${lastFailure}`)
    } else {
      const ready = await waitForBackendReady(BACKEND_READY_TIMEOUT_MS, runtimeInfo)
      if (ready) {
        logBackendStartup('info', `[Backend Startup] Backend ready on attempt ${attempt}/${BACKEND_MAX_RETRIES}`)
        setBackendStartupStatus('ready')
        return { ok: true }
      }

      const elapsedMs = Date.now() - launch.state.startedAtMs
      lastFailure = `Attempt ${attempt}/${BACKEND_MAX_RETRIES} did not become ready after ${elapsedMs}ms via ${channel}; ${classifyLaunchFailure(
        launch.state,
      )}`
      logBackendStartup('warn', `[Backend Startup] ${lastFailure}`)
    }

    stopPythonProcess(`retry cleanup ${attempt}/${BACKEND_MAX_RETRIES}`)
    if (attempt < BACKEND_MAX_RETRIES) {
      const delayMs = getRetryDelayMs(attempt)
      logBackendStartup('info', `[Backend Startup] Retry in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }

  setBackendStartupStatus('failed', `${lastFailure}. Diagnostics log: ${getBackendStartupLogPath()}`)
  return {
    ok: false,
    reason: `${lastFailure}. Diagnostics log: ${getBackendStartupLogPath()}`,
  }
}

async function waitForBackendReady(timeoutMs: number, runtimeInfo: BackendRuntimeInfo): Promise<boolean> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (!pythonProcess) return false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
      const resp = await fetch(runtimeInfo.healthUrl, { signal: controller.signal })
      if (resp.ok) {
        const payload = (await resp.json()) as BackendHealthPayload
        if (isExpectedBackendHealth(payload, runtimeInfo)) {
          return true
        }
      }
    } catch {
      // keep polling
    } finally {
      clearTimeout(timeout)
    }
    await new Promise((resolve) => setTimeout(resolve, BACKEND_POLL_INTERVAL_MS))
  }

  return false
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[Renderer Load Error] code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      )
      dialog.showErrorBox(
        'Renderer load failed',
        `Code: ${errorCode}\nDescription: ${errorDescription}\nURL: ${validatedURL}`,
      )
    },
  )

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Renderer Gone] reason=${details.reason} exitCode=${details.exitCode}`)
    dialog.showErrorBox(
      'Renderer process crashed',
      `Reason: ${details.reason}\nExit code: ${details.exitCode}`,
    )
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (isAppQuitting) return

    const action = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Cancel', 'Exit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Confirm Exit',
      message: 'Exit the application now?',
      detail: 'Any running task will be interrupted.',
    })

    if (action !== 1) {
      event.preventDefault()
      return
    }

    isAppQuitting = true
    stopPythonProcess('window close')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

configurePlatformAppPaths()

ipcMain.handle('app:request-exit', async () => {
  isAppQuitting = true
  stopPythonProcess('renderer requested exit')
  app.quit()
  return true
})

ipcMain.handle('app:get-runtime-status', async () => getRuntimeStatusSnapshot())

ipcMain.handle('app:retry-backend-start', async () => {
  stopPythonProcess('renderer retry')
  const result = await startPythonBackend()
  if (!result.ok) {
    logBackendStartup('error', `[Backend Startup] Retry failed: ${result.reason || 'unknown error'}`)
  }
  return getRuntimeStatusSnapshot()
})

ipcMain.handle('app:open-backend-logs', async () => {
  const logsDir = path.dirname(getBackendStartupLogPath())
  const error = await shell.openPath(logsDir)
  if (error) {
    return { ok: false, error, path: logsDir }
  }
  return { ok: true, path: logsDir }
})

ipcMain.handle('files:pick-folder', async () => {
  const options: OpenDialogOptions = {
    title: 'Select Folder',
    properties: ['openDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('files:download', async (_event, payload: { url?: string; filename?: string }) => {
  if (!mainWindow) {
    return { ok: false, error: 'Main window is not available' }
  }

  const url = String(payload?.url || '').trim()
  if (!url) {
    return { ok: false, error: 'Download URL is required' }
  }

  const suggestedName = String(payload?.filename || '').trim()
  const defaultPath = suggestedName
    ? path.join(app.getPath('downloads'), suggestedName)
    : app.getPath('downloads')

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save File',
    defaultPath,
  })

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true }
  }

  const targetPath = saveResult.filePath
  const session = mainWindow.webContents.session

  return await new Promise<{ ok?: boolean; canceled?: boolean; error?: string }>((resolve) => {
    let settled = false

    const finish = (result: { ok?: boolean; canceled?: boolean; error?: string }) => {
      if (settled) return
      settled = true
      session.off('will-download', handleWillDownload)
      resolve(result)
    }

    const handleWillDownload = (
      _downloadEvent: Electron.Event,
      item: Electron.DownloadItem,
      _webContents: Electron.WebContents,
    ) => {
      if (item.getURL() !== url) {
        return
      }

      item.setSavePath(targetPath)
      item.once('done', (_event, state) => {
        if (state === 'completed') {
          finish({ ok: true })
          return
        }
        if (state === 'cancelled') {
          finish({ canceled: true })
          return
        }
        finish({ ok: false, error: `Download failed: ${state}` })
      })
    }

    session.on('will-download', handleWillDownload)

    try {
      mainWindow?.webContents.downloadURL(url)
    } catch (error) {
      finish({ ok: false, error: String(error) })
    }
  })
})

app.whenReady().then(async () => {
  const startResult = await startPythonBackend()
  if (!startResult.ok) {
    logBackendStartup('error', `[Backend Startup] Initial startup failed: ${startResult.reason || 'Unknown error'}`)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopPythonProcess('window-all-closed')
    app.quit()
  }
})

app.on('before-quit', () => {
  stopPythonProcess('before-quit')
})




