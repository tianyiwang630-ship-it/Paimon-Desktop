import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import path from 'path'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { spawn, spawnSync, ChildProcess } from 'child_process'

let mainWindow: BrowserWindow | null = null
let pythonProcess: ChildProcess | null = null
let isAppQuitting = false

const API_HEALTH_URL = 'http://127.0.0.1:8000/api/health'
const BACKEND_READY_TIMEOUT_MS = 30_000
const BACKEND_POLL_INTERVAL_MS = 500
const WINDOWS_DATA_ROOT = path.join('D:\\', 'PaimonData')

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
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

function configureWindowsAppPaths(): void {
  if (process.platform !== 'win32') return

  const dataRoot = resolveWindowsDataRoot()
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

interface PythonCandidate {
  command: string
  argsPrefix: string[]
  label: string
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

function getBundledPlaywrightBrowsersPath(): string {
  return path.join(process.resourcesPath, 'playwright-browsers')
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

function getPythonCandidates(): PythonCandidate[] {
  const candidates: PythonCandidate[] = []
  const allowSystemFallback = process.env.SKILLS_MCP_ALLOW_SYSTEM_RUNTIME === '1'

  if (app.isPackaged && !allowSystemFallback) {
    const bundledPython = getBundledPythonPath()
    if (existsSync(bundledPython)) {
      return [{ command: bundledPython, argsPrefix: [], label: 'bundled python' }]
    }
    return []
  }

  const bundledPython = getBundledPythonPath()
  if (app.isPackaged && existsSync(bundledPython)) {
    candidates.push({ command: bundledPython, argsPrefix: [], label: 'bundled python' })
  }

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

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.command} ${candidate.argsPrefix.join(' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function canRunPython(candidate: PythonCandidate): boolean {
  if (candidate.command.includes(path.sep) || path.isAbsolute(candidate.command)) {
    if (!existsSync(candidate.command)) {
      return false
    }
  }

  const dependencyCheck = 'import fastapi,uvicorn,openai,yaml,fastmcp,tiktoken,send2trash'
  const probe = spawnSync(candidate.command, [...candidate.argsPrefix, '-s', '-c', dependencyCheck], {
    windowsHide: true,
    timeout: 8000,
    stdio: 'ignore',
    env: { ...process.env, PYTHONNOUSERSITE: '1', PIP_USER: '0' },
  })
  return !probe.error && probe.status === 0
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
  const pythonDir = path.dirname(pythonExe)

  entries.push(pythonDir)

  if (process.platform === 'win32') {
    entries.push(path.join(pythonDir, 'Scripts'))
    entries.push(path.join(pythonDir, 'Library', 'bin'))
    entries.push(path.join(pythonDir, 'Library', 'usr', 'bin'))
    entries.push(path.join(pythonDir, 'DLLs'))
  } else {
    entries.push(path.join(pythonDir, 'bin'))
    entries.push(path.join(pythonDir, 'lib'))
  }

  return entries
}

function buildBackendEnv(
  selectedPython: PythonCandidate,
  runtimeRoot: string,
  bundledNodePath: string | null,
  playwrightBrowsersPath: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    SKILLS_MCP_RUNTIME_ROOT: runtimeRoot,
    SKILLS_MCP_PYTHON: selectedPython.command,
    PYTHONNOUSERSITE: '1',
    PIP_USER: '0',
  }

  if (process.platform === 'win32') {
    const dataRoot = resolveWindowsDataRoot()
    const homeDir = path.join(dataRoot, 'home')
    const appDataDir = path.join(dataRoot, 'Roaming')
    const localAppDataDir = path.join(dataRoot, 'Local')
    const tempDir = path.join(dataRoot, 'tmp')

    for (const dir of [homeDir, appDataDir, localAppDataDir, tempDir]) {
      ensureDir(dir)
    }

    env.HOME = homeDir
    env.USERPROFILE = homeDir
    env.APPDATA = appDataDir
    env.LOCALAPPDATA = localAppDataDir
    env.TEMP = tempDir
    env.TMP = tempDir
    env.TMPDIR = tempDir
  }

  if (bundledNodePath) {
    env.SKILLS_MCP_NODE = bundledNodePath
    const bundledNodeDir = path.dirname(bundledNodePath)
    env.PATH = prependPath(env.PATH, bundledNodeDir)
    env.NODE_PATH = prependPath(env.NODE_PATH, path.join(bundledNodeDir, 'node_modules'))
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

  if (override) {
    const normalizedOverride = path.resolve(override)
    ensureDir(normalizedOverride)
    return normalizedOverride
  }

  const runtimeRoot = path.join(app.getPath('userData'), 'workspace-root')
  ensureDir(runtimeRoot)
  return runtimeRoot
}

function startPythonBackend(): { ok: boolean; reason?: string } {
  const scriptPath = getBackendScriptPath()
  const runtimeRoot = resolveRuntimeRoot()
  if (!existsSync(scriptPath)) {
    return { ok: false, reason: `Backend script not found: ${scriptPath}` }
  }

  let bundledNodePath: string | null = null
  let bundledPlaywrightBrowsersPath: string | null = null
  let runtimePlaywrightBrowsersPath: string | null = getWindowsPlaywrightBrowsersPath()
  if (app.isPackaged) {
    bundledNodePath = getBundledNodePath()
    if (!existsSync(bundledNodePath)) {
      return {
        ok: false,
        reason: `Bundled Node runtime not found: ${bundledNodePath}. Package runtime/node before building.`,
      }
    }

    bundledPlaywrightBrowsersPath = getBundledPlaywrightBrowsersPath()
    if (process.platform !== 'win32') {
      if (!existsSync(bundledPlaywrightBrowsersPath)) {
        return {
          ok: false,
          reason: `Bundled Playwright browsers not found: ${bundledPlaywrightBrowsersPath}. Package runtime/playwright-browsers before building.`,
        }
      }
      runtimePlaywrightBrowsersPath = bundledPlaywrightBrowsersPath
    } else {
      seedPlaywrightBrowsersFromBundled(bundledPlaywrightBrowsersPath, runtimePlaywrightBrowsersPath)
    }
  }

  const runnable = getPythonCandidates().filter(canRunPython)
  if (runnable.length === 0) {
    if (app.isPackaged) {
      const bundledPython = getBundledPythonPath()
      return {
        ok: false,
        reason: `Bundled Python runtime not usable: ${bundledPython}. Package runtime/python with required dependencies.`,
      }
    }
    return {
      ok: false,
      reason:
        'No usable Python runtime with required packages found (fastapi, uvicorn, openai, pyyaml, fastmcp, tiktoken, send2trash). Set SKILLS_MCP_PYTHON to a prepared environment.',
    }
  }

  const selected = runnable[0]
  console.log(`[Python Backend] Using runtime: ${selected.label}`)
  if (bundledNodePath) {
    console.log(`[Node Runtime] Using bundled node: ${bundledNodePath}`)
  }
  if (runtimePlaywrightBrowsersPath) {
    const runtimeAssets = listPlaywrightAssets(runtimePlaywrightBrowsersPath)
    console.log(
      `[Playwright Runtime] Using browsers path: ${runtimePlaywrightBrowsersPath} | assets: ${
        runtimeAssets.length > 0 ? runtimeAssets.join(', ') : '(empty)'
      }`,
    )
  }
  if (bundledPlaywrightBrowsersPath && existsSync(bundledPlaywrightBrowsersPath)) {
    const bundledAssets = listPlaywrightAssets(bundledPlaywrightBrowsersPath)
    console.log(
      `[Playwright Runtime] Bundled seed path: ${bundledPlaywrightBrowsersPath} | assets: ${
        bundledAssets.length > 0 ? bundledAssets.join(', ') : '(empty)'
      }`,
    )
  } else if (app.isPackaged && process.platform === 'win32' && bundledPlaywrightBrowsersPath) {
    console.warn(
      `[Playwright Runtime] Bundled seed path not found: ${bundledPlaywrightBrowsersPath}. Runtime auto-download remains available.`,
    )
  }

  pythonProcess = spawn(selected.command, [...selected.argsPrefix, '-s', scriptPath], {
    // Use writable runtime root so relative user file paths never point into resources/.
    cwd: runtimeRoot,
    env: buildBackendEnv(selected, runtimeRoot, bundledNodePath, runtimePlaywrightBrowsersPath),
    windowsHide: true,
  })

  pythonProcess.stdout?.on('data', (data) => {
    console.log(`[Python Backend] ${String(data)}`)
  })

  pythonProcess.stderr?.on('data', (data) => {
    console.error(`[Python Backend Error] ${String(data)}`)
  })

  pythonProcess.on('error', (error) => {
    console.error(`[Python Backend Spawn Error] ${error.message}`)
  })

  pythonProcess.on('close', (code, signal) => {
    console.log(`[Python Backend] Exited with code ${code}, signal ${signal}`)
    pythonProcess = null
  })

  return { ok: true }
}

async function waitForBackendReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (!pythonProcess) return false
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      const resp = await fetch(API_HEALTH_URL, { signal: controller.signal })
      clearTimeout(timeout)
      if (resp.ok) return true
    } catch {
      // keep polling
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
    if (pythonProcess) {
      pythonProcess.kill()
      pythonProcess = null
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

configureWindowsAppPaths()

ipcMain.handle('app:request-exit', async () => {
  isAppQuitting = true
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
  app.quit()
  return true
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
  const startResult = startPythonBackend()
  if (!startResult.ok) {
    dialog.showErrorBox('Backend startup failed', startResult.reason || 'Unknown error')
  } else {
    const ready = await waitForBackendReady(BACKEND_READY_TIMEOUT_MS)
    if (!ready) {
      dialog.showErrorBox(
        'Backend not ready',
        'The local backend did not become ready within 30 seconds. Check logs and Python environment.',
      )
    }
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
    if (pythonProcess) {
      pythonProcess.kill()
    }
    app.quit()
  }
})

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill()
  }
})



