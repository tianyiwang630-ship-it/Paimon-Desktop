import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import process from 'process'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..', '..')
const runtimeRoot = path.join(projectRoot, 'runtime')
const mcpRoot = path.join(projectRoot, 'mcp-servers')
const frontendPackageJsonPath = path.join(projectRoot, 'frontend', 'package.json')
const defaultAppVersion = fs.existsSync(frontendPackageJsonPath)
  ? JSON.parse(fs.readFileSync(frontendPackageJsonPath, 'utf-8')).version || 'unknown'
  : 'unknown'

function exists(filePath) {
  return fs.existsSync(filePath)
}

function fail(message) {
  console.error(`\n[verify:runtimes] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    appPath: null,
    appVersion: defaultAppVersion,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--app') {
      index += 1
      options.appPath = argv[index] || null
    } else if (current === '--app-version') {
      index += 1
      options.appVersion = argv[index] || options.appVersion
    } else {
      fail(`Unknown argument: ${current}`)
    }
  }

  if (argv.includes('--app') && !options.appPath) {
    fail('Missing value after --app')
  }

  return options
}

function isWithinRoot(candidatePath, allowedRoot) {
  const normalizedCandidate = path.resolve(candidatePath)
  const normalizedRoot = path.resolve(allowedRoot)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
}

function walkDirectories(rootDir) {
  const queue = [rootDir]
  const allDirs = []

  while (queue.length > 0) {
    const current = queue.pop()
    allDirs.push(current)

    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name))
      }
    }
  }

  return allDirs
}

function findExecutableInTree(rootDir, executableNames) {
  const candidates = executableNames.map((name) => name.toLowerCase())
  const dirs = walkDirectories(rootDir)
  for (const dir of dirs) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (candidates.includes(entry.name.toLowerCase())) {
        return path.join(dir, entry.name)
      }
    }
  }
  return null
}

function getExpectedRuntimePaths() {
  if (process.platform === 'win32') {
    return {
      pythonCandidates: [
        path.join(runtimeRoot, 'python', 'python.exe'),
        path.join(runtimeRoot, 'python', 'Scripts', 'python.exe'),
        path.join(runtimeRoot, 'python', 'bin', 'python.exe'),
      ],
      node: path.join(runtimeRoot, 'node', 'node.exe'),
    }
  }
  return {
    pythonCandidates: [
      path.join(runtimeRoot, 'python', 'bin', 'python3'),
      path.join(runtimeRoot, 'python', 'python3'),
    ],
    node: path.join(runtimeRoot, 'node', 'bin', 'node'),
  }
}

function getBundledNodeRoot(nodePath) {
  const nodeDir = path.dirname(nodePath)
  if (process.platform !== 'win32' && path.basename(nodeDir) === 'bin') {
    return path.dirname(nodeDir)
  }
  return nodeDir
}

function getBundledRuntimeRootFromExecutable(executablePath) {
  const executableDir = path.dirname(executablePath)
  const dirName = path.basename(executableDir).toLowerCase()
  if (dirName === 'bin' || dirName === 'scripts') {
    return path.dirname(executableDir)
  }
  return executableDir
}

function getBundledPythonPathEntries(pythonExe) {
  const entries = []
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

function getPlaywrightBrowsersRoot() {
  return path.join(runtimeRoot, 'playwright-browsers')
}

function getPlaywrightMcpCliPath() {
  return path.join(mcpRoot, 'playwright', 'node_modules', '@playwright', 'mcp', 'cli.js')
}

function getPlaywrightLaunchProbeScript() {
  return `
const { chromium } = require('playwright');
(async () => {
  const executablePath = process.env.PLAYWRIGHT_PROBE_EXECUTABLE_PATH;
  if (!executablePath) {
    throw new Error('Missing PLAYWRIGHT_PROBE_EXECUTABLE_PATH');
  }
  const browser = await chromium.launch({ headless: true, executablePath });
  await browser.close();
  console.log('ok');
})().catch((error) => {
  const text = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  console.error(text);
  process.exit(1);
});
`.trim()
}

function runPlaywrightLaunchProbe({
  nodePath,
  browsersRoot,
  mcpCliPath,
  label,
  nodeAllowedRoot = null,
  browsersAllowedRoot = null,
}) {
  verifyExecutablePath(nodePath, `${label} Node runtime`, nodeAllowedRoot)

  if (!exists(browsersRoot)) {
    fail(`${label} Playwright browsers directory missing: ${browsersRoot}`)
  }
  const browserEntries = fs
    .readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  if (browserEntries.length === 0) {
    fail(`${label} Playwright browsers directory is empty: ${browsersRoot}`)
  }

  if (!exists(mcpCliPath)) {
    fail(`${label} Playwright MCP entrypoint missing: ${mcpCliPath}`)
  }

  const chromiumExecutable = findBundledChromiumExecutable(browsersRoot)
  if (!chromiumExecutable) {
    fail(`${label} Playwright Chromium executable not found under: ${browsersRoot}`)
  }
  verifyExecutablePath(chromiumExecutable, `${label} Chromium executable`, browsersAllowedRoot || browsersRoot)

  const nodeRoot = getBundledNodeRoot(nodePath)
  const nodeModules = path.join(nodeRoot, 'node_modules')
  const probe = spawnSync(nodePath, ['-e', getPlaywrightLaunchProbeScript()], {
    cwd: nodeRoot,
    stdio: 'pipe',
    windowsHide: true,
    timeout: 45000,
    env: {
      ...process.env,
      NODE_PATH: nodeModules,
      PLAYWRIGHT_BROWSERS_PATH: browsersRoot,
      SKILLS_MCP_PLAYWRIGHT_BROWSERS: browsersRoot,
      PLAYWRIGHT_PROBE_EXECUTABLE_PATH: chromiumExecutable,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  })

  if (probe.error || probe.status !== 0) {
    const stderr = (probe.stderr || '').toString().trim()
    const stdout = (probe.stdout || '').toString().trim()
    fail(
      `${label} Playwright launch probe failed.\nnode: ${nodePath}\nbrowsers: ${browsersRoot}\nchromium: ${chromiumExecutable}\nmcp: ${mcpCliPath}\nstdout: ${stdout}\nstderr: ${stderr}`,
    )
  }
}

function getPythonDependencyProbeScript() {
  return 'import fastapi,uvicorn,openai,yaml,fastmcp,tiktoken,sse_starlette,httpx,defusedxml,lxml,pypdf,pdfplumber,reportlab,pytesseract,pdf2image,PIL,pptx,openpyxl,pandas,numpy; print("ok")'
}

function inspectPath(filePath) {
  let stats
  try {
    stats = fs.lstatSync(filePath)
  } catch (error) {
    const nodeErr = error
    if (nodeErr && nodeErr.code === 'ENOENT') {
      return {
        exists: false,
        filePath,
        isSymlink: false,
        brokenSymlink: false,
        realPath: null,
        error: null,
      }
    }
    throw error
  }

  const result = {
    exists: true,
    filePath,
    isSymlink: stats.isSymbolicLink(),
    brokenSymlink: false,
    realPath: path.resolve(filePath),
    error: null,
  }

  if (result.isSymlink) {
    try {
      result.realPath = fs.realpathSync(filePath)
    } catch (error) {
      const nodeErr = error
      result.brokenSymlink = true
      result.error = nodeErr && nodeErr.message ? nodeErr.message : String(error)
      result.realPath = null
    }
  }

  return result
}

function verifyExecutablePath(filePath, label, allowedRoot = null) {
  const info = inspectPath(filePath)
  if (!info.exists) {
    fail(`${label} missing: ${filePath}`)
  }
  if (info.brokenSymlink) {
    fail(`${label} is a broken symlink: ${filePath}. ${info.error || ''}`.trim())
  }
  if (allowedRoot && info.realPath && !isWithinRoot(info.realPath, allowedRoot)) {
    fail(`${label} resolves outside allowed root.\npath: ${filePath}\nrealpath: ${info.realPath}\nallowed root: ${allowedRoot}`)
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
  } catch (error) {
    fail(`${label} is not executable: ${filePath} (${String(error)})`)
  }
  return info
}

function reportToolIssue(message, strictTools) {
  if (process.platform === 'win32' && strictTools) {
    fail(message)
  }
  console.warn(`[verify:runtimes] Warning: ${message}`)
}

function verifyBundledPythonLayout() {
  if (process.platform === 'win32') {
    const rootPython = path.join(runtimeRoot, 'python', 'python.exe')
    if (!exists(rootPython)) {
      fail(`Bundled python runtime must contain python.exe at runtime/python/python.exe. Missing: ${rootPython}`)
    }

    const pyvenvCfg = path.join(runtimeRoot, 'python', 'pyvenv.cfg')
    if (!exists(pyvenvCfg)) {
      return
    }

    let cfgText = ''
    try {
      cfgText = fs.readFileSync(pyvenvCfg, 'utf-8')
    } catch {
      return
    }

    if (/^\s*home\s*=\s*/im.test(cfgText)) {
      fail(
        `runtime/python looks like a machine-bound venv (found pyvenv.cfg with home=...). Use a portable Python runtime instead of venv. File: ${pyvenvCfg}`,
      )
    }
    return
  }

  const pythonRoot = path.join(runtimeRoot, 'python')
  const pythonPath = path.join(pythonRoot, 'bin', 'python3')
  verifyExecutablePath(pythonPath, 'Bundled Python runtime', pythonRoot)
}

function verifyRuntimeFiles() {
  const expected = getExpectedRuntimePaths()
  const pythonPath = expected.pythonCandidates.find(exists)
  if (!pythonPath) {
    fail(`Missing bundled Python runtime. Checked: ${expected.pythonCandidates.join(', ')}`)
  }
  verifyExecutablePath(pythonPath, 'Bundled Python runtime', path.join(runtimeRoot, 'python'))
  verifyExecutablePath(expected.node, 'Bundled Node runtime', path.join(runtimeRoot, 'node'))

  const browsersRoot = path.join(runtimeRoot, 'playwright-browsers')
  if (!exists(browsersRoot)) {
    fail(`Missing bundled Playwright browsers directory: ${browsersRoot}`)
  }

  const browserEntries = fs
    .readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  if (browserEntries.length === 0) {
    fail(`Bundled Playwright browsers directory is empty: ${browsersRoot}`)
  }
}

function verifyBundledNodeSkillDependencies() {
  const expected = getExpectedRuntimePaths()
  const nodePath = expected.node
  if (!exists(nodePath)) {
    fail(`Missing bundled Node runtime: ${nodePath}`)
  }

  const nodeRoot = getBundledNodeRoot(nodePath)
  const nodeModules = path.join(nodeRoot, 'node_modules')
  if (!exists(nodeModules)) {
    fail(`Missing bundled Node modules directory: ${nodeModules}`)
  }

  const requiredPackages = ['pptxgenjs', 'playwright', 'sharp', 'react', 'react-dom', 'react-icons']
  const missingPackages = requiredPackages.filter((pkg) => !exists(path.join(nodeModules, pkg, 'package.json')))
  if (missingPackages.length > 0) {
    fail(`Missing bundled Node skill dependencies under ${nodeModules}: ${missingPackages.join(', ')}`)
  }

  const resolveProbeScript = `
const required = ${JSON.stringify(requiredPackages)};
const unresolved = [];
for (const pkg of required) {
  try {
    require.resolve(pkg);
  } catch (error) {
    unresolved.push(\`\${pkg}: \${error && error.message ? error.message : String(error)}\`);
  }
}
if (unresolved.length > 0) {
  console.error(unresolved.join('\\n'));
  process.exit(1);
}
`.trim()

  const probe = spawnSync(nodePath, ['-e', resolveProbeScript], {
    cwd: nodeRoot,
    stdio: 'pipe',
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      NODE_PATH: nodeModules,
    },
  })

  if (probe.error || probe.status !== 0) {
    const stderr = (probe.stderr || '').toString().trim()
    const stdout = (probe.stdout || '').toString().trim()
    fail(`Bundled Node dependency resolve probe failed for ${nodePath}.\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
}

function verifyBundledPythonDependencies() {
  const expected = getExpectedRuntimePaths()
  const pythonPath = expected.pythonCandidates.find(exists)
  if (!pythonPath) {
    fail(`Missing bundled Python runtime. Checked: ${expected.pythonCandidates.join(', ')}`)
  }

  const probe = spawnSync(pythonPath, ['-c', getPythonDependencyProbeScript()], {
    cwd: projectRoot,
    stdio: 'pipe',
    windowsHide: true,
    timeout: 20000,
    env: {
      ...process.env,
      PYTHONNOUSERSITE: '1',
      PIP_USER: '0',
    },
  })

  if (probe.error || probe.status !== 0) {
    const stderr = (probe.stderr || '').toString().trim()
    const stdout = (probe.stdout || '').toString().trim()
    fail(`Bundled Python dependency probe failed for ${pythonPath}.\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
}

function verifyBundledTools() {
  const toolsRoot = path.join(runtimeRoot, 'tools')
  const strictTools = process.env.SKILLS_MCP_VERIFY_TOOLS_STRICT === '1'

  if (!exists(toolsRoot)) {
    if (strictTools) {
      fail(`Missing bundled tools directory: ${toolsRoot}`)
    }
    console.warn(`[verify:runtimes] Warning: bundled tools directory missing: ${toolsRoot}`)
    return
  }

  const toolSpecs =
    process.platform === 'win32'
      ? [
          { name: 'pandoc', executables: ['pandoc.exe'], required: true },
          { name: 'tesseract', executables: ['tesseract.exe'], required: false },
          { name: 'pdftk', executables: ['pdftk.exe'], required: false },
          { name: 'qpdf', executables: ['qpdf.exe'], required: false },
        ]
      : [
          { name: 'pandoc', executables: ['pandoc'], required: true },
          { name: 'tesseract', executables: ['tesseract'], required: false },
          { name: 'pdftk', executables: ['pdftk'], required: false },
          { name: 'qpdf', executables: ['qpdf'], required: false },
        ]

  const missingRequired = []
  const missingOptional = []
  const foundExecutables = []

  for (const spec of toolSpecs) {
    const found = findExecutableInTree(toolsRoot, spec.executables)
    if (!found) {
      if (spec.required) {
        missingRequired.push(`${spec.name} (${spec.executables.join('/')})`)
      } else {
        missingOptional.push(`${spec.name} (${spec.executables.join('/')})`)
      }
      continue
    }
    foundExecutables.push({ tool: spec.name, executable: found })
  }

  if (missingRequired.length > 0) {
    reportToolIssue(`Required bundled tools missing under ${toolsRoot}: ${missingRequired.join(', ')}`, strictTools)
  }

  if (missingOptional.length > 0) {
    console.warn(`[verify:runtimes] Warning: optional bundled tools missing under ${toolsRoot}: ${missingOptional.join(', ')}`)
  }

  const defaultProbeArgs =
    process.platform === 'win32'
      ? {
          'pandoc.exe': ['--version'],
          'tesseract.exe': ['--version'],
          'pdftk.exe': ['--version'],
          'qpdf.exe': ['--version'],
        }
      : {
          pandoc: ['--version'],
          tesseract: ['--version'],
          pdftk: ['--version'],
          qpdf: ['--version'],
        }

  for (const item of foundExecutables) {
    const exeName = path.basename(item.executable)
    const probeArgs = defaultProbeArgs[exeName] || ['--version']
    const probe = spawnSync(item.executable, probeArgs, {
      cwd: projectRoot,
      stdio: 'pipe',
      windowsHide: true,
      timeout: 15000,
    })

    if (probe.error) {
      reportToolIssue(`Bundled tool probe failed for ${item.tool} at ${item.executable}: ${String(probe.error)}`, strictTools)
      continue
    }
    if (probe.status === null) {
      reportToolIssue(`Bundled tool probe timed out for ${item.tool} at ${item.executable}`, strictTools)
      continue
    }
    if (probe.status !== 0) {
      const stderr = (probe.stderr || '').toString().trim()
      const stdout = (probe.stdout || '').toString().trim()
      reportToolIssue(
        `Bundled tool probe returned non-zero (${probe.status}) for ${item.tool} at ${item.executable}. stdout: ${stdout} stderr: ${stderr}`,
        strictTools,
      )
    }
  }
}

function verifyMcpLocalEntrypoints() {
  const requiredChecks = [
    path.join(mcpRoot, 'open-websearch', 'node_modules', 'open-websearch', 'build', 'index.js'),
    getPlaywrightMcpCliPath(),
  ]

  for (const filePath of requiredChecks) {
    if (!exists(filePath)) {
      fail(`Missing MCP local entrypoint: ${filePath}`)
    }
  }

  const rednoteRoot = path.join(mcpRoot, 'rednote')
  if (exists(rednoteRoot)) {
    const rednoteEntrypoint = path.join(rednoteRoot, 'dist', 'index.js')
    if (!exists(rednoteEntrypoint)) {
      console.warn(`[verify:runtimes] Warning: rednote exists but entrypoint missing: ${rednoteEntrypoint}`)
    }
  }
}

function findBundledChromiumExecutable(browsersRoot) {
  const names =
    process.platform === 'win32'
      ? ['chrome.exe']
      : process.platform === 'darwin'
        ? ['Chromium', 'Google Chrome for Testing', 'Google Chrome']
        : ['chrome', 'chromium', 'chromium-browser']
  return findExecutableInTree(browsersRoot, names)
}

function verifyBundledPlaywrightLaunchProbe() {
  const expected = getExpectedRuntimePaths()
  runPlaywrightLaunchProbe({
    nodePath: expected.node,
    browsersRoot: getPlaywrightBrowsersRoot(),
    mcpCliPath: getPlaywrightMcpCliPath(),
    label: 'Bundled',
    nodeAllowedRoot: path.join(runtimeRoot, 'node'),
    browsersAllowedRoot: path.join(runtimeRoot, 'playwright-browsers'),
  })
}

function getPackagedMacPaths(appPath) {
  const resourcesRoot = path.join(appPath, 'Contents', 'Resources')
  return {
    resourcesRoot,
    pythonPath: path.join(resourcesRoot, 'python', 'bin', 'python3'),
    nodePath: path.join(resourcesRoot, 'node', 'bin', 'node'),
    backendScript: path.join(resourcesRoot, 'agent', 'server', 'app.py'),
    browsersRoot: path.join(resourcesRoot, 'playwright-browsers'),
    mcpCliPath: path.join(resourcesRoot, 'mcp-servers', 'playwright', 'node_modules', '@playwright', 'mcp', 'cli.js'),
  }
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve verification port')))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

function httpGetJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(urlString, { timeout: timeoutMs }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        text += chunk
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Unexpected status ${response.statusCode}: ${text}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`))
    })
    request.on('error', reject)
  })
}

async function waitForBackendHealth(urlString, expectedAppId, expectedAppVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'health check did not start'

  while (Date.now() < deadline) {
    try {
      const payload = await httpGetJson(urlString, 2000)
      if (payload && payload.status === 'ok' && payload.app_id === expectedAppId && payload.app_version === expectedAppVersion) {
        return
      }
      lastError = `Unexpected payload: ${JSON.stringify(payload)}`
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Backend health check timed out after ${timeoutMs}ms. Last error: ${lastError}`)
}

async function verifyPackagedBackendStartup(appPath, appVersion) {
  const expectedAppId = 'com.skills-mcp.desktop'
  const packaged = getPackagedMacPaths(appPath)
  const port = await reserveLoopbackPort()
  const origin = `http://127.0.0.1:${port}`
  const healthUrl = `${origin}/api/health`
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paimon-macos-app-verify-'))
  const runtimeRoot = path.join(verifyRoot, 'workspace-root')
  const dataRoot = path.join(verifyRoot, 'data-root')
  const homeDir = path.join(dataRoot, 'home')
  const appDataDir = path.join(dataRoot, 'electron', 'appData')
  const cacheDir = path.join(dataRoot, 'electron', 'cache')
  const tempDir = path.join(dataRoot, 'tmp')
  const xdgDataDir = path.join(dataRoot, 'xdg', 'data')
  const xdgStateDir = path.join(dataRoot, 'xdg', 'state')

  for (const dir of [runtimeRoot, homeDir, appDataDir, cacheDir, tempDir, xdgDataDir, xdgStateDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const env = {
    ...process.env,
    SKILLS_MCP_RUNTIME_ROOT: runtimeRoot,
    SKILLS_MCP_DATA_ROOT: dataRoot,
    SKILLS_MCP_PYTHON: packaged.pythonPath,
    SKILLS_MCP_NODE: packaged.nodePath,
    SKILLS_MCP_PLAYWRIGHT_BROWSERS: packaged.browsersRoot,
    PLAYWRIGHT_BROWSERS_PATH: packaged.browsersRoot,
    SKILLS_MCP_BACKEND_HOST: '127.0.0.1',
    SKILLS_MCP_BACKEND_PORT: String(port),
    SKILLS_MCP_BACKEND_APP_ID: expectedAppId,
    SKILLS_MCP_BACKEND_APP_VERSION: appVersion,
    PYTHONNOUSERSITE: '1',
    PIP_USER: '0',
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: appDataDir,
    LOCALAPPDATA: cacheDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    XDG_CONFIG_HOME: appDataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_DATA_HOME: xdgDataDir,
    XDG_STATE_HOME: xdgStateDir,
  }

  for (const p of getBundledPythonPathEntries(packaged.pythonPath)) {
    if (exists(p)) {
      env.PATH = env.PATH ? `${p}${path.delimiter}${env.PATH}` : p
    }
  }
  if (exists(packaged.nodePath)) {
    const nodeDir = path.dirname(packaged.nodePath)
    env.PATH = env.PATH ? `${nodeDir}${path.delimiter}${env.PATH}` : nodeDir
    const nodeRoot = getBundledNodeRoot(packaged.nodePath)
    const nodeModules = path.join(nodeRoot, 'node_modules')
    env.NODE_PATH = env.NODE_PATH ? `${nodeModules}${path.delimiter}${env.NODE_PATH}` : nodeModules
  }

  const child = spawn(packaged.pythonPath, ['-s', packaged.backendScript], {
    cwd: runtimeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  let spawnError = null
  child.on('error', (error) => {
    spawnError = error
  })

  try {
    await waitForBackendHealth(healthUrl, expectedAppId, appVersion, 30000)
  } catch (error) {
    try {
      child.kill('SIGTERM')
    } catch {}
    fail(
      `Packaged backend health probe failed for ${appPath}.\npython: ${packaged.pythonPath}\nbackend: ${packaged.backendScript}\nhealth: ${healthUrl}\nspawnError: ${
        spawnError ? String(spawnError) : '(none)'
      }\nstdout: ${stdout.trim()}\nstderr: ${stderr.trim()}\nreason: ${error && error.message ? error.message : String(error)}`,
    )
  }

  try {
    child.kill('SIGTERM')
  } catch {}
}

async function verifyPackagedMacApp(appPath, appVersion) {
  if (process.platform !== 'darwin') {
    fail(`--app verification is only supported on macOS runners. Current platform: ${process.platform}`)
  }
  if (!exists(appPath)) {
    fail(`Packaged app not found: ${appPath}`)
  }

  const packaged = getPackagedMacPaths(appPath)
  const pythonRoot = path.join(packaged.resourcesRoot, 'python')
  verifyExecutablePath(packaged.pythonPath, 'Packaged app Python runtime', pythonRoot)
  verifyExecutablePath(packaged.nodePath, 'Packaged app Node runtime', path.join(packaged.resourcesRoot, 'node'))

  if (!exists(packaged.backendScript)) {
    fail(`Packaged backend script missing: ${packaged.backendScript}`)
  }

  const importProbe = spawnSync(packaged.pythonPath, ['-c', getPythonDependencyProbeScript()], {
    cwd: packaged.resourcesRoot,
    stdio: 'pipe',
    timeout: 20000,
    env: {
      ...process.env,
      PYTHONNOUSERSITE: '1',
      PIP_USER: '0',
    },
  })
  if (importProbe.error || importProbe.status !== 0) {
    const stderr = (importProbe.stderr || '').toString().trim()
    const stdout = (importProbe.stdout || '').toString().trim()
    fail(`Packaged app Python dependency probe failed for ${packaged.pythonPath}.\nstdout: ${stdout}\nstderr: ${stderr}`)
  }

  runPlaywrightLaunchProbe({
    nodePath: packaged.nodePath,
    browsersRoot: packaged.browsersRoot,
    mcpCliPath: packaged.mcpCliPath,
    label: 'Packaged app',
    nodeAllowedRoot: path.join(packaged.resourcesRoot, 'node'),
    browsersAllowedRoot: path.join(packaged.resourcesRoot, 'playwright-browsers'),
  })

  await verifyPackagedBackendStartup(appPath, appVersion)
  console.log(`[verify:runtimes] OK: packaged mac app verified: ${appPath}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  verifyBundledPythonLayout()
  verifyRuntimeFiles()
  verifyBundledNodeSkillDependencies()
  verifyBundledPythonDependencies()
  verifyBundledTools()
  verifyMcpLocalEntrypoints()
  verifyBundledPlaywrightLaunchProbe()
  console.log('[verify:runtimes] OK: bundled Python/Node/tools, skill JS dependencies, MCP local entrypoints, and Playwright launch probe are present.')

  if (options.appPath) {
    await verifyPackagedMacApp(path.resolve(options.appPath), options.appVersion || defaultAppVersion)
  }
}

await main()
