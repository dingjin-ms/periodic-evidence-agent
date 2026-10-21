$ErrorActionPreference = 'Stop'
$env:CI = 'true'

# PILOT_VALIDATION_PLAN: {"version":3,"stages":["dependencies","compile","policy","test"],"authentication":{"type":"repository-broker","provider":"1js-node-azure-auth","providerVersion":"0.0.1","feeds":[{"registry":"https://pkgs.dev.azure.com/office/Office/_packaging/1JS/npm/registry/","scope":null}]},"testOnlyPrefixes":["midgard/packages/officeaicopilot-agent-excel/tests/integration/","midgard/change/"],"lockfilePaths":["midgard/package.json","midgard/yarn.lock","midgard/.yarnrc"],"buildConfigPaths":["midgard/lage.config.js","midgard/packages/jest-config/package.json","midgard/packages/officeaicopilot-agent-excel/package.json","midgard/packages/officeaicopilot-agent-excel/jest.integration.config.js"],"dependencySnapshotPaths":["midgard/.store","midgard/node_modules"],"preparedOutputPaths":["midgard/packages/jest-config/lib"]}

$stage = if ($env:PILOT_VALIDATION_STAGE) { $env:PILOT_VALIDATION_STAGE } else { 'all' }
if ($stage -notin @('all', 'fingerprint', 'authentication-check', 'authentication',
        'dependencies', 'compile', 'policy', 'test')) {
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

function Get-ScopedChanges {
    if ($env:PILOT_VALIDATION_BASE_REVISION -notmatch '^[a-f0-9]{40,64}$') {
        throw 'PILOT_VALIDATION_BASE_REVISION is missing or invalid'
    }
    if ($env:PILOT_VALIDATION_REVISION -notmatch '^[a-f0-9]{40,64}$') {
        throw 'PILOT_VALIDATION_REVISION is missing or invalid'
    }

    $paths = @(& git diff --name-only `
        $env:PILOT_VALIDATION_BASE_REVISION $env:PILOT_VALIDATION_REVISION)
    if ($LASTEXITCODE -ne 0) {
        throw "git diff exited with code $LASTEXITCODE"
    }
    return @($paths | Where-Object { $_ })
}

$yarn = (Get-Command yarn.cmd -ErrorAction Stop).Source
$packageRoot = 'midgard/packages/officeaicopilot-agent-excel/'
$integrationRoot = "${packageRoot}tests/integration/"

if ($stage -eq 'fingerprint') {
    $fingerprint = [ordered]@{
        node = (& node --version).Trim()
        corepack = (& corepack --version).Trim()
        yarn = (& $yarn --version).Trim()
        platform = [System.Environment]::OSVersion.Platform.ToString()
        architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    Write-Output "PILOT_VALIDATION_FINGERPRINT:$($fingerprint | ConvertTo-Json -Compress)"
    exit 0
}

if ($stage -in @('authentication-check', 'authentication')) {
    if ($env:PILOT_VALIDATION_REVISION -notmatch '^[a-f0-9]{40,64}$') {
        throw 'PILOT_VALIDATION_REVISION is missing or invalid'
    }
    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $env:PILOT_VALIDATION_REVISION) {
        throw 'Authentication broker checkout is not at the exact requested revision'
    }
    $missingBootstrap = @(
        'packages/fast-script-runner/bin/fast-runner.mjs',
        'packages/fast-script-runner/dist/index.mjs',
        'midgard/package.json',
        'packages/node-azure-auth/package.json',
        'packages/node-azure-auth/bin/index.cjs',
        'packages/node-azure-auth/dist/main.cjs',
        '.npmrc'
    ) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($missingBootstrap) {
        throw "PILOT_AUTH_BOOTSTRAP_MISSING: materialize the pinned repository bootstrap before authentication: $($missingBootstrap -join ', ')"
    }
    $brokerChanges = @(& git status --porcelain -- `
        '.npmrc' 'midgard/package.json' 'packages/node-azure-auth')
    if ($LASTEXITCODE -ne 0 -or $brokerChanges.Count -gt 0) {
        throw 'Authentication broker inputs differ from the exact requested revision'
    }
    Push-Location 'midgard'
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell treats redirected native stderr as error records.
        $ErrorActionPreference = 'Continue'
        & $yarn auth --skip-auth *> $null
        $authExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($stage -eq 'authentication-check') {
        $preflight = if ($authExitCode -eq 0) {
            [ordered]@{
                state = 'ready'
                provider = '1js-node-azure-auth'
                providerVersion = '0.0.1'
                feedCount = 1
                tokenRecorded = $false
            }
        }
        else {
            [ordered]@{
                state = 'action-required-auth'
                reason = 'interactive-sign-in-required'
                installProvider = $false
                provider = '1js-node-azure-auth'
                providerVersion = '0.0.1'
                feedCount = 1
                tokenRecorded = $false
            }
        }
        Write-Output "PILOT_VALIDATION_AUTH_PREFLIGHT:$($preflight | ConvertTo-Json -Compress)"
        exit 0
    }
    if ($authExitCode -ne 0) {
        throw 'PILOT_AUTH_ACTION_REQUIRED: run the declared 1JS authentication remediation'
    }
    $authentication = [ordered]@{
        provider = '1js-node-azure-auth'
        providerVersion = '0.0.1'
        feedCount = 1
        tokenRecorded = $false
    }
    Write-Output "PILOT_VALIDATION_AUTH:$($authentication | ConvertTo-Json -Compress)"
    exit 0
}

Push-Location 'midgard'
try {
    if ($stage -in @('all', 'dependencies')) {
        Invoke-Checked $yarn fast '@1js/officeaicopilot-agent-excel' `
            --skip-postinstall-local `
            --allowed-packages-with-install-scripts keytar azureauth '@1js/ci-scripts'
    }

    if ($stage -in @('all', 'compile')) {
        Invoke-Checked $yarn workspace '@1js/jest-config' build

        Pop-Location
        try {
            $generated = @(& git diff --name-only)
            if ($LASTEXITCODE -ne 0) {
                throw "git diff exited with code $LASTEXITCODE"
            }
            $unexpected = @($generated | Where-Object {
                $_ -and -not $_.StartsWith('midgard/packages/jest-config/lib/')
            })
            if ($unexpected.Count -gt 0) {
                throw "Jest config build changed unexpected files: $($unexpected -join ', ')"
            }
            # Content-equivalent LF output can still leave a CRLF checkout dirty.
            Invoke-Checked git restore --worktree -- 'midgard/packages/jest-config/lib'
        }
        finally {
            Push-Location 'midgard'
        }
    }

    if ($stage -in @('all', 'policy', 'test')) {
        Pop-Location
        try {
            $changes = Get-ScopedChanges
            if ($changes.Count -eq 0) {
                throw 'No SDX integration-test or changefile changes were found'
            }
            $outside = @($changes | Where-Object {
                -not $_.StartsWith($integrationRoot) -and
                -not $_.StartsWith('midgard/change/')
            })
            if ($outside.Count -gt 0) {
                throw "SDX validation scope contains unsupported paths: $($outside -join ', ')"
            }
            $tests = @($changes | Where-Object {
                $_.StartsWith($integrationRoot) -and $_.EndsWith('.test.ts')
            } | ForEach-Object {
                $_.Substring($packageRoot.Length)
            })
            if ($tests.Count -eq 0) {
                throw 'SDX integration-test changes must include at least one .test.ts file'
            }
        }
        finally {
            Push-Location 'midgard'
        }
    }

    if ($stage -in @('all', 'policy')) {
        Invoke-Checked node scripts/run-lint-root.js
    }

    if ($stage -in @('all', 'test')) {
        $packageDirectory = Join-Path (Get-Location).Path 'packages/officeaicopilot-agent-excel'
        $configurationPath = Join-Path $env:TEMP ("sdx-source-runtime-" + [guid]::NewGuid() + '.cjs')
        $resultPath = Join-Path $env:TEMP ("sdx-native-results-" + [guid]::NewGuid() + '.json')
        $configuration = @'
const path = require('node:path');
const { createRequire } = require('node:module');
const rootDir = __PACKAGE_DIRECTORY__;
const fromPackage = createRequire(path.join(rootDir, 'package.json'));
const original = fromPackage('./jest.integration.config.js');
const transformer = fromPackage.resolve('@1js/jest-config/swc-transform');
const fromTransformer = createRequire(transformer);
module.exports = {
  ...original,
  rootDir,
  resolver: fromPackage.resolve('@1js/jest-config/source-resolver'),
  transformIgnorePatterns: [],
  transform: {
    '\\.tests?\\.tsx?$': original.transform['\\.tsx?'],
    '\\.[cm]?tsx?$': [transformer, { rootDir }],
    '\\.[cm]?js$': [transformer, { rootDir }],
  },
  moduleNameMapper: {
    ...original.moduleNameMapper,
    '^@swc/helpers/(.*)$':
      path.dirname(fromTransformer.resolve('@swc/helpers/package.json')) + '/$1',
  },
};
'@
        $configuration = $configuration.Replace('__PACKAGE_DIRECTORY__',
            (ConvertTo-Json -InputObject $packageDirectory -Compress))
        [System.IO.File]::WriteAllText($configurationPath, $configuration)
        $jest = (& node -p "require('path').join(require('path').dirname(require.resolve('jest/package.json', { paths: [process.argv[1]] })), 'bin/jest.js')" $packageDirectory).Trim()
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $jest -PathType Leaf)) {
            throw 'PILOT_VALIDATION_PROFILE_ERROR: installed native Jest runner is unavailable'
        }
        $testPaths = @($tests | ForEach-Object { Join-Path $packageDirectory $_ })
        Push-Location $packageDirectory
        try {
            Invoke-Checked node $jest --config $configurationPath `
                --runTestsByPath @testPaths --runInBand --passWithNoTests=false `
                --json --outputFile $resultPath
        }
        finally {
            Pop-Location
        }
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        $expectedPaths = @($testPaths | ForEach-Object { [System.IO.Path]::GetFullPath($_) })
        $actualPaths = @($result.testResults | ForEach-Object { [System.IO.Path]::GetFullPath($_.name) })
        if (-not $result.success -or $result.numTotalTests -lt 1 -or
            $result.numPassedTests -ne $result.numTotalTests -or
            $actualPaths.Count -ne $expectedPaths.Count -or
            @($expectedPaths | Where-Object { $_ -notin $actualPaths }).Count -gt 0 -or
            @($result.testResults | Where-Object { @($_.assertionResults).Count -eq 0 }).Count -gt 0) {
            throw 'PILOT_VALIDATION_PROFILE_ERROR: native Jest results do not prove all selected tests passed'
        }
        $proof = [ordered]@{
            resultPath = $resultPath
            suiteCount = $actualPaths.Count
            testCount = $result.numTotalTests
            passedCount = $result.numPassedTests
        }
        Write-Output "PILOT_VALIDATION_TEST_RESULT:$($proof | ConvertTo-Json -Compress)"
    }
}
finally {
    Pop-Location
}
