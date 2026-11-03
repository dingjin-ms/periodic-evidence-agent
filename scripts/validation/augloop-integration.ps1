param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('qualification', 'candidate')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory
)
$ErrorActionPreference = 'Stop'

# PILOT_VALIDATION_PLAN: {"version":3,"stages":["dependencies","compile","policy","test"],"authentication":{"type":"azure-artifacts-npm","provider":"artifacts-npm-credprovider","providerVersion":"1.2.1","feeds":[{"scope":null,"registry":"https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/"}]},"testOnlyPrefixes":["server/session-protocol/test/integration-evolution/","utils/doclab-serialization/tests/","utils/eval-vnext-config-resolver/tests/","utils/excel-agent-in-container-proxy/tests/"],"lockfilePaths":["package.json","yarn.lock",".yarnrc.yml",".node-version"],"buildConfigPaths":["lage.config.js","tsconfig.json","jest.config.base.js","jest.setup.js","jest.setupAfterEnv.js","jest-uuid-resolver.js","server/test-config.json","server/session-protocol/package.json","server/session-protocol/gulpfile.js","server/session-protocol/tsconfig.json","utils/doclab-serialization/package.json","utils/doclab-serialization/gulpfile.js","utils/doclab-serialization/tsconfig.json","utils/doclab-serialization/jest.config.js","utils/eval-vnext-config-resolver/package.json","utils/eval-vnext-config-resolver/gulpfile.js","utils/eval-vnext-config-resolver/tsconfig.json","utils/eval-vnext-config-resolver/jest.config.js","utils/excel-agent-in-container-proxy/package.json","utils/excel-agent-in-container-proxy/gulpfile.js","utils/excel-agent-in-container-proxy/tsconfig.json","utils/excel-agent-in-container-proxy/jest.config.js"],"dependencySnapshotPaths":["node_modules",".yarn/install-state.gz"],"preparedOutputPaths":["server/session-protocol/dist","utils/doclab-serialization/dist","utils/eval-vnext-config-resolver/dist","utils/excel-agent-in-container-proxy/dist"]}

$owners = @(
    @{ Path = 'server/session-protocol'; Package = '@augloop/session-protocol'; Tests = 'test/integration-evolution/'; Runner = 'mocha'; Script = 'gulp test' },
    @{ Path = 'utils/doclab-serialization'; Package = '@augloop-utils/doclab-serialization'; Tests = 'tests/'; Runner = 'jest'; Script = 'run -T jest' },
    @{ Path = 'utils/eval-vnext-config-resolver'; Package = '@augloop-utils/eval-vnext-config-resolver'; Tests = 'tests/'; Runner = 'jest'; Script = 'run -T jest' },
    @{ Path = 'utils/excel-agent-in-container-proxy'; Package = '@augloop-utils/excel-agent-in-container-proxy'; Tests = 'tests/'; Runner = 'jest'; Script = 'run -T jest' }
)
$stage = if ($env:PILOT_VALIDATION_STAGE) { $env:PILOT_VALIDATION_STAGE } else { 'all' }
$yarn = '.yarn/releases/yarn-3.2.1.cjs'
if ($stage -notin @('all', 'fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test')) {
    throw "Unsupported AL validation stage: $stage"
}
if (-not [IO.Path]::IsPathFullyQualified($ArtifactDirectory)) {
    throw 'AL artifacts require an absolute private directory'
}
$artifactRoot = [IO.Path]::GetFullPath($ArtifactDirectory)
$workspaceRoot = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (($artifactRoot + [IO.Path]::DirectorySeparatorChar).StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'AL artifacts and runner caches must be outside the immutable validation workspace'
}

function Invoke-Checked {
    param([string]$Executable, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
}
function Assert-Clean {
    $sparse = & git config --bool core.sparseCheckout
    if ($LASTEXITCODE -notin @(0, 1)) { throw 'Could not determine AL sparse checkout mode' }
    if ($sparse -eq 'true') {
        $cargo = @(& git ls-files -- Cargo.toml Cargo.lock)
        if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate tracked AL Cargo inputs' }
        # Materialization can invalidate stat metadata for native clean-filtered locks.
        if ($cargo.Count -gt 0) { Invoke-Checked git add --renormalize -- @cargo }
    }
    $changes = @(& git status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0 -or $changes.Count -gt 0) {
        throw "AL validation workspace is not clean: $($changes -join '; ')"
    }
}
function Assert-Owners {
    foreach ($owner in $owners) {
        $package = Get-Content -LiteralPath "$($owner.Path)/package.json" -Raw | ConvertFrom-Json
        if ($package.name -ne $owner.Package -or $package.scripts.build -ne 'gulp build' -or $package.scripts.test -ne $owner.Script) {
            throw "Unsupported native owner contract: $($owner.Path)"
        }
    }
}
function Get-Selection {
    foreach ($revision in @($env:PILOT_VALIDATION_BASE_REVISION, $env:PILOT_VALIDATION_REVISION)) {
        if ($revision -notmatch '^[a-f0-9]{40}$') { throw 'Missing exact AL validation revisions' }
    }
    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $env:PILOT_VALIDATION_REVISION) { throw 'AL validation HEAD mismatch' }
    if ($Mode -eq 'qualification') {
        if ($env:PILOT_VALIDATION_BASE_REVISION -ne $head) { throw 'Qualification must use the unchanged baseline' }
        $paths = @(& git -c core.quotepath=false ls-files -- ($owners | ForEach-Object { "$($_.Path)/$($_.Tests)" }))
        if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate original qualification tests' }
        $tests = @($paths | Where-Object { $_.EndsWith('.integration.test.ts', [StringComparison]::Ordinal) })
        foreach ($owner in $owners) {
            if (@($tests | Where-Object { $_.StartsWith("$($owner.Path)/$($owner.Tests)", [StringComparison]::Ordinal) }).Count -eq 0) {
                throw "No original integration tests for qualification: $($owner.Path)"
            }
        }
        return $tests
    }
    $changes = @(& git -c core.quotepath=false diff --name-only --no-renames `
        $env:PILOT_VALIDATION_BASE_REVISION $head --)
    if ($LASTEXITCODE -ne 0 -or $changes.Count -eq 0) { throw 'A nonempty candidate diff is required' }
    foreach ($path in $changes) {
        $allowed = @($owners | Where-Object {
            $prefix = "$($_.Path)/$($_.Tests)"
            ($path.StartsWith($prefix, [StringComparison]::Ordinal) -and $path.EndsWith('.integration.test.ts', [StringComparison]::Ordinal)) -or
            $path.StartsWith("${prefix}fixtures/", [StringComparison]::Ordinal)
        })
        if ($allowed.Count -ne 1 -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Unsupported owner, non-integration edit, or deletion: $path"
        }
    }
    $tests = @($changes | Where-Object { $_.EndsWith('.integration.test.ts', [StringComparison]::Ordinal) })
    if ($tests.Count -eq 0) { throw 'A changed integration test is required' }
    return $tests
}
function Get-AuthStatus {
    $config = (Resolve-Path -LiteralPath '.yarnrc.yml').Path
    $registries = [regex]::Matches((Get-Content -LiteralPath $config -Raw), '(?m)^\s*npmRegistryServer:\s*["'']?([^"''\s]+)')
    $expected = 'https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/'
    if ($registries.Count -ne 1 -or $registries[0].Groups[1].Value -ne $expected) {
        throw 'AL authentication requires exactly its declared single feed'
    }
    $provider = Get-Command artifacts-npm-credprovider -ErrorAction SilentlyContinue
    if (-not $provider) { return 'provider-missing' }
    $manifest = Join-Path (Split-Path $provider.Source) 'node_modules\@microsoft\artifacts-npm-credprovider\package.json'
    if (-not (Test-Path -LiteralPath $manifest) -or
        (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version -ne '1.2.1') {
        return 'provider-version-mismatch'
    }
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        Push-Location -LiteralPath ([IO.Path]::GetTempPath())
        $output = @(& $provider.Source --validate-only --config-file $config --verbosity minimal 2>&1)
        $code = $LASTEXITCODE
    } finally { Pop-Location; $ErrorActionPreference = $previous }
    if ($code -ne 0 -or ($output -join "`n") -match 'need refresh') { return 'interactive-sign-in-required' }
    return 'ready'
}

if ($stage -notin @('authentication-check', 'authentication')) {
    if (-not (Test-Path -LiteralPath $yarn)) { throw 'Pinned AL Yarn is missing' }
    $nodeVersion = (& node --version).Trim()
    $requiredNode = (Get-Content -LiteralPath '.node-version' -Raw).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$requiredNode") { throw "AL requires Node $requiredNode" }
    Assert-Owners
}
if ($stage -eq 'fingerprint') {
    $yarnVersion = (& node $yarn --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $yarnVersion -ne '3.2.1') { throw 'AL requires pinned Yarn 3.2.1' }
    $corepackVersion = (& corepack --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Corepack fingerprint failed' }
    $fingerprint = [ordered]@{ node = $nodeVersion; yarn = $yarnVersion; corepack = $corepackVersion
        platform = [Environment]::OSVersion.Platform.ToString()
        architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
    Write-Output "PILOT_VALIDATION_FINGERPRINT:$($fingerprint | ConvertTo-Json -Compress)"
    exit 0
}
if ($stage -in @('authentication-check', 'authentication', 'all', 'dependencies')) {
    $auth = Get-AuthStatus
    $proof = [ordered]@{ provider = 'artifacts-npm-credprovider'; providerVersion = '1.2.1'; feedCount = 1; tokenRecorded = $false }
    if ($stage -eq 'authentication-check') {
        $proof.state = if ($auth -eq 'ready') { 'ready' } else { 'action-required-auth' }
        if ($auth -ne 'ready') { $proof.reason = $auth; $proof.installProvider = $auth.StartsWith('provider-') }
        Write-Output "PILOT_VALIDATION_AUTH_PREFLIGHT:$($proof | ConvertTo-Json -Compress)"
        exit 0
    }
    if ($auth -ne 'ready') { throw "PILOT_AUTH_ACTION_REQUIRED: $auth" }
    if ($stage -eq 'authentication') {
        Write-Output "PILOT_VALIDATION_AUTH:$($proof | ConvertTo-Json -Compress)"
        exit 0
    }
}
Assert-Clean
if ($stage -in @('all', 'dependencies')) {
    $sparse = & git config --bool core.sparseCheckout
    if ($LASTEXITCODE -notin @(0, 1)) { throw 'Could not determine AL sparse checkout mode' }
    # The native sparse plugin regenerates a local lock through its Git clean filter.
    $lockMode = if ($sparse -eq 'true') { '--no-immutable' } else { '--immutable' }
    Invoke-Checked node $yarn install $lockMode
    Assert-Clean
}
if ($stage -in @('all', 'compile')) {
    # The native CLI accepts multiple explicit packages and builds their dependency union.
    $packages = @($owners | ForEach-Object { $_.Package })
    Invoke-Checked augloop build @packages
    foreach ($owner in $owners) { Invoke-Checked node $yarn workspace $owner.Package build }
    Assert-Clean
}
if ($stage -in @('all', 'policy', 'test')) { $selected = @(Get-Selection) }
if ($stage -in @('all', 'policy')) {
    foreach ($owner in $owners) { Invoke-Checked node $yarn workspace $owner.Package exec gulp eslint }
    Assert-Clean
}
if ($stage -in @('all', 'test')) {
    New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
    foreach ($owner in $owners) {
        # Every declared mutable dist root is freshly compiled and exercised, even on cache hits.
        Invoke-Checked node $yarn workspace $owner.Package build
        Assert-Clean
        $name = ($owner.Path -replace '/', '-') + '-' + [guid]::NewGuid().ToString('N')
        $owningTests = @($selected | Where-Object { $_.StartsWith("$($owner.Path)/", [StringComparison]::Ordinal) })
        if ($owner.Runner -eq 'jest') {
            $output = Join-Path $artifactRoot "$name.json"
            Invoke-Checked node $yarn workspace $owner.Package test --runInBand `
                --passWithNoTests=false --json --outputFile $output --cacheDirectory (Join-Path $artifactRoot "$name-cache")
            $result = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
            if ($result.success -ne $true -or $result.numPassedTests -le 0 -or
                $result.numFailedTests -ne 0 -or $result.numFailedTestSuites -ne 0) {
                throw "Native Jest did not pass a nonempty package run: $($owner.Path)"
            }
            foreach ($test in $owningTests) {
                $relative = $test.Substring($owner.Path.Length + 1)
                $compiled = [IO.Path]::GetFullPath("$($owner.Path)/dist/" + $relative.Substring(0, $relative.Length - 3) + '.js')
                $suite = @($result.testResults | Where-Object { [IO.Path]::GetFullPath($_.name) -eq $compiled })
                if ($suite.Count -ne 1 -or $suite[0].assertionResults.Count -eq 0 -or
                    @($suite[0].assertionResults | Where-Object { $_.status -ne 'passed' }).Count -ne 0) {
                    throw "Native Jest did not execute every selected assertion: $test"
                }
            }
            $suiteCount = $result.numPassedTestSuites
            $testCount = $result.numPassedTests
        } else {
            # Preserve the package's Gulp/Mocha/c8 setup and its native JUnit reporter.
            $nativeOutput = "$($owner.Path)/logs/test-results.xml"
            $startedAt = [DateTime]::UtcNow
            Invoke-Checked node $yarn workspace $owner.Package test
            if ((Get-Item -LiteralPath $nativeOutput).LastWriteTimeUtc -lt $startedAt) {
                throw 'Native Mocha did not refresh its result'
            }
            $output = Join-Path $artifactRoot "$name.xml"
            Copy-Item -LiteralPath $nativeOutput -Destination $output
            [xml]$mochaResult = Get-Content -LiteralPath $output -Raw
            $cases = @($mochaResult.SelectNodes('//testcase'))
            if ($cases.Count -eq 0 -or @($mochaResult.SelectNodes('//failure|//error')).Count -gt 0) {
                throw 'Native Mocha did not prove a nonempty passing package run'
            }
            # The native reporter omits pending testcases, but retains stats.pending on the root.
            if (@($mochaResult.SelectNodes('//*[@skipped]') | Where-Object {
                $_.GetAttribute('skipped') -ne '0'
            }).Count -gt 0) {
                throw 'Native Mocha reported pending assertions; omitted testcase details cannot prove selected execution'
            }
            foreach ($test in $owningTests) {
                $relative = $test.Substring($owner.Path.Length + 1)
                $compiled = [IO.Path]::GetFullPath("$($owner.Path)/dist/" + $relative.Substring(0, $relative.Length - 3) + '.js')
                $suites = @($mochaResult.SelectNodes('//testsuite[@file]') | Where-Object {
                    [IO.Path]::GetFullPath($_.file) -eq $compiled
                })
                $assertions = @($suites | ForEach-Object { $_.SelectNodes('.//testcase') })
                if ($assertions.Count -eq 0 -or @($assertions | Where-Object { $_.SelectSingleNode('skipped') }).Count -gt 0) {
                    throw "Native Mocha did not execute every selected assertion: $test"
                }
            }
            $suiteCount = @($mochaResult.SelectNodes('//testsuite')).Count
            $testCount = @($cases | Where-Object { -not $_.SelectSingleNode('skipped') }).Count
            if ($testCount -le 0) { throw 'Mocha executed no passing tests' }
        }
        Assert-Clean
        $proof = [ordered]@{ mode = $Mode; owner = $owner.Path; package = $owner.Package; runner = $owner.Runner
            sourceRevision = $env:PILOT_VALIDATION_REVISION; baseRevision = $env:PILOT_VALIDATION_BASE_REVISION
            suiteCount = $suiteCount; testCount = $testCount; selectedTests = $owningTests
            resultPath = $output; resultSha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() }
        Write-Output "PILOT_VALIDATION_TEST_RESULT:$($proof | ConvertTo-Json -Depth 5 -Compress)"
    }
}
