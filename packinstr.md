# Paimon Desktop Packaging Instructions (Windows EXE, x64 + arm64)

## Scope

This document describes how to package this project into Windows installer EXEs with a reproducible process.

Included in scope:

- Build installer EXE only (NSIS target)
- Build x64 and arm64 separately
- Avoid output overwrite by using separate release folders and timestamped final copies
- Include bundled runtimes and assets:
  - Python runtime
  - Node runtime
  - Playwright browser assets
  - MCP servers
  - Runtime tools

Out of scope:

- MSI packaging
- Code signing
- macOS/Linux packaging

## Packaging-Relevant Architecture (Calling Chain)

1. Electron main process boots from `frontend/src/main/index.ts`.
2. In packaged mode, Electron launches bundled Python backend:
   - script path: `resources/agent/server/app.py`
3. Backend loads MCP servers from bundled assets:
   - root: `resources/mcp-servers`
4. Electron injects runtime-related env vars for backend:
   - bundled Node runtime path (`resources/node/...`)
   - runtime Playwright browsers path (`D:\PaimonData\Local\ms-playwright` on Windows)
   - optional bundled Playwright browser seed assets (`resources/playwright-browsers`)
5. Runtime writable roots are constrained under `D:\PaimonData` on Windows by design.

Bundled assets are defined in `frontend/package.json` under `build.extraResources`:

- `../agent` -> `resources/agent`
- `../skills` -> `resources/skills`
- `../mcp-servers` -> `resources/mcp-servers`
- `../runtime/python` -> `resources/python`
- `../runtime/node` -> `resources/node`
- `../runtime/playwright-browsers` -> `resources/playwright-browsers`
- `../runtime/tools` -> `resources/tools`

## Preconditions

- OS: Windows
- Node.js and npm available on build machine
- Runtime Python exists at `runtime/python/python.exe`
- Repository has required MCP server states:
  - `mcp-servers/playwright` dependencies installed
  - `mcp-servers/rednote` has `dist` and `node_modules` if rednote is part of your release
- Build from repository root with PowerShell

## Full Packaging Flow (Command Steps)

### Step A: Define paths

```powershell
$ErrorActionPreference = 'Stop'
$RepoRoot = "D:\files\demo\desk project-Paimon\paimon-desk-assistant"
$FrontendDir = Join-Path $RepoRoot "frontend"
$RuntimePy = Join-Path $RepoRoot "runtime\python\python.exe"
$ReqRuntime = Join-Path $RepoRoot "requirements-runtime.txt"
$WindowsOutRoot = Join-Path $RepoRoot "windows"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RunOut = Join-Path $WindowsOutRoot $stamp
$X64Out = Join-Path $RunOut "x64"
$Arm64Out = Join-Path $RunOut "arm64"
New-Item -ItemType Directory -Force -Path $X64Out, $Arm64Out | Out-Null
```

### Step B: Ensure runtime Python dependencies

```powershell
if (-not (Test-Path -LiteralPath $RuntimePy)) { throw "Missing runtime python: $RuntimePy" }
if (-not (Test-Path -LiteralPath $ReqRuntime)) { throw "Missing requirements file: $ReqRuntime" }

& $RuntimePy -m pip --isolated install --no-user --upgrade pip setuptools wheel
& $RuntimePy -m pip --isolated install --no-user -r $ReqRuntime
```

### Step C: Prepare and verify bundled runtimes

```powershell
Push-Location $FrontendDir
npm run prepare:runtimes
npm run verify:runtimes
Pop-Location
```

### Step D: Build Electron main + renderer

```powershell
Push-Location $FrontendDir
npm run build:main
npm run build:renderer
Pop-Location
```

### Step E: Package x64 (isolated output dir)

```powershell
Push-Location $FrontendDir
if (Test-Path .\release-x64) { Remove-Item .\release-x64 -Recurse -Force }
npx electron-builder --win nsis --x64 --publish never --config.directories.output=release-x64
Pop-Location
```

### Step F: Package arm64 (isolated output dir)

```powershell
Push-Location $FrontendDir
if (Test-Path .\release-arm64) { Remove-Item .\release-arm64 -Recurse -Force }
npx electron-builder --win nsis --arm64 --publish never --config.directories.output=release-arm64
Pop-Location
```

### Step G: Copy installer EXE only into timestamped output (no overwrite)

```powershell
$ReleaseX64 = Join-Path $FrontendDir "release-x64"
$ReleaseArm64 = Join-Path $FrontendDir "release-arm64"

$x64Exe = Get-ChildItem -Path $ReleaseX64 -Recurse -File -Filter *.exe |
  Where-Object { $_.Name -notmatch '^(uninstall|unins)' } |
  Select-Object -First 1
if (-not $x64Exe) { throw "x64 exe not found in $ReleaseX64" }
Copy-Item -LiteralPath $x64Exe.FullName -Destination (Join-Path $X64Out "Paimon-x64.exe") -Force:$false

$arm64Exe = Get-ChildItem -Path $ReleaseArm64 -Recurse -File -Filter *.exe |
  Where-Object { $_.Name -notmatch '^(uninstall|unins)' } |
  Select-Object -First 1
if (-not $arm64Exe) { throw "arm64 exe not found in $ReleaseArm64" }
Copy-Item -LiteralPath $arm64Exe.FullName -Destination (Join-Path $Arm64Out "Paimon-arm64.exe") -Force:$false
```

### Step H: Expected output layout

```text
windows/<timestamp>/x64/Paimon-x64.exe
windows/<timestamp>/arm64/Paimon-arm64.exe
```

## Verification Checklist

Build-time checks:

- `npm run verify:runtimes` passes
- `frontend/release-x64` contains installer EXE
- `frontend/release-arm64` contains installer EXE

Post-package resource checks (from `win-unpacked/resources`):

- `resources/agent` exists
- `resources/mcp-servers` exists
- `resources/python` exists
- `resources/node` exists
- `resources/playwright-browsers` exists

Runtime sanity checks:

- App launches without backend startup error dialog
- App logs show Playwright runtime path under `D:\PaimonData\Local\ms-playwright`
- `http://127.0.0.1:8000/api/health` reachable while app is running
- Basic chat and File Manager operations work

## Historical Pitfalls and Fixes

1. Output overwrite between x64 and arm64
- Cause: both builds write into same output path.
- Fix: always use separate output dirs (`release-x64`, `release-arm64`) and timestamped final copy path.

2. Missing bundled runtime assets causes backend startup failure
- Cause: skipping runtime preparation/verification.
- Fix: always run `npm run prepare:runtimes` then `npm run verify:runtimes` before packaging.

3. Packaged app rejects non-`D:` data/runtime root on Windows
- Cause: runtime/data root policy enforces `D:\PaimonData`.
- Fix: keep runtime/data paths under `D:\PaimonData` or allowed subpaths.

4. Playwright browser channel mismatch: "installed" but still fails to launch
- Cause: browser channel/config and installed browser artifact do not align.
- Fix: force `PLAYWRIGHT_MCP_BROWSER=chromium` and use runtime browser path `D:\PaimonData\Local\ms-playwright`.

5. Bundled browser path hard dependency blocks startup
- Cause: packaged runtime required `resources/playwright-browsers` to exist.
- Fix: treat bundled assets as optional seed only; if missing or empty, continue startup and allow runtime auto-download.

6. MCP server packaged but not runnable
- Cause: missing local entrypoint or missing `node_modules/dist` in server folder.
- Fix: verify server entrypoints and required dependencies before packaging.

7. Stale release folders confuse QA validation
- Cause: old artifacts remain and are mistaken as fresh build output.
- Fix: clean per-arch release folders before each run and use timestamped destination folders.

## Quick Rebuild (When Runtimes Are Already Known-Good)

Use this only if runtime assets are already valid and unchanged:

```powershell
Push-Location $FrontendDir
npm run verify:runtimes
npm run build:main
npm run build:renderer
npx electron-builder --win nsis --x64 --publish never --config.directories.output=release-x64
npx electron-builder --win nsis --arm64 --publish never --config.directories.output=release-arm64
Pop-Location
```

Then run the EXE copy step from Full Flow (Step G).

## Troubleshooting (Symptom -> Action)

1. Backend startup failed / bundled Python not usable
- Action: check `runtime/python` exists and reinstall runtime requirements with `runtime/python/python.exe`.

2. Bundled Node runtime not found
- Action: verify `runtime/node` exists and that `frontend/package.json` includes it in `extraResources`.

3. Bundled Playwright browsers not found
- Action: packaged app should still start. It will attempt runtime auto-download into `D:\PaimonData\Local\ms-playwright`. If you need faster first run, rerun `npm run prepare:runtimes` and include `runtime/playwright-browsers` as seed assets.

4. MCP server unavailable after packaging
- Action: inspect `resources/mcp-servers/<server>` for entrypoint and dependencies (`dist`, `node_modules`, config files).

5. EXE generated but wrong binary copied
- Action: exclude uninstall executables (`uninstall|unins`) and copy installer EXE explicitly.

## Test Cases / Scenarios

1. Fresh-machine-like packaging run
- Execute full flow from Step A to Step H.
- Confirm x64 and arm64 EXEs both exist under `windows/<timestamp>/...`.

2. Rebuild run
- Execute quick rebuild flow.
- Confirm outputs remain separated and previous outputs remain untouched.

3. Runtime integrity check
- Launch packaged EXE.
- Confirm backend starts and core chat works.

4. Resource integrity check
- Inspect unpacked resources for required runtime and MCP directories.

5. Regression consistency check
- Confirm commands and asset assumptions remain aligned with:
  - `frontend/package.json`
  - `frontend/scripts/prepare-bundled-runtimes.ps1`
  - `frontend/scripts/verify-bundled-runtimes.mjs`

## Assumptions and Defaults

- Document language is English.
- Path style uses `$RepoRoot` plus repo-relative paths.
- Default flow is full packaging; quick rebuild is optional.
- Steps are command-by-command (not one giant one-shot script).
- Pitfalls include known runtime/packaging issues already encountered in this project.
