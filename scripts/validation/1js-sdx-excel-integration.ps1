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

    $paths = @(& git -c core.quotePath=false diff --name-only --no-renames `
        $env:PILOT_VALIDATION_BASE_REVISION $env:PILOT_VALIDATION_REVISION)
    if ($LASTEXITCODE -ne 0) {
        throw "git diff exited with code $LASTEXITCODE"
    }
    return @($paths | Where-Object { $_ })
}

$yarnCommand = if ([System.Environment]::OSVersion.Platform -eq 'Win32NT') { 'yarn.cmd' } else { 'yarn' }
$yarn = (Get-Command $yarnCommand -ErrorAction Stop).Source
$npmCommand = if ([System.Environment]::OSVersion.Platform -eq 'Win32NT') { 'npm.cmd' } else { 'npm' }
$npm = (Get-Command $npmCommand -ErrorAction Stop).Source
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
    $brokerChanges = @(& git -c core.quotePath=false diff --name-only --no-renames `
        $env:PILOT_VALIDATION_REVISION -- `
        '.npmrc' 'midgard/package.json' 'packages/node-azure-auth')
    if ($LASTEXITCODE -ne 0) {
        throw "Authentication broker diff exited with code $LASTEXITCODE"
    }
    if ($brokerChanges.Count -gt 0) {
        throw "Authentication broker inputs differ from the exact requested revision: $($brokerChanges -join ', ')"
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
    $credentialSource = 'repository-broker'
    if ($authExitCode -ne 0 -and $env:CI -eq 'true') {
        $homeDirectory = if ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
        $userNpmrc = Join-Path $homeDirectory '.npmrc'
        if (Test-Path -LiteralPath $userNpmrc -PathType Leaf) {
            $npmCommand = if ([System.Environment]::OSVersion.Platform -eq 'Win32NT') { 'npm.cmd' } else { 'npm' }
            $npm = (Get-Command $npmCommand -ErrorAction Stop).Source
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & $npm view '@1js/ci-scripts' version --silent `
                    --userconfig $userNpmrc `
                    --registry 'https://pkgs.dev.azure.com/office/Office/_packaging/1JS/npm/registry/' *> $null
                $authExitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($authExitCode -eq 0) {
                $credentialSource = 'runner-preauthenticated-user-npmrc'
            }
        }
    }
    if ($stage -eq 'authentication-check') {
        $preflight = if ($authExitCode -eq 0) {
            [ordered]@{
                state = 'ready'
                provider = '1js-node-azure-auth'
                providerVersion = '0.0.1'
                feedCount = 1
                credentialSource = $credentialSource
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
        credentialSource = $credentialSource
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
            --no-scripts
    }

    if ($stage -in @('all', 'compile')) {
        Pop-Location
        try {
            $jestConfigChanges = @(& git -c core.quotePath=false diff --name-only --no-renames `
                $env:PILOT_VALIDATION_BASE_REVISION $env:PILOT_VALIDATION_REVISION -- `
                'midgard/packages/jest-config/src' `
                'midgard/packages/jest-config/package.json' `
                'midgard/packages/jest-config/tsconfig.json')
            if ($LASTEXITCODE -ne 0) {
                throw "Jest config source diff exited with code $LASTEXITCODE"
            }
            if ($jestConfigChanges.Count -gt 0) {
                throw "Candidate changes Jest config sources and requires a source-complete build closure: $($jestConfigChanges -join ', ')"
            }
            $preparedChanges = @(& git -c core.quotePath=false diff --name-only --no-renames `
                $env:PILOT_VALIDATION_REVISION -- 'midgard/packages/jest-config/lib')
            if ($LASTEXITCODE -ne 0 -or $preparedChanges.Count -gt 0) {
                throw 'Prepared Jest config outputs differ from the exact requested revision'
            }
            $jestConfigRoot = (Resolve-Path -LiteralPath 'midgard/packages/jest-config').Path
            $compileArtifactRoot = Split-Path -Parent $env:PILOT_VALIDATION_ARTIFACT_DIRECTORY
            $sourceConfig = Get-Content -LiteralPath (Join-Path $jestConfigRoot 'tsconfig.json') -Raw |
                ConvertFrom-Json
            $sourceConfig.extends = (Join-Path $jestConfigRoot 'tsconfig.extends.json')
            $sourceConfig.references = @()
            $compileGlobals = Join-Path $compileArtifactRoot `
                'jest-config.validation-globals.d.ts'
            [IO.File]::WriteAllText($compileGlobals, `
                "declare function afterAll(callback: () => void | Promise<void>): void;`n")
            $sourceConfig.include = @((Join-Path $jestConfigRoot 'src'), $compileGlobals)
            $sourceConfig.compilerOptions.rootDir = (Join-Path $jestConfigRoot 'src')
            $sourceConfig.compilerOptions.outDir = (Join-Path $jestConfigRoot 'lib')
            $sourceConfig.compilerOptions.tsBuildInfoFile = (Join-Path $jestConfigRoot 'lib/tsconfig.tsbuildinfo')
            $compileConfig = Join-Path $compileArtifactRoot `
                'jest-config.validation.tsconfig.json'
            [IO.File]::WriteAllText($compileConfig, ($sourceConfig | ConvertTo-Json -Depth 10))
            $typescriptCli = (& node -e `
                "process.stdout.write(require.resolve('typescript/bin/tsc',{paths:['./midgard/packages/jest-config']}))").Trim()
            if ($LASTEXITCODE -ne 0 -or -not $typescriptCli) {
                throw 'TypeScript CLI could not be resolved from the Jest config workspace'
            }
            Invoke-Checked -Executable node -Arguments @(
                $typescriptCli,
                '--project',
                $compileConfig
            )
            foreach ($path in @(
                'midgard/packages/jest-config/lib/index.js',
                'midgard/packages/jest-config/lib/index.d.ts',
                'midgard/packages/jest-config/lib/defaultJestConfig.js',
                'midgard/packages/jest-config/lib/makeJestConfig.js',
                'midgard/packages/jest-config/lib/jsdomEnvironment.js',
                'midgard/packages/officeaicopilot-agent-excel/jest.integration.config.js'
            )) {
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                    throw "Compile input is missing: $path"
                }
            }
            Invoke-Checked -Executable node -Arguments @(
                '-e',
                "require('./midgard/packages/officeaicopilot-agent-excel/jest.integration.config.js')"
            )
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
                -not $_.StartsWith('midgard/change/') -and
                $_ -notin @(
                    'midgard/packages/officeaicopilot-agent-excel/jest.integration.config.js',
                    'midgard/packages/officeaicopilot-agent-excel/package.json'
                )
            })
            if ($outside.Count -gt 0) {
                throw "SDX validation scope contains unsupported paths: $($outside -join ', ')"
            }
            $testInputs = @($changes | Where-Object {
                $_.StartsWith($integrationRoot) -and
                -not $_.StartsWith("${integrationRoot}behavior-cards/") -and
                -not $_.StartsWith("${integrationRoot}skill-profile/")
            })
            if ($testInputs.Count -eq 0) {
                throw 'SDX integration-test changes must include test or harness inputs'
            }
            $codeChanges = @($testInputs | Where-Object { $_ -match '\.[cm]?[jt]sx?$' })
            $existingChanges = @(& git -c core.quotePath=false diff --name-only `
                --no-renames --diff-filter=MDT `
                $env:PILOT_VALIDATION_BASE_REVISION $env:PILOT_VALIDATION_REVISION `
                -- $integrationRoot)
            if ($LASTEXITCODE -ne 0) { throw "git diff exited with code $LASTEXITCODE" }
            $lintPaths = @($codeChanges | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
                ForEach-Object { $_.Substring($packageRoot.Length) })
        }
        finally {
            Push-Location 'midgard'
        }
    }

    if ($stage -in @('all', 'policy')) {
        Invoke-Checked $yarn lint:root
        if ($lintPaths.Count -gt 0) {
            Invoke-Checked $yarn workspace '@1js/officeaicopilot-agent-excel' lint @lintPaths
        }
    }

    if ($stage -in @('all', 'test')) {
        $packageDirectory = Join-Path (Get-Location).Path 'packages/officeaicopilot-agent-excel'
        $artifactDirectory = $env:PILOT_VALIDATION_ARTIFACT_DIRECTORY
        if (-not $artifactDirectory -or -not [System.IO.Path]::IsPathRooted($artifactDirectory) -or
            -not (Test-Path -LiteralPath $artifactDirectory -PathType Container) -or
            @(Get-ChildItem -LiteralPath $artifactDirectory -Force).Count -ne 0) {
            throw 'PILOT_VALIDATION_PROFILE_ERROR: a fresh absolute artifact directory is required'
        }
        $configurationPath = Join-Path $artifactDirectory 'runtime-config.cjs'
        $resolverPath = Join-Path $artifactDirectory 'workspace-source-resolver.cjs'
        $conversationBridgePath = Join-Path $artifactDirectory 'conversation-history-bridge.cjs'
        $tokenProviderBridgePath = Join-Path $artifactDirectory 'token-provider-bridge.cjs'
        $resultPath = Join-Path $artifactDirectory 'jest-result.json'
        $discoveryPath = Join-Path $artifactDirectory 'discovered-tests.json'
        $selectionPath = Join-Path $artifactDirectory 'selection.json'
        $configuration = @'
const path = require('node:path');
const { createRequire } = require('node:module');
const rootDir = __PACKAGE_DIRECTORY__;
const fromPackage = createRequire(path.join(rootDir, 'package.json'));
const original = fromPackage('./jest.integration.config.js');
module.exports = {
  ...original,
  rootDir,
  resolver: __RESOLVER_PATH__,
  testEnvironmentOptions: {
    ...original.testEnvironmentOptions,
    customExportConditions: ['source', 'browser'],
  },
  moduleNameMapper: {
    ...original.moduleNameMapper,
    '^@1js/officeaicopilot-agent-conversations-panel$': __CONVERSATION_BRIDGE__,
    '^\\.\\./context/TokenProvider$': __TOKEN_PROVIDER_BRIDGE__,
  },
};
'@
        $configuration = $configuration.Replace('__PACKAGE_DIRECTORY__',
            (ConvertTo-Json -InputObject $packageDirectory -Compress))
        $configuration = $configuration.Replace('__RESOLVER_PATH__',
            (ConvertTo-Json -InputObject $resolverPath -Compress))
        $configuration = $configuration.Replace('__CONVERSATION_BRIDGE__',
            (ConvertTo-Json -InputObject $conversationBridgePath -Compress))
        $configuration = $configuration.Replace('__TOKEN_PROVIDER_BRIDGE__',
            (ConvertTo-Json -InputObject $tokenProviderBridgePath -Compress))
        [System.IO.File]::WriteAllText($configurationPath, $configuration)
        $conversationImplementation = Join-Path (Split-Path -Parent $packageDirectory) `
            'officeaicopilot-agent-conversations-panel/src/api/getConversationHistory.ts'
        $conversationBridge = @'
const implementation = __IMPLEMENTATION__;
exports.getCopilotReferenceIdFromUrl = (...args) =>
  require(implementation).getCopilotReferenceIdFromUrl(...args);
'@
        $conversationBridge = $conversationBridge.Replace('__IMPLEMENTATION__',
            (ConvertTo-Json -InputObject $conversationImplementation -Compress))
        [System.IO.File]::WriteAllText($conversationBridgePath, $conversationBridge)
        $tokenProviderImplementation = Join-Path $packageDirectory 'src/context/TokenProvider.tsx'
        $tokenProviderBridge = @'
const implementation = __IMPLEMENTATION__;
exports.getUserInfoCached = (...args) =>
  require(implementation).getUserInfoCached(...args);
'@
        $tokenProviderBridge = $tokenProviderBridge.Replace('__IMPLEMENTATION__',
            (ConvertTo-Json -InputObject $tokenProviderImplementation -Compress))
        [System.IO.File]::WriteAllText($tokenProviderBridgePath, $tokenProviderBridge)
        $resolver = @'
const fs = require('node:fs');
const path = require('node:path');
const packageRoot = __PACKAGE_DIRECTORY__;
const workspacesRoot = path.dirname(packageRoot);
const sourceExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
function existing(candidate) {
  for (const extension of sourceExtensions) {
    const file = candidate + extension;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  for (const extension of sourceExtensions.slice(1)) {
    const file = path.join(candidate, 'index' + extension);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
}
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (primaryError) {
    const match = request.match(/^@1js\/([^/]+)(?:\/(.+))?$/);
    if (match) {
      const workspace = path.join(workspacesRoot, match[1]);
      if (fs.existsSync(path.join(workspace, 'package.json'))) {
        if (match[2]) {
          const relative = match[2].startsWith('lib/')
            ? match[2].slice('lib/'.length)
            : match[2];
          const subpath = existing(path.join(workspace, 'src', relative));
          if (subpath) return subpath;
        } else {
          const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json')));
          const source = manifest.exports?.['.']?.source;
          const entry = existing(source ? path.join(workspace, source) : path.join(workspace, 'src'));
          if (entry) return entry;
        }
      }
    }
    if (!request.startsWith('.') && !path.isAbsolute(request)) {
      return options.defaultResolver(request, { ...options, basedir: packageRoot });
    }
    throw primaryError;
  }
};
'@
        $resolver = $resolver.Replace('__PACKAGE_DIRECTORY__',
            (ConvertTo-Json -InputObject $packageDirectory -Compress))
        [System.IO.File]::WriteAllText($resolverPath, $resolver)
        $state = 'failed'
        $phase = 'runner-resolution'
        $primaryError = $null
        $testPaths = @()
        try {
            $jest = (& node -p "require('path').join(require('path').dirname(require.resolve('jest/package.json', { paths: [process.argv[1]] })), 'bin/jest.js')" $packageDirectory).Trim()
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $jest -PathType Leaf)) {
                throw 'PILOT_VALIDATION_PROFILE_ERROR: installed native Jest runner is unavailable'
            }
            $phase = 'discovery'
            Push-Location $packageDirectory
            try {
                $discovery = @(& node $jest --config $configurationPath --listTests --json --runInBand)
                if ($LASTEXITCODE -ne 0) { throw "Jest discovery exited with code $LASTEXITCODE" }
                [System.IO.File]::WriteAllText($discoveryPath, ($discovery -join "`n"))
                $discovered = @((Get-Content -LiteralPath $discoveryPath -Raw | ConvertFrom-Json) |
                    ForEach-Object { [System.IO.Path]::GetFullPath($_) })
                $integrationDirectory = [System.IO.Path]::GetFullPath(
                    (Join-Path $packageDirectory 'tests/integration')) + [System.IO.Path]::DirectorySeparatorChar
                if ($discovered.Count -eq 0 -or
                    @($discovered | Select-Object -Unique).Count -ne $discovered.Count -or
                    @($discovered | Where-Object {
                        -not $_.StartsWith($integrationDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
                        -not (Test-Path -LiteralPath $_ -PathType Leaf)
                    }).Count -gt 0) {
                    throw 'PILOT_VALIDATION_PROFILE_ERROR: invalid or empty native test discovery'
                }
                $changedPaths = @($testInputs | ForEach-Object {
                    [System.IO.Path]::GetFullPath((Join-Path $packageDirectory $_.Substring($packageRoot.Length)))
                })
                $undiscoveredTests = @($changedPaths | Where-Object {
                    $_ -match '\.tests?\.[cm]?[jt]sx?$' -and
                    (Test-Path -LiteralPath $_ -PathType Leaf) -and $_ -notin $discovered
                })
                if ($undiscoveredTests.Count -gt 0) {
                    throw 'PILOT_VALIDATION_PROFILE_ERROR: changed tests are excluded by native discovery'
                }
                # Existing helpers can have dynamic/mock consumers that Jest's dependency graph misses.
                $sharedChanges = @($existingChanges | Where-Object {
                    $_ -in $testInputs -and (
                        $_ -notmatch '\.tests?\.[cm]?[jt]sx?$' -or
                        -not (Test-Path -LiteralPath (Join-Path $packageDirectory $_.Substring($packageRoot.Length)))
                    )
                })
                $selectionMode = if ($sharedChanges.Count -gt 0) { 'integration-lane' } else { 'changed-tests' }
                $testPaths = @($discovered | Where-Object {
                    $selectionMode -eq 'integration-lane' -or $_ -in $changedPaths
                })
                if ($testPaths.Count -eq 0) {
                    throw 'PILOT_VALIDATION_PROFILE_ERROR: no affected native integration tests selected'
                }
                [System.IO.File]::WriteAllText($selectionPath, ([ordered]@{
                    mode = $selectionMode
                    changedPaths = $testInputs
                    sharedChanges = $sharedChanges
                    expectedPaths = $testPaths
                } | ConvertTo-Json -Depth 8))
                $phase = 'test'
                Invoke-Checked node $jest --config $configurationPath `
                    --runTestsByPath @testPaths --runInBand --passWithNoTests=false `
                    --json --outputFile $resultPath
            }
            finally {
                Pop-Location
            }
            $phase = 'result-verification'
            $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
            $actualPaths = @($result.testResults | ForEach-Object { [System.IO.Path]::GetFullPath($_.name) })
            if (-not $result.success -or $result.numTotalTests -lt 1 -or
                $result.numPassedTests -ne $result.numTotalTests -or
                $actualPaths.Count -ne $testPaths.Count -or
                @($actualPaths | Select-Object -Unique).Count -ne $actualPaths.Count -or
                @($testPaths | Where-Object { $_ -notin $actualPaths }).Count -gt 0 -or
                @($result.testResults | Where-Object {
                    @($_.assertionResults).Count -eq 0 -or
                    @($_.assertionResults | Where-Object { $_.status -ne 'passed' }).Count -gt 0
                }).Count -gt 0) {
                throw 'PILOT_VALIDATION_PROFILE_ERROR: native Jest results do not prove all selected tests passed'
            }
            $state = 'passed'
            $proof = [ordered]@{
                resultPath = $resultPath
                suiteCount = $actualPaths.Count
                testCount = $result.numTotalTests
                passedCount = $result.numPassedTests
            }
            Write-Output "PILOT_VALIDATION_TEST_RESULT:$($proof | ConvertTo-Json -Compress)"
            Pop-Location
            try {
                Invoke-Checked -Executable git -Arguments @('clean', '-fd')
            }
            finally {
                Push-Location 'midgard'
            }
        }
        catch {
            $primaryError = $_
            if ($phase -ne 'test' -and $_.Exception.Message -notmatch 'PILOT_VALIDATION_PROFILE_ERROR:') {
                throw "PILOT_VALIDATION_PROFILE_ERROR: native $phase failed: $($_.Exception.Message)"
            }
            throw
        }
        finally {
            try {
                [System.IO.File]::WriteAllText((Join-Path $artifactDirectory 'run.json'), ([ordered]@{
                    state = $state
                    phase = $phase
                    baseRevision = $env:PILOT_VALIDATION_BASE_REVISION
                    revision = $env:PILOT_VALIDATION_REVISION
                    selectedSuiteCount = $testPaths.Count
                    resultPresent = Test-Path -LiteralPath $resultPath -PathType Leaf
                    typecheck = 'not-run-integration-tsconfig-not-declared'
                } | ConvertTo-Json -Depth 8))
            }
            catch {
                if ($null -eq $primaryError) { throw }
                Write-Warning 'PILOT_VALIDATION_SECONDARY_FAILURE: native run manifest could not be persisted'
            }
        }
    }
}
finally {
    Pop-Location
}
