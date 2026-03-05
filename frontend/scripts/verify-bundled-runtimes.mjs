import fs from 'fs'
import path from 'path'
import process from 'process'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..', '..')
const runtimeRoot = path.join(projectRoot, 'runtime')
const mcpRoot = path.join(projectRoot, 'mcp-servers')

function exists(filePath) {
  return fs.existsSync(filePath)
}

function fail(message) {
  console.error(`\n[verify:runtimes] ${message}`)
  process.exit(1)
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

function verifyBundledPythonLayout() {
  if (process.platform !== 'win32') {
    return
  }

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
}

function verifyRuntimeFiles() {
  const expected = getExpectedRuntimePaths()
  const pythonPath = expected.pythonCandidates.find(exists)
  if (!pythonPath) {
    fail(
      `Missing bundled Python runtime. Checked: ${expected.pythonCandidates.join(', ')}`,
    )
  }
  if (!exists(expected.node)) {
    fail(`Missing bundled Node runtime: ${expected.node}`)
  }

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

  const nodeRoot = path.dirname(nodePath)
  const nodeModules = path.join(nodeRoot, 'node_modules')
  if (!exists(nodeModules)) {
    fail(`Missing bundled Node modules directory: ${nodeModules}`)
  }

  const requiredPackages = ['pptxgenjs', 'playwright', 'sharp', 'react', 'react-dom', 'react-icons']
  const missingPackages = requiredPackages.filter(
    (pkg) => !exists(path.join(nodeModules, pkg, 'package.json')),
  )
  if (missingPackages.length > 0) {
    fail(
      `Missing bundled Node skill dependencies under ${nodeModules}: ${missingPackages.join(', ')}`,
    )
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
    fail(
      `Bundled Node dependency resolve probe failed for ${nodePath}.\nstdout: ${stdout}\nstderr: ${stderr}`,
    )
  }
}

function verifyBundledPythonDependencies() {
  const expected = getExpectedRuntimePaths()
  const pythonPath = expected.pythonCandidates.find(exists)
  if (!pythonPath) {
    fail(
      `Missing bundled Python runtime. Checked: ${expected.pythonCandidates.join(', ')}`,
    )
  }

  const probe = spawnSync(
    pythonPath,
    ['-c', 'import fastapi,uvicorn,openai,yaml,fastmcp,tiktoken,sse_starlette,httpx,defusedxml,lxml,pypdf,pdfplumber,reportlab,pytesseract,pdf2image,PIL,pptx,openpyxl,pandas,numpy; print("ok")'],
    {
      cwd: projectRoot,
      stdio: 'pipe',
      windowsHide: true,
      timeout: 12000,
    },
  )

  if (probe.error || probe.status !== 0) {
    const stderr = (probe.stderr || '').toString().trim()
    const stdout = (probe.stdout || '').toString().trim()
    fail(
      `Bundled Python dependency probe failed for ${pythonPath}.\nstdout: ${stdout}\nstderr: ${stderr}`,
    )
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
    const message = `Required bundled tools missing under ${toolsRoot}: ${missingRequired.join(', ')}`
    if (strictTools) {
      fail(message)
    }
    console.warn(`[verify:runtimes] Warning: ${message}`)
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
      fail(`Bundled tool probe failed for ${item.tool} at ${item.executable}: ${String(probe.error)}`)
    }
    if (probe.status === null) {
      fail(`Bundled tool probe timed out for ${item.tool} at ${item.executable}`)
    }
    if (probe.status !== 0) {
      const stderr = (probe.stderr || '').toString().trim()
      const stdout = (probe.stdout || '').toString().trim()
      fail(`Bundled tool probe returned non-zero (${probe.status}) for ${item.tool} at ${item.executable}. stdout: ${stdout} stderr: ${stderr}`)
    }
  }
}
function verifyMcpLocalEntrypoints() {
  const requiredChecks = [
    path.join(mcpRoot, 'open-websearch', 'node_modules', 'open-websearch', 'build', 'index.js'),
    path.join(mcpRoot, 'playwright', 'node_modules', '@playwright', 'mcp', 'cli.js'),
  ]

  for (const filePath of requiredChecks) {
    if (!exists(filePath)) {
      fail(`Missing MCP local entrypoint: ${filePath}`)
    }
  }

  // Optional: rednote can be absent in some repos (e.g. gitlink without submodule mapping).
  const rednoteRoot = path.join(mcpRoot, 'rednote')
  if (exists(rednoteRoot)) {
    const rednoteEntrypoint = path.join(rednoteRoot, 'dist', 'index.js')
    if (!exists(rednoteEntrypoint)) {
      console.warn(`[verify:runtimes] Warning: rednote exists but entrypoint missing: ${rednoteEntrypoint}`)
    }
  }
}

verifyBundledPythonLayout()
verifyRuntimeFiles()
verifyBundledNodeSkillDependencies()
verifyBundledPythonDependencies()
verifyBundledTools()
verifyMcpLocalEntrypoints()
console.log('[verify:runtimes] OK: bundled Python/Node/tools, skill JS dependencies, and MCP local entrypoints are present.')


