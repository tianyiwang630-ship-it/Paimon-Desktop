param(
    [ValidateSet("PortableNuget", "CopyEnv")]
    [string]$PythonMode = "PortableNuget",
    [string]$PythonBuilder = "python",
    [string]$PythonSource = "",
    [string]$NodeSource = "",
    [string]$NodeVersion = "v20.18.3",
    [string]$PythonVersion = "3.12.8",
    [string]$PandocVersion = "3.6.2",
    [string]$ToolsSourceRoot = "",
    [ValidateSet("strict", "dev")]
    [string]$ToolsMode = "dev"
)

$ErrorActionPreference = "Stop"

$isWindowsHost = ($env:OS -eq 'Windows_NT')

function Invoke-PythonWithIsolation {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string[]]$Args
    )

    $oldNoUserSite = [Environment]::GetEnvironmentVariable("PYTHONNOUSERSITE", "Process")
    $oldPipUser = [Environment]::GetEnvironmentVariable("PIP_USER", "Process")

    try {
        [Environment]::SetEnvironmentVariable("PYTHONNOUSERSITE", "1", "Process")
        [Environment]::SetEnvironmentVariable("PIP_USER", "0", "Process")
        $isolatedArgs = @("-s") + $Args
        Invoke-Checked -Exe $PythonExe -Args $isolatedArgs
    }
    finally {
        [Environment]::SetEnvironmentVariable("PYTHONNOUSERSITE", $oldNoUserSite, "Process")
        [Environment]::SetEnvironmentVariable("PIP_USER", $oldPipUser, "Process")
    }
}
function Copy-Tree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Target
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Source path does not exist: $Source"
    }

    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    $logFile = Join-Path $env:TEMP ("skills-mcp-robocopy-" + [guid]::NewGuid().ToString("N") + ".log")
    $null = & robocopy $Source $Target /MIR /R:1 /W:1 /NFL /NDL /NP /MT:16 /LOG:$logFile
    $code = $LASTEXITCODE
    Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
    if ($code -ge 8) {
        throw "robocopy failed ($code) while copying '$Source' -> '$Target'"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$Args
    )

    & $Exe @Args
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Exe $($Args -join ' ')"
    }
}

function Invoke-NpmInDir {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Args
    )

    if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
        throw "Directory not found for npm command: $WorkingDirectory"
    }

    Push-Location -LiteralPath $WorkingDirectory
    try {
        Invoke-Checked -Exe "npm" -Args $Args
    }
    finally {
        Pop-Location
    }
}

function Invoke-NpmPruneProdInDir {
    param([Parameter(Mandatory = $true)][string]$WorkingDirectory)

    if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
        throw "Directory not found for npm prune: $WorkingDirectory"
    }

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & cmd /c "npm prune --omit=dev"
        if ($LASTEXITCODE -ne 0) {
            throw "npm prune failed ($LASTEXITCODE) in $WorkingDirectory"
        }
    }
    finally {
        Pop-Location
    }
}

function Get-FirstExistingPath {
    param([Parameter(Mandatory = $true)][string[]]$Candidates)
    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

function Get-FileVersionFromPackageJson {
    param([Parameter(Mandatory = $true)][string]$PackageJsonPath)
    if (-not (Test-Path -LiteralPath $PackageJsonPath)) {
        return $null
    }
    try {
        $obj = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
        return $obj.version
    }
    catch {
        return $null
    }
}

function Remove-PythonRuntimeNoise {
    param([Parameter(Mandatory = $true)][string]$PythonRoot)

    if (-not (Test-Path -LiteralPath $PythonRoot)) {
        return
    }

    Get-ChildItem -LiteralPath $PythonRoot -Recurse -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @("__pycache__", ".pytest_cache") } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

    Get-ChildItem -LiteralPath $PythonRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

function Ensure-PortablePythonRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$PythonTarget,
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$Version
    )

    if ($isWindowsHost -ne $true) {
        throw "PortableNuget Python mode currently supports Windows build hosts only."
    }

    if (Test-Path -LiteralPath $PythonTarget) {
        Remove-Item -LiteralPath $PythonTarget -Recurse -Force
    }

    $nugetExe = Join-Path $RuntimeRoot "nuget.exe"
    if (-not (Test-Path -LiteralPath $nugetExe)) {
        Write-Host "[prepare:runtimes] Download nuget.exe..."
        Invoke-WebRequest "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" -OutFile $nugetExe
    }

    $nugetRoot = Join-Path $RuntimeRoot "_nuget"
    if (Test-Path -LiteralPath $nugetRoot) {
        Remove-Item -LiteralPath $nugetRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $nugetRoot | Out-Null

    Write-Host "[prepare:runtimes] Install portable Python $Version via nuget..."
    Invoke-Checked -Exe $nugetExe -Args @("install", "python", "-Version", $Version, "-ExcludeVersion", "-OutputDirectory", $nugetRoot, "-Verbosity", "quiet")

    $toolsRoot = Join-Path $nugetRoot "python\tools"
    if (-not (Test-Path -LiteralPath $toolsRoot)) {
        throw "Nuget python tools folder not found: $toolsRoot"
    }

    Copy-Tree -Source $toolsRoot -Target $PythonTarget

    $portablePython = Join-Path $PythonTarget "python.exe"
    if (-not (Test-Path -LiteralPath $portablePython)) {
        throw "Portable python executable not found after copy: $portablePython"
    }

    $runtimeRequirements = Join-Path $RepoRoot "requirements-runtime.txt"
    if (-not (Test-Path -LiteralPath $runtimeRequirements)) {
        throw "Runtime requirements file not found: $runtimeRequirements"
    }

    Invoke-PythonWithIsolation -PythonExe $portablePython -Args @("-m", "ensurepip", "--upgrade")
    Invoke-PythonWithIsolation -PythonExe $portablePython -Args @("-m", "pip", "--isolated", "install", "--no-user", "--upgrade", "pip", "setuptools", "wheel")
    Invoke-PythonWithIsolation -PythonExe $portablePython -Args @("-m", "pip", "--isolated", "install", "--no-user", "-r", $runtimeRequirements)
}

function Ensure-PythonRuntimeFromSource {
    param(
        [Parameter(Mandatory = $true)][string]$PythonTarget,
        [Parameter(Mandatory = $true)][string]$PythonSourcePath,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )

    if (-not (Test-Path -LiteralPath $PythonSourcePath)) {
        throw "PythonSource does not exist: $PythonSourcePath"
    }

    if (Test-Path -LiteralPath $PythonTarget) {
        Remove-Item -LiteralPath $PythonTarget -Recurse -Force
    }

    Copy-Tree -Source $PythonSourcePath -Target $PythonTarget

    $pythonExe = Get-FirstExistingPath -Candidates @(
        (Join-Path $PythonTarget "python.exe"),
        (Join-Path $PythonTarget "Scripts\python.exe"),
        (Join-Path $PythonTarget "bin\python3"),
        (Join-Path $PythonTarget "bin\python")
    )
    if (-not $pythonExe) {
        throw "Python executable not found in copied Python runtime: $PythonTarget"
    }

    $runtimeRequirements = Join-Path $RepoRoot "requirements-runtime.txt"
    if (-not (Test-Path -LiteralPath $runtimeRequirements)) {
        throw "Runtime requirements file not found: $runtimeRequirements"
    }

    Invoke-PythonWithIsolation -PythonExe $pythonExe -Args @("-m", "pip", "--isolated", "install", "--no-user", "--upgrade", "pip", "setuptools", "wheel")
    Invoke-PythonWithIsolation -PythonExe $pythonExe -Args @("-m", "pip", "--isolated", "install", "--no-user", "-r", $runtimeRequirements)
}

function Ensure-PortableNodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$NodeTarget,
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $false)][string]$SourceDir
    )

    if (Test-Path -LiteralPath $NodeTarget) {
        Remove-Item -LiteralPath $NodeTarget -Recurse -Force
    }

    if ($SourceDir -and (Test-Path -LiteralPath $SourceDir)) {
        Write-Host "[prepare:runtimes] Copy Node runtime from: $SourceDir"
        Copy-Tree -Source $SourceDir -Target $NodeTarget
        return
    }

    if ($isWindowsHost -ne $true) {
        throw "Portable Node auto-download currently supports Windows build hosts only. Set -NodeSource explicitly."
    }

    $zipPath = Join-Path $RuntimeRoot "node-$Version-win-x64.zip"
    $extractRoot = Join-Path $RuntimeRoot "_node_extract"
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }

    $url = "https://nodejs.org/dist/$Version/node-$Version-win-x64.zip"
    Write-Host "[prepare:runtimes] Download portable Node from: $url"
    Invoke-WebRequest $url -OutFile $zipPath

    Expand-ZipCompat -ZipPath $zipPath -DestinationPath $extractRoot
    $expanded = Join-Path $extractRoot "node-$Version-win-x64"
    if (-not (Test-Path -LiteralPath $expanded)) {
        throw "Expanded Node directory not found: $expanded"
    }

    Copy-Tree -Source $expanded -Target $NodeTarget
}

function Find-ExecutableInDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string[]]$ExecutableNames
    )

    if (-not (Test-Path -LiteralPath $Root)) {
        return $null
    }

    $nameSet = @{}
    foreach ($n in $ExecutableNames) { $nameSet[$n.ToLowerInvariant()] = $true }

    $found = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $nameSet.ContainsKey($_.Name.ToLowerInvariant()) } |
        Select-Object -First 1

    if ($found) { return $found.FullName }
    return $null
}

function Resolve-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string]$ExecutableName,
        [Parameter(Mandatory = $true)][string[]]$AllExecutableNames,
        [Parameter(Mandatory = $true)][string[]]$CandidatePaths,
        [Parameter(Mandatory = $false)][string]$ToolsRoot
    )

    $envKey = "SKILLS_MCP_TOOL_" + ($ToolName.ToUpperInvariant().Replace('-', '_'))
    $override = [Environment]::GetEnvironmentVariable($envKey)
    if ($override) {
        if (Test-Path -LiteralPath $override) {
            $item = Get-Item -LiteralPath $override
            if ($item.PSIsContainer) {
                $candidate = Find-ExecutableInDirectory -Root $override -ExecutableNames @($ExecutableName)
                if ($candidate) { return $candidate }
            }
            else {
                return $item.FullName
            }
        }
    }

    if ($ToolsRoot) {
        $toolScoped = Join-Path $ToolsRoot $ToolName
        $candidate = Find-ExecutableInDirectory -Root $toolScoped -ExecutableNames @($ExecutableName)
        if ($candidate) { return $candidate }

        $candidate = Find-ExecutableInDirectory -Root $ToolsRoot -ExecutableNames @($ExecutableName)
        if ($candidate) { return $candidate }
    }

    foreach ($pathCandidate in $CandidatePaths) {
        if ($pathCandidate -and (Test-Path -LiteralPath $pathCandidate)) {
            $item = Get-Item -LiteralPath $pathCandidate
            if ($item.PSIsContainer) {
                $candidate = Find-ExecutableInDirectory -Root $item.FullName -ExecutableNames @($ExecutableName)
                if ($candidate) { return $candidate }
            }
            else {
                return $item.FullName
            }
        }
    }

    foreach ($name in @($ExecutableName) + $AllExecutableNames) {
        try {
            $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
                return (Resolve-Path -LiteralPath $cmd.Source).Path
            }
        }
        catch {
            # ignore
        }
    }

    return $null
}

function Resolve-ToolRootPath {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string[]]$ExecutableNames,
        [Parameter(Mandatory = $true)][string[]]$RootCandidates,
        [Parameter(Mandatory = $true)][string[]]$ExecutableCandidates,
        [Parameter(Mandatory = $false)][string]$ToolsRoot
    )

    $envKey = "SKILLS_MCP_TOOL_" + ($ToolName.ToUpperInvariant().Replace('-', '_'))
    $override = [Environment]::GetEnvironmentVariable($envKey)
    if ($override -and (Test-Path -LiteralPath $override)) {
        $item = Get-Item -LiteralPath $override
        if ($item.PSIsContainer) {
            return $item.FullName
        }
        return Split-Path -Parent $item.FullName
    }

    if ($ToolsRoot) {
        $toolScoped = Join-Path $ToolsRoot $ToolName
        if (Test-Path -LiteralPath $toolScoped) {
            return (Resolve-Path -LiteralPath $toolScoped).Path
        }
    }

    foreach ($root in $RootCandidates) {
        if ($root -and (Test-Path -LiteralPath $root)) {
            return (Resolve-Path -LiteralPath $root).Path
        }
    }

    foreach ($exePath in $ExecutableCandidates) {
        if ($exePath -and (Test-Path -LiteralPath $exePath)) {
            return (Resolve-Path -LiteralPath (Split-Path -Parent $exePath)).Path
        }
    }

    foreach ($name in $ExecutableNames) {
        try {
            $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
                return (Resolve-Path -LiteralPath (Split-Path -Parent $cmd.Source)).Path
            }
        }
        catch {
            # ignore
        }
    }

    return $null
}

function Expand-ZipCompat {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    if (Test-Path -LiteralPath $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null

    $tarCmd = Get-Command tar -ErrorAction SilentlyContinue
    if ($tarCmd) {
        & $tarCmd.Path -xf $ZipPath -C $DestinationPath
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Write-Warning "tar extraction failed for $ZipPath, fallback to .NET ZipFile"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $zip.Entries) {
            $target = Join-Path $DestinationPath $entry.FullName
            if ([string]::IsNullOrEmpty($entry.Name)) {
                New-Item -ItemType Directory -Force -Path $target | Out-Null
                continue
            }
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Force -Path $parent | Out-Null
            }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    }
    finally {
        $zip.Dispose()
    }
}

function Ensure-DownloadFile {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$OutFile
    )

    if (Test-Path -LiteralPath $OutFile) {
        return
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
    Write-Host "[prepare:runtimes] Download: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $OutFile
}
function Ensure-ExtractedZip {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$TargetDir
    )

    if (Test-Path -LiteralPath $TargetDir) {
        Remove-Item -LiteralPath $TargetDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Expand-ZipCompat -ZipPath $ZipPath -DestinationPath $TargetDir
}

function Ensure-RequiredToolBundles {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$PandocVersion
    )

    if ($isWindowsHost -ne $true) {
        return
    }

    $cacheRoot = Join-Path $RuntimeRoot "_toolcache"
    $downloadsRoot = Join-Path $cacheRoot "downloads"
    New-Item -ItemType Directory -Force -Path $downloadsRoot | Out-Null

    if (-not [Environment]::GetEnvironmentVariable("SKILLS_MCP_TOOL_PANDOC", "Process")) {
        $pandocZip = Join-Path $downloadsRoot "pandoc-$PandocVersion-windows-x86_64.zip"
        $pandocRoot = Join-Path $cacheRoot "pandoc-$PandocVersion"
        $pandocExe = Find-ExecutableInDirectory -Root $pandocRoot -ExecutableNames @("pandoc.exe")
        if (-not $pandocExe) {
            $pandocUrl = "https://github.com/jgm/pandoc/releases/download/$PandocVersion/pandoc-$PandocVersion-windows-x86_64.zip"
            Ensure-DownloadFile -Url $pandocUrl -OutFile $pandocZip
            Ensure-ExtractedZip -ZipPath $pandocZip -TargetDir $pandocRoot
            $pandocExe = Find-ExecutableInDirectory -Root $pandocRoot -ExecutableNames @("pandoc.exe")
        }
        if (-not $pandocExe) {
            throw "Bundled pandoc not found after download/extract: $pandocRoot"
        }
        [Environment]::SetEnvironmentVariable("SKILLS_MCP_TOOL_PANDOC", (Split-Path -Parent $pandocExe), "Process")
    }
}
function Stage-BundledTools {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $false)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][bool]$RequireTools
    )

    $toolsTarget = Join-Path $RuntimeRoot "tools"
    if (Test-Path -LiteralPath $toolsTarget) {
        Remove-Item -LiteralPath $toolsTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $toolsTarget | Out-Null

    $pf = ${env:ProgramFiles}
    $pf86 = ${env:ProgramFiles(x86)}

        $toolSpecs = @(
        @{
            Name = "pandoc"
            Executables = @("pandoc.exe")
            Required = $true
            RootCandidates = @(
                (Join-Path $pf "Pandoc"),
                (Join-Path $pf86 "Pandoc")
            )
            ExecutableCandidates = @(
                (Join-Path $pf "Pandoc\pandoc.exe"),
                (Join-Path $pf86 "Pandoc\pandoc.exe")
            )
        },
        @{
            Name = "tesseract"
            Executables = @("tesseract.exe")
            Required = $false
            RootCandidates = @(
                (Join-Path $pf "Tesseract-OCR"),
                (Join-Path $pf86 "Tesseract-OCR")
            )
            ExecutableCandidates = @(
                (Join-Path $pf "Tesseract-OCR\tesseract.exe"),
                (Join-Path $pf86 "Tesseract-OCR\tesseract.exe")
            )
        },
        @{
            Name = "pdftk"
            Executables = @("pdftk.exe")
            Required = $false
            RootCandidates = @(
                (Join-Path $pf "PDFtk"),
                (Join-Path $pf86 "PDFtk")
            )
            ExecutableCandidates = @(
                (Join-Path $pf "PDFtk\bin\pdftk.exe"),
                (Join-Path $pf86 "PDFtk\bin\pdftk.exe")
            )
        },
        @{
            Name = "qpdf"
            Executables = @("qpdf.exe")
            Required = $false
            RootCandidates = @(
                (Join-Path $pf "qpdf"),
                (Join-Path $pf86 "qpdf")
            )
            ExecutableCandidates = @(
                (Join-Path $pf "qpdf\bin\qpdf.exe"),
                (Join-Path $pf86 "qpdf\bin\qpdf.exe")
            )
        }
    )

    $manifestEntries = @()
    $missingRequired = @()
    $missingOptional = @()

    foreach ($spec in $toolSpecs) {
        $toolName = [string]$spec.Name
        $exeNames = [string[]]$spec.Executables
        $isRequired = [bool]$spec.Required

        $resolvedRoot = Resolve-ToolRootPath -ToolName $toolName -ExecutableNames $exeNames -RootCandidates ([string[]]$spec.RootCandidates) -ExecutableCandidates ([string[]]$spec.ExecutableCandidates) -ToolsRoot $SourceRoot
        if (-not $resolvedRoot) {
            foreach ($exe in $exeNames) {
                if ($isRequired) {
                    $missingRequired += "${toolName}:$exe"
                }
                else {
                    $missingOptional += "${toolName}:$exe"
                }
            }
            continue
        }

        $toolTarget = Join-Path $toolsTarget $toolName
        New-Item -ItemType Directory -Force -Path $toolTarget | Out-Null

        $payloadDir = Join-Path $toolTarget "payload"
        Copy-Tree -Source $resolvedRoot -Target $payloadDir

        foreach ($exe in $exeNames) {
            $stagedExe = Find-ExecutableInDirectory -Root $payloadDir -ExecutableNames @($exe)
            if (-not $stagedExe) {
                if ($isRequired) {
                    $missingRequired += "${toolName}:$exe"
                }
                else {
                    $missingOptional += "${toolName}:$exe"
                }
                continue
            }
            $manifestEntries += [ordered]@{
                tool = $toolName
                executable = $exe
                required = $isRequired
                sourceRoot = $resolvedRoot
                stagedExecutable = $stagedExe
                stagedRoot = $payloadDir
            }
        }
    }

    if ($RequireTools -and $missingRequired.Count -gt 0) {
        throw "Required bundled tools missing: $($missingRequired -join ', '). Provide SKILLS_MCP_TOOL_<TOOL> override or ToolsSourceRoot."
    }

    $manifest = [ordered]@{
        generated_at = (Get-Date).ToString("o")
        entries = $manifestEntries
        missing_required = $missingRequired
        missing_optional = $missingOptional
    }

    $manifestPath = Join-Path $toolsTarget "manifest.json"
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Host "[prepare:runtimes] Bundled tools staged at: $toolsTarget"
    if ($missingRequired.Count -gt 0) {
        Write-Warning "Required tools missing (current mode allows continue): $($missingRequired -join ', ')"
    }
    if ($missingOptional.Count -gt 0) {
        Write-Warning "Optional tools missing (non-blocking): $($missingOptional -join ', ')"
    }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$runtimeRoot = Join-Path $repoRoot "runtime"

$pythonTarget = Join-Path $runtimeRoot "python"
$nodeTarget = Join-Path $runtimeRoot "node"
$playwrightTarget = Join-Path $runtimeRoot "playwright-browsers"
$playwrightCli = Join-Path $repoRoot "mcp-servers\playwright\node_modules\playwright\cli.js"
$rednotePlaywrightCli = Join-Path $repoRoot "mcp-servers\rednote\node_modules\playwright\cli.js"
$openWebsearchNpxDir = Join-Path $repoRoot "mcp-servers\open-websearch\node_modules\npx"
$nodeExe = Join-Path $nodeTarget "node.exe"
$rednoteDir = Join-Path $repoRoot "mcp-servers\rednote"

Write-Host "[prepare:runtimes] Repo root: $repoRoot"
Write-Host "[prepare:runtimes] Runtime root: $runtimeRoot"
Write-Host "[prepare:runtimes] Python mode: $PythonMode"

if (-not (Test-Path -LiteralPath $runtimeRoot)) {
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
}

if ($PythonMode -eq "CopyEnv") {
    if (-not $PythonSource) {
        throw "PythonSource is required when PythonMode=CopyEnv"
    }
    Write-Host "[prepare:runtimes] Copy Python runtime from: $PythonSource"
    Ensure-PythonRuntimeFromSource -PythonTarget $pythonTarget -PythonSourcePath $PythonSource -RepoRoot $repoRoot
}
else {
    Ensure-PortablePythonRuntime -PythonTarget $pythonTarget -RuntimeRoot $runtimeRoot -RepoRoot $repoRoot -Version $PythonVersion
}

Write-Host "[prepare:runtimes] Prepare Node runtime..."
Ensure-PortableNodeRuntime -NodeTarget $nodeTarget -RuntimeRoot $runtimeRoot -Version $NodeVersion -SourceDir $NodeSource

if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw "Bundled node executable not found after prepare: $nodeExe"
}

if ((Test-Path -LiteralPath (Join-Path $rednoteDir "package.json")) -and (Test-Path -LiteralPath (Join-Path $rednoteDir "node_modules"))) {
    if (-not (Test-Path -LiteralPath (Join-Path $rednoteDir "dist\index.js"))) {
        Write-Host "[prepare:runtimes] Build rednote before pruning..."
        Invoke-NpmInDir -WorkingDirectory $rednoteDir -Args @("run", "build", "--if-present")
    }
    Write-Host "[prepare:runtimes] Prune rednote dev dependencies..."
    try {
        Invoke-NpmPruneProdInDir -WorkingDirectory $rednoteDir
    }
    catch {
        Write-Warning "rednote npm prune failed, continue with existing node_modules: $($_.Exception.Message)"
    }
}

if (Test-Path -LiteralPath $openWebsearchNpxDir) {
    Write-Host "[prepare:runtimes] Remove open-websearch legacy npx tree..."
    Remove-Item -LiteralPath $openWebsearchNpxDir -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $playwrightCli)) {
    throw "Playwright CLI not found: $playwrightCli. Run 'npm ci --prefix mcp-servers/playwright' first."
}

Write-Host "[prepare:runtimes] Install Playwright browser assets (chromium --no-shell)..."
if (Test-Path -LiteralPath $playwrightTarget) {
    Remove-Item -LiteralPath $playwrightTarget -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $playwrightTarget | Out-Null

$playwrightPkg = Join-Path $repoRoot "mcp-servers\playwright\node_modules\playwright\package.json"
$rednotePlaywrightPkg = Join-Path $repoRoot "mcp-servers\rednote\node_modules\playwright\package.json"
$playwrightVersion = Get-FileVersionFromPackageJson -PackageJsonPath $playwrightPkg
$rednoteVersion = Get-FileVersionFromPackageJson -PackageJsonPath $rednotePlaywrightPkg

$oldPlaywrightPath = $env:PLAYWRIGHT_BROWSERS_PATH
try {
    $env:PLAYWRIGHT_BROWSERS_PATH = $playwrightTarget
    & $nodeExe $playwrightCli install chromium --no-shell
    if ($LASTEXITCODE -ne 0) {
        throw "Playwright install failed with exit code $LASTEXITCODE"
    }

    $needRednoteBrowserInstall = $false
    if (Test-Path -LiteralPath $rednotePlaywrightCli) {
        if (-not $playwrightVersion -or -not $rednoteVersion) {
            $needRednoteBrowserInstall = $true
        }
        elseif ($playwrightVersion -ne $rednoteVersion) {
            $needRednoteBrowserInstall = $true
        }
    }

    if ($needRednoteBrowserInstall) {
        Write-Host "[prepare:runtimes] Install Rednote Playwright browser assets..."
        & $nodeExe $rednotePlaywrightCli install chromium --no-shell
        if ($LASTEXITCODE -ne 0) {
            throw "Rednote Playwright install failed with exit code $LASTEXITCODE"
        }
    }
    elseif (Test-Path -LiteralPath $rednotePlaywrightCli) {
        Write-Host "[prepare:runtimes] Skip Rednote browser install (shared Playwright version: $rednoteVersion)"
    }
    else {
        Write-Warning "Rednote Playwright CLI not found: $rednotePlaywrightCli"
    }
}
finally {
    if ($null -ne $oldPlaywrightPath) {
        $env:PLAYWRIGHT_BROWSERS_PATH = $oldPlaywrightPath
    }
    else {
        Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
    }
}

Get-ChildItem -LiteralPath $playwrightTarget -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'mcp-chrome*' -or $_.Name -eq '.links' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

if ($isWindowsHost -and [string]::IsNullOrWhiteSpace($ToolsSourceRoot)) {
    Ensure-RequiredToolBundles -RuntimeRoot $runtimeRoot -PandocVersion $PandocVersion
}

$requireBundledTools = ($ToolsMode -eq 'strict')
Stage-BundledTools -RuntimeRoot $runtimeRoot -SourceRoot $ToolsSourceRoot -RequireTools:$requireBundledTools

Remove-PythonRuntimeNoise -PythonRoot $pythonTarget

$gitkeep = Join-Path $playwrightTarget ".gitkeep"
if (-not (Test-Path -LiteralPath $gitkeep)) {
    New-Item -ItemType File -Path $gitkeep | Out-Null
}

Write-Host "[prepare:runtimes] Done."











