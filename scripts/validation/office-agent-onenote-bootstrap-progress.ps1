$ErrorActionPreference = 'Stop'

# PILOT_VALIDATION_PLAN: {"version":2,"stages":["dependencies","compile","policy","test"],"testOnlyPrefixes":["agents/office-agent/tests/integration/"],"lockfilePaths":["package.json","yarn.lock",".yarnrc.yml"],"buildConfigPaths":["lage.config.js","tsconfig.json","agents/office-agent/package.json","agents/office-agent/tsconfig.json","jest.config.js"],"dependencySnapshotPaths":["node_modules",".yarn/install-state.gz"],"preparedOutputPaths":["node_modules",".yarn/install-state.gz"]}

$yarnCache = 'C:\.tools\.yarn'
New-Item -ItemType Directory -Path $yarnCache -Force | Out-Null
$env:YARN_CACHE_FOLDER = $yarnCache
$env:YARN_AFTER_INSTALL = 'node -e "process.exit(0)"'
$env:OAGENT_SKIP_PYTHON_POSTINSTALL = '1'
$stage = if ($env:PILOT_VALIDATION_STAGE) { $env:PILOT_VALIDATION_STAGE } else { 'all' }
if ($stage -notin @('all', 'fingerprint', 'dependencies', 'compile', 'policy', 'test')) {
    throw "Unsupported validation stage: $stage"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable exited with code $LASTEXITCODE"
    }
}

$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
$contract = 'tests/integration/contracts/apps/onenote/omni-onenote-bootstrap-progress.contract.test.ts'
$knownCompileOutputs = @(
    'agents/workspace-agent/experiments/agentic-dashboard/components/bundle.js',
    'agents/workspace-agent/experiments/project-agent/components/bundle.js'
)

if ($stage -eq 'fingerprint') {
    $fingerprint = [ordered]@{
        node = (& node --version).Trim()
        corepack = (& $corepack --version).Trim()
        yarn = (& $corepack yarn --version).Trim()
        platform = [System.Environment]::OSVersion.Platform.ToString()
        architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    Write-Output "PILOT_VALIDATION_FINGERPRINT:$($fingerprint | ConvertTo-Json -Compress)"
    exit 0
}

if ($stage -in @('all', 'dependencies')) {
    Invoke-Checked $corepack yarn install --immutable --mode=skip-build
}

if ($stage -in @('all', 'compile')) {
    $compileFailure = $null
    try {
        Invoke-Checked $corepack yarn compile --to '@officeagent-agent/office-agent'
    }
    catch {
        $compileFailure = $_
    }

    $changedFiles = @(& git diff --name-only)
    if ($LASTEXITCODE -ne 0) {
        throw "git diff exited with code $LASTEXITCODE"
    }
    $untrackedFiles = @(& git ls-files --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) {
        throw "git ls-files exited with code $LASTEXITCODE"
    }
    $unexpectedChanges = @($changedFiles + $untrackedFiles | Where-Object {
        $_ -and $_ -notin $knownCompileOutputs
    })
    if ($unexpectedChanges.Count -gt 0) {
        throw "Scoped compile changed unexpected files: $($unexpectedChanges -join ', ')"
    }
    if ($changedFiles.Count -gt 0) {
        & git restore --worktree -- @knownCompileOutputs
        if ($LASTEXITCODE -ne 0) {
            throw "git restore exited with code $LASTEXITCODE"
        }
    }
    if ($null -ne $compileFailure) {
        throw $compileFailure
    }
}

if ($stage -in @('all', 'policy')) {
    Invoke-Checked $corepack yarn validate:integration-test-layout

    Push-Location 'agents\office-agent'
    try {
        Invoke-Checked node '..\..\docs\skills\Integration-test-core\scripts\validate-card-scores.mjs' --strict --floor 6
    }
    finally {
        Pop-Location
    }
}

if ($stage -in @('all', 'test')) {
    Invoke-Checked $corepack yarn workspace '@officeagent-agent/office-agent' test:integration `
        --testMatch='**/tests/integration/**/*.test.ts' `
        --runTestsByPath $contract `
        --runInBand
}
