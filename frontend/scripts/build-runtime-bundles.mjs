import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = 'true'
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function fileSha256(filePath) {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function runTar(archivePath, sourceRoot, entries) {
  const result = spawnSync('tar', ['-czf', archivePath, '-C', sourceRoot, ...entries], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`tar failed with status ${result.status} for ${archivePath}`)
  }
}

function hasFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return false
  const entries = fs.readdirSync(dirPath)
  return entries.length > 0
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, '..', '..')

  const args = parseArgs(process.argv.slice(2))
  const platform = args.platform || process.platform
  const arch = args.arch || process.arch
  const runtimeRoot = path.resolve(args['runtime-root'] || path.join(repoRoot, 'runtime'))
  const outDir = path.resolve(args['out-dir'] || path.join(repoRoot, 'frontend', 'release', 'runtime-assets'))

  const pkgPath = path.join(repoRoot, 'frontend', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const appVersion = args['app-version'] || pkg.version

  if (!appVersion) {
    throw new Error('app-version is required')
  }

  const requiredEntries = ['python', 'node', 'playwright-browsers']
  const missing = requiredEntries.filter((entry) => !hasFiles(path.join(runtimeRoot, entry)))
  if (missing.length > 0) {
    throw new Error(`runtime root missing required entries: ${missing.join(', ')}`)
  }

  ensureDir(outDir)

  const packages = []

  const coreArchiveName = `core-runtime-${platform}-${arch}.tar.gz`
  const coreArchivePath = path.join(outDir, coreArchiveName)
  if (fs.existsSync(coreArchivePath)) {
    fs.rmSync(coreArchivePath, { force: true })
  }
  runTar(coreArchivePath, runtimeRoot, requiredEntries)

  const coreSize = fs.statSync(coreArchivePath).size
  const coreSha = await fileSha256(coreArchivePath)
  packages.push({
    name: 'core-runtime',
    file: coreArchiveName,
    sha256: coreSha,
    size: coreSize,
    required: true,
    probes: ['python/bin/python3', 'node/bin/node', 'playwright-browsers'],
  })

  const toolsRoot = path.join(runtimeRoot, 'tools')
  if (hasFiles(toolsRoot)) {
    const toolsArchiveName = `tools-runtime-${platform}-${arch}.tar.gz`
    const toolsArchivePath = path.join(outDir, toolsArchiveName)
    if (fs.existsSync(toolsArchivePath)) {
      fs.rmSync(toolsArchivePath, { force: true })
    }
    runTar(toolsArchivePath, runtimeRoot, ['tools'])

    const toolsSize = fs.statSync(toolsArchivePath).size
    const toolsSha = await fileSha256(toolsArchivePath)
    packages.push({
      name: 'tools-runtime',
      file: toolsArchiveName,
      sha256: toolsSha,
      size: toolsSize,
      required: false,
      probes: ['tools'],
    })
  }

  const manifestName = `runtime-manifest-${platform}-${arch}.json`
  const manifestPath = path.join(outDir, manifestName)
  const manifest = {
    appVersion,
    platform,
    arch,
    generatedAt: new Date().toISOString(),
    packages,
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const checksumName = `runtime-checksums-${platform}-${arch}.sha256`
  const checksumPath = path.join(outDir, checksumName)
  const checksumLines = []
  for (const pkgSpec of packages) {
    checksumLines.push(`${pkgSpec.sha256}  ${pkgSpec.file}`)
  }
  const manifestSha = await fileSha256(manifestPath)
  checksumLines.push(`${manifestSha}  ${manifestName}`)
  fs.writeFileSync(checksumPath, `${checksumLines.join('\n')}\n`, 'utf8')

  console.log(`[build:runtime-bundles] OK appVersion=${appVersion} platform=${platform} arch=${arch}`)
  console.log(`[build:runtime-bundles] output=${outDir}`)
}

main().catch((error) => {
  console.error(`[build:runtime-bundles] Failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

