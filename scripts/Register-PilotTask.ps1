[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Config,
    [string]$TaskName = 'Periodic evidence pilot',
    [switch]$Enable
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($settings.schedule.kind -ne 'daily' -or $settings.schedule.timeZone -ne 'Asia/Shanghai' -or
    $settings.schedule.hour -ne 9 -or $settings.schedule.minute -ne 0) {
    throw 'Only the approved daily 09:00 Asia/Shanghai cadence is supported.'
}
if ($Enable -and (-not $settings.schedule.enabled -or -not $settings.activation.collect)) {
    throw 'Enabling the task also requires explicit schedule.enabled and activation.collect in the config.'
}
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entrypoint = Join-Path $root 'src\cli.js'
if ($configPath.Contains('"') -or $entrypoint.Contains('"')) { throw 'Unsupported quote in path.' }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entrypoint`" tick --config `"$configPath`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$nextUtc = [DateTime]::UtcNow.Date.AddHours(1)
if ($nextUtc -le [DateTime]::UtcNow) { $nextUtc = $nextUtc.AddDays(1) }
$trigger.StartBoundary = $nextUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $options
$task.Settings.Enabled = [bool]$Enable
if ($PSCmdlet.ShouldProcess($TaskName, "Register local pilot task (enabled=$([bool]$Enable)); requires logged-in user")) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -ErrorAction Stop |
        Select-Object TaskName, State
}
