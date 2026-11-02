param(
    [Parameter(Mandatory)][string]$InputFile,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$inputRecord = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
$pipeline = $inputRecord.contract.pipeline
$directory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$buildId = $inputRecord.buildId
if ($buildId -isnot [long] -and $buildId -isnot [int] -or $buildId -le 0) { throw 'Exact build identity required' }
$artifactName = "$($pipeline.artifactPrefix)$buildId"
$destination = Join-Path $directory 'job-artifact'
$completed = Join-Path $directory 'download-completed.json'
if (-not (Test-Path -LiteralPath $destination)) {
    & az pipelines runs artifact download --organization $pipeline.organization --project $pipeline.project `
        --run-id $buildId --artifact-name $artifactName --path $destination --only-show-errors *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination)) {
        throw 'Artifact download failed or produced no directory; no acceptance'
    }
    [IO.File]::WriteAllText($completed, (@{
        jobId = $inputRecord.jobId; buildId = $buildId; artifactName = $artifactName
    } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} else {
    if (-not (Test-Path -LiteralPath $completed)) {
        throw 'Partial artifact download exists; preserve it and reconcile, do not overwrite'
    }
    $receipt = Get-Content -LiteralPath $completed -Raw | ConvertFrom-Json
    if ($receipt.jobId -cne $inputRecord.jobId -or $receipt.buildId -ne $buildId -or
        $receipt.artifactName -cne $artifactName) { throw 'Existing download identity differs' }
}
@{ downloaded = $true; buildId = $buildId } | ConvertTo-Json
