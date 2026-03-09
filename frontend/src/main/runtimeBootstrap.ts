import { app } from 'electron'
import path from 'path'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

type BootstrapLogLevel = 'info' | 'warn' | 'error'

export interface RuntimeBootstrapResult {
  ok: boolean
  reason?: string
  runtimeHome?: string
  pythonCandidates: string[]
  nodePath: string | null
  playwrightBrowsersPath: string | null
  toolsPathEntries: string[]
}

interface RuntimeBootstrapOptions {
  runtimeRoot: string
  log: (level: BootstrapLogLevel, message: string) => void
}

interface RuntimeBootstrapConfig {
  githubRepo?: string
  releaseTagPrefix?: string
  manifestNameTemplate?: string
  manifestUrl?: string
  packageBaseUrl?: string
  maxRetries?: number
  timeoutMs?: number
  installOptionalPackages?: boolean
}

interface RuntimePackageSpec {
  name: string
  file: string
  sha256: string
  size: number
  required: boolean
  probes: string[]
}

interface RuntimeManifest {
  appVersion: string
  arch: string
  packages: RuntimePackageSpec[]
}

interface RuntimeLock {
  appVersion: string
  arch: string
  requiredProbes: string[]
  installedPackages: Array<{
    name: string
    file: string
    sha256: string
    required: boolean
  }>
  generatedAt: string
}

const DEFAULT_RUNTIME_PROBES = ['python/bin/python3', 'node/bin/node', 'playwright-browsers']
const DEFAULT_MANIFEST_NAME = 'runtime-manifest-${platform}-${arch}.json'
const DEFAULT_RELEASE_TAG_PREFIX = 'v'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 3
const RUNTIME_LOCK_FILE = 'runtime-lock.json'

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function existsAll(root: string, probes: string[]): boolean {
  for (const probe of probes) {
    const resolved = path.join(root, probe)
    if (!existsSync(resolved)) {
      return false
    }
  }
  return true
}

function dedupe(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function readPackagedRuntimeConfig(log: RuntimeBootstrapOptions['log']): RuntimeBootstrapConfig {
  const pkgPath = path.join(app.getAppPath(), 'package.json')
  if (!existsSync(pkgPath)) {
    log('warn', `[Runtime Bootstrap] package.json not found at ${pkgPath}; using default runtime bootstrap config.`)
    return {}
  }

  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const cfg = parsed.runtimeBootstrap
    if (!cfg || typeof cfg !== 'object') {
      return {}
    }
    return cfg as RuntimeBootstrapConfig
  } catch (error) {
    log('warn', `[Runtime Bootstrap] Failed to parse runtimeBootstrap config: ${String(error)}`)
    return {}
  }
}

function templateString(input: string, values: Record<string, string>): string {
  return input.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
    return values[key] ?? ''
  })
}

function resolveManifestUrl(config: RuntimeBootstrapConfig): string | null {
  const appVersion = app.getVersion()
  const platform = process.platform
  const arch = process.arch
  const releaseTagPrefix = config.releaseTagPrefix || DEFAULT_RELEASE_TAG_PREFIX
  const tag = `${releaseTagPrefix}${appVersion}`
  const values = { version: appVersion, platform, arch, tag }

  if (config.manifestUrl && config.manifestUrl.trim()) {
    return templateString(config.manifestUrl.trim(), values)
  }

  const repo = (config.githubRepo || '').trim()
  if (!repo) {
    return null
  }

  const manifestTemplate = (config.manifestNameTemplate || DEFAULT_MANIFEST_NAME).trim()
  const manifestName = templateString(manifestTemplate, values)
  return `https://github.com/${repo}/releases/download/${tag}/${manifestName}`
}

function resolvePackageBaseUrl(config: RuntimeBootstrapConfig, manifestUrl: string): string {
  if (config.packageBaseUrl && config.packageBaseUrl.trim()) {
    const rendered = templateString(config.packageBaseUrl.trim(), {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      tag: `${config.releaseTagPrefix || DEFAULT_RELEASE_TAG_PREFIX}${app.getVersion()}`,
    })
    return rendered.endsWith('/') ? rendered : `${rendered}/`
  }
  const lastSlash = manifestUrl.lastIndexOf('/')
  if (lastSlash < 0) return manifestUrl
  return manifestUrl.slice(0, lastSlash + 1)
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

async function downloadFileWithTimeout(url: string, destination: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    const tmpPath = `${destination}.part`
    const fileStream = createWriteStream(tmpPath)
    await pipeline(Readable.fromWeb(response.body as any), fileStream)
    rmSync(destination, { force: true })
    renameSync(tmpPath, destination)
  } finally {
    clearTimeout(timeout)
  }
}

async function withRetries<T>(
  taskName: string,
  retries: number,
  log: RuntimeBootstrapOptions['log'],
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      log('warn', `[Runtime Bootstrap] ${taskName} attempt ${attempt}/${retries} failed: ${String(error)}`)
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function parseRuntimeManifest(raw: unknown): RuntimeManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Manifest payload must be an object.')
  }
  const data = raw as Record<string, unknown>
  const appVersion = String(data.appVersion || '')
  const arch = String(data.arch || '')
  const packagesRaw = data.packages

  if (!appVersion) {
    throw new Error('Manifest missing appVersion.')
  }
  if (!arch) {
    throw new Error('Manifest missing arch.')
  }
  if (!Array.isArray(packagesRaw) || packagesRaw.length === 0) {
    throw new Error('Manifest missing packages.')
  }

  const packages: RuntimePackageSpec[] = packagesRaw.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Manifest package #${idx} is invalid.`)
    }
    const pkg = item as Record<string, unknown>
    const name = String(pkg.name || '').trim()
    const file = String(pkg.file || '').trim()
    const sha256 = String(pkg.sha256 || '').trim().toLowerCase()
    const size = Number(pkg.size || 0)
    const required = Boolean(pkg.required)
    const probes = Array.isArray(pkg.probes)
      ? pkg.probes.map((probe) => String(probe || '').trim()).filter(Boolean)
      : []

    if (!name || !file || !sha256 || !Number.isFinite(size) || size <= 0) {
      throw new Error(`Manifest package '${name || `#${idx}`}' is missing required fields.`)
    }
    if (probes.length === 0) {
      throw new Error(`Manifest package '${name}' has empty probes.`)
    }

    return { name, file, sha256, size: Math.floor(size), required, probes }
  })

  return { appVersion, arch, packages }
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
  })
}

function extractTarGz(archivePath: string, destinationDir: string): void {
  ensureDir(destinationDir)
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
    stdio: 'pipe',
  })

  if (result.status !== 0) {
    const stderr = result.stderr ? String(result.stderr) : ''
    const stdout = result.stdout ? String(result.stdout) : ''
    throw new Error(`tar extract failed (${result.status}). stdout=${stdout} stderr=${stderr}`)
  }
}

function runtimePaths(runtimeHome: string): RuntimeBootstrapResult {
  const pythonCandidates = dedupe([
    path.join(runtimeHome, 'python', 'bin', 'python3'),
    path.join(runtimeHome, 'python', 'python3'),
    path.join(runtimeHome, 'python', 'bin', 'python'),
  ])
  const nodePath = path.join(runtimeHome, 'node', 'bin', 'node')
  const playwrightBrowsersPath = path.join(runtimeHome, 'playwright-browsers')
  const toolsPathEntries = collectToolsPathEntries(path.join(runtimeHome, 'tools'))

  return {
    ok: true,
    runtimeHome,
    pythonCandidates,
    nodePath: existsSync(nodePath) ? nodePath : null,
    playwrightBrowsersPath: existsSync(playwrightBrowsersPath) ? playwrightBrowsersPath : null,
    toolsPathEntries,
  }
}

function collectToolsPathEntries(toolsRoot: string): string[] {
  if (!existsSync(toolsRoot)) return []
  let entries: string[] = []

  for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const payloadRoot = path.join(toolsRoot, entry.name, 'payload')
    const candidates = [
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

  entries = dedupe(entries)
  return entries
}

function loadRuntimeLock(lockPath: string): RuntimeLock | null {
  if (!existsSync(lockPath)) return null
  try {
    const raw = readFileSync(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as RuntimeLock
    return parsed
  } catch {
    return null
  }
}

function saveRuntimeLock(lockPath: string, lock: RuntimeLock): void {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf-8')
}

async function installRuntimePackage(
  packageSpec: RuntimePackageSpec,
  packageBaseUrl: string,
  runtimeHome: string,
  downloadDir: string,
  timeoutMs: number,
  retries: number,
  log: RuntimeBootstrapOptions['log'],
): Promise<void> {
  if (existsAll(runtimeHome, packageSpec.probes)) {
    log('info', `[Runtime Bootstrap] Package '${packageSpec.name}' already satisfied, skip download.`)
    return
  }

  const packageUrl = `${packageBaseUrl}${packageSpec.file}`
  const archivePath = path.join(downloadDir, packageSpec.file)
  ensureDir(downloadDir)

  await withRetries(`download ${packageSpec.name}`, retries, log, async () => {
    await downloadFileWithTimeout(packageUrl, archivePath, timeoutMs)
  })

  const archiveSize = statSync(archivePath).size
  if (archiveSize <= 0) {
    throw new Error(`Downloaded package is empty: ${packageSpec.file}`)
  }
  if (packageSpec.size > 0 && archiveSize !== packageSpec.size) {
    throw new Error(
      `Package size mismatch for ${packageSpec.name}: expected ${packageSpec.size}, actual ${archiveSize}`,
    )
  }

  const actualSha = await sha256File(archivePath)
  if (actualSha !== packageSpec.sha256) {
    throw new Error(
      `Package sha256 mismatch for ${packageSpec.name}: expected ${packageSpec.sha256}, actual ${actualSha}`,
    )
  }

  extractTarGz(archivePath, runtimeHome)
  if (!existsAll(runtimeHome, packageSpec.probes)) {
    throw new Error(`Package installed but probes missing for ${packageSpec.name}: ${packageSpec.probes.join(', ')}`)
  }

  unlinkSync(archivePath)
}

export async function bootstrapManagedRuntimeForMac(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapResult> {
  if (!app.isPackaged || process.platform !== 'darwin') {
    return {
      ok: true,
      pythonCandidates: [],
      nodePath: null,
      playwrightBrowsersPath: null,
      toolsPathEntries: [],
    }
  }

  const { runtimeRoot, log } = options
  ensureDir(runtimeRoot)

  const appVersion = app.getVersion()
  const runtimeHome = path.join(runtimeRoot, 'managed-runtime', appVersion, process.arch)
  const lockPath = path.join(runtimeHome, RUNTIME_LOCK_FILE)
  ensureDir(runtimeHome)

  const lock = loadRuntimeLock(lockPath)
  if (lock && lock.appVersion === appVersion && lock.arch === process.arch && existsAll(runtimeHome, lock.requiredProbes)) {
    log('info', `[Runtime Bootstrap] Reuse cached managed runtime: ${runtimeHome}`)
    return runtimePaths(runtimeHome)
  }
  if (existsAll(runtimeHome, DEFAULT_RUNTIME_PROBES)) {
    log('info', `[Runtime Bootstrap] Reuse managed runtime by default probes: ${runtimeHome}`)
    return runtimePaths(runtimeHome)
  }

  const config = readPackagedRuntimeConfig(log)
  const timeoutMs = readPositiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS)
  const retries = readPositiveInt(config.maxRetries, DEFAULT_MAX_RETRIES)
  const installOptional =
    config.installOptionalPackages === true || process.env.SKILLS_MCP_INSTALL_OPTIONAL_RUNTIME === '1'
  const expectedReleaseTag = `${config.releaseTagPrefix || DEFAULT_RELEASE_TAG_PREFIX}${appVersion}`

  const manifestUrl = resolveManifestUrl(config)
  if (!manifestUrl) {
    return {
      ok: false,
      reason:
        'Managed runtime is missing and runtimeBootstrap.githubRepo/runtimeBootstrap.manifestUrl is not configured. Configure runtimeBootstrap and ensure network is available on first launch.',
      pythonCandidates: [],
      nodePath: null,
      playwrightBrowsersPath: null,
      toolsPathEntries: [],
    }
  }

  log('info', `[Runtime Bootstrap] Fetch manifest: ${manifestUrl}`)
  let manifest: RuntimeManifest
  try {
    const rawManifest = await withRetries('fetch manifest', retries, log, async () => {
      return await fetchJsonWithTimeout<unknown>(manifestUrl, timeoutMs)
    })
    manifest = parseRuntimeManifest(rawManifest)
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to fetch runtime manifest from release tag ${expectedReleaseTag}. Network is required for first launch. Check release tag and package version consistency. Details: ${String(error)}`,
      pythonCandidates: [],
      nodePath: null,
      playwrightBrowsersPath: null,
      toolsPathEntries: [],
    }
  }

  if (manifest.appVersion !== appVersion) {
    return {
      ok: false,
      reason: `Runtime manifest version mismatch: manifest=${manifest.appVersion}, app=${appVersion}. Check release tag ${expectedReleaseTag} and package version consistency.`,
      pythonCandidates: [],
      nodePath: null,
      playwrightBrowsersPath: null,
      toolsPathEntries: [],
    }
  }
  if (manifest.arch !== process.arch) {
    return {
      ok: false,
      reason: `Runtime manifest arch mismatch: manifest=${manifest.arch}, app=${process.arch}`,
      pythonCandidates: [],
      nodePath: null,
      playwrightBrowsersPath: null,
      toolsPathEntries: [],
    }
  }

  const packageBaseUrl = resolvePackageBaseUrl(config, manifestUrl)
  const downloadDir = path.join(runtimeRoot, 'runtime-downloads', appVersion, process.arch)
  ensureDir(downloadDir)

  const requiredPackages = manifest.packages.filter((pkg) => pkg.required)
  const optionalPackages = manifest.packages.filter((pkg) => !pkg.required)

  for (const pkg of requiredPackages) {
    try {
      await installRuntimePackage(pkg, packageBaseUrl, runtimeHome, downloadDir, timeoutMs, retries, log)
      log('info', `[Runtime Bootstrap] Installed required package '${pkg.name}'.`)
    } catch (error) {
      return {
        ok: false,
        reason: `Failed to install required runtime package '${pkg.name}'. Details: ${String(error)}`,
        pythonCandidates: [],
        nodePath: null,
        playwrightBrowsersPath: null,
        toolsPathEntries: [],
      }
    }
  }

  if (installOptional) {
    for (const pkg of optionalPackages) {
      try {
        await installRuntimePackage(pkg, packageBaseUrl, runtimeHome, downloadDir, timeoutMs, retries, log)
        log('info', `[Runtime Bootstrap] Installed optional package '${pkg.name}'.`)
      } catch (error) {
        log('warn', `[Runtime Bootstrap] Optional runtime package '${pkg.name}' install failed: ${String(error)}`)
      }
    }
  } else if (optionalPackages.length > 0) {
    log('info', '[Runtime Bootstrap] Optional runtime packages skipped (installOptionalPackages=false).')
  }

  const requiredProbeUnion = dedupe(
    requiredPackages.flatMap((pkg) => pkg.probes).concat(DEFAULT_RUNTIME_PROBES),
  )
  if (!existsAll(runtimeHome, requiredProbeUnion)) {
    return {
      ok: false,
      reason: `Managed runtime probes missing after install: ${requiredProbeUnion.join(', ')}`,
      pythonCandidates: [],
      nodePath: null,
      playwrightBrowsersPath: null,
      toolsPathEntries: [],
    }
  }

  saveRuntimeLock(lockPath, {
    appVersion,
    arch: process.arch,
    requiredProbes: requiredProbeUnion,
    installedPackages: manifest.packages.map((pkg) => ({
      name: pkg.name,
      file: pkg.file,
      sha256: pkg.sha256,
      required: pkg.required,
    })),
    generatedAt: new Date().toISOString(),
  })

  try {
    if (existsSync(downloadDir)) {
      const downloadFiles = readdirSync(downloadDir)
      if (downloadFiles.length === 0) {
        rmSync(downloadDir, { recursive: true, force: true })
      }
    }
  } catch {
    // keep download cache on cleanup failure
  }

  log('info', `[Runtime Bootstrap] Managed runtime ready: ${runtimeHome}`)
  return runtimePaths(runtimeHome)
}





