$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Native process containment requires PowerShell 7.3+' }
$PSNativeCommandArgumentPassing = 'Standard'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$request = $env:PILOT_NATIVE_COMMAND | ConvertFrom-Json
Remove-Item Env:\PILOT_NATIVE_COMMAND
if ($request.jobName -notmatch '^Local\\PilotNative-[a-f0-9-]{36}$') { throw 'Invalid native job identity' }
if ($request.action -ne 'drain' -and (!$request.executable -or $request.args -isnot [Array])) { throw 'Invalid native command request' }
if ($request.action -ne 'drain') {
    if (($env:PATHEXT -split ';') -notcontains '.EXE') {
        throw 'Native validation requires PATHEXT including .EXE; command was not launched'
    }
    $native = $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        [string]$request.executable, [System.Management.Automation.CommandTypes]::Application)
    if ($null -eq $native) { throw 'Native validation executable did not resolve to an application; command was not launched' }
}

$assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('PilotNativeInterop'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('PilotNativeInterop')

function New-NativeStruct([string]$name, [object[]]$fields) {
    $builder = $module.DefineType($name,
        [Reflection.TypeAttributes]'Public,Sealed,SequentialLayout,BeforeFieldInit', [ValueType])
    foreach ($field in $fields) {
        [void]$builder.DefineField($field[0], $field[1], [Reflection.FieldAttributes]::Public)
    }
    return $builder.CreateType()
}

$basic = New-NativeStruct 'NativeBasicLimits' @(
    @('ProcessTime', [long]), @('JobTime', [long]), @('Flags', [uint32]),
    @('MinimumWorkingSet', [UIntPtr]), @('MaximumWorkingSet', [UIntPtr]),
    @('ActiveProcesses', [uint32]), @('Affinity', [UIntPtr]),
    @('Priority', [uint32]), @('Scheduling', [uint32])
)
$io = New-NativeStruct 'NativeIoCounters' @(
    @('ReadOperations', [uint64]), @('WriteOperations', [uint64]), @('OtherOperations', [uint64]),
    @('ReadBytes', [uint64]), @('WriteBytes', [uint64]), @('OtherBytes', [uint64])
)
$limits = New-NativeStruct 'NativeExtendedLimits' @(
    @('Basic', $basic), @('Io', $io),
    @('ProcessMemory', [UIntPtr]), @('JobMemory', [UIntPtr]),
    @('PeakProcessMemory', [UIntPtr]), @('PeakJobMemory', [UIntPtr])
)
$accounting = New-NativeStruct 'NativeAccounting' @(
    @('ProcessTime', [long]), @('JobTime', [long]), @('PeriodProcessTime', [long]),
    @('PeriodJobTime', [long]), @('PageFaults', [uint32]), @('TotalProcesses', [uint32]),
    @('ActiveProcesses', [uint32]), @('TerminatedProcesses', [uint32])
)
$kernel = $module.DefineType('NativeJobKernel', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
$dllAttribute = [Runtime.InteropServices.DllImportAttribute]
$constructor = $dllAttribute.GetConstructor([Type[]]@([string]))

function Add-NativeImport([string]$name, [Type]$result, [Type[]]$parameters,
    [bool]$lastError = $true, [Runtime.InteropServices.CharSet]$charSet = 'None') {
    # Define the import once via DllImport metadata, including SetLastError.
    $method = $kernel.DefineMethod($name,
        [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', $result, $parameters)
    if ($name -eq 'QueryInformationJobObject') {
        [void]$method.DefineParameter(3, [Reflection.ParameterAttributes]::Out, 'info')
    }
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    $fields = [Reflection.FieldInfo[]]@(
        $dllAttribute.GetField('SetLastError'), $dllAttribute.GetField('CharSet'),
        $dllAttribute.GetField('CallingConvention'), $dllAttribute.GetField('EntryPoint'))
    $values = [object[]]@($lastError, $charSet,
        [Runtime.InteropServices.CallingConvention]::Winapi, $name)
    $method.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new(
        $constructor, [object[]]@('kernel32.dll'), $fields, $values))
}

Add-NativeImport 'CreateJobObject' ([IntPtr]) @([IntPtr], [string]) $true 'Unicode'
Add-NativeImport 'SetInformationJobObject' ([bool]) @([IntPtr], [int], $limits.MakeByRefType(), [uint32])
Add-NativeImport 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
Add-NativeImport 'OpenJobObject' ([IntPtr]) @([uint32], [bool], [string]) $true 'Unicode'
Add-NativeImport 'QueryInformationJobObject' ([bool]) @(
    [IntPtr], [int], $accounting.MakeByRefType(), [uint32], [IntPtr])
Add-NativeImport 'GetCurrentProcess' ([IntPtr]) @() $false
Add-NativeImport 'CloseHandle' ([bool]) @([IntPtr]) $false
$kernel = $kernel.CreateType()

if ($request.action -eq 'drain') {
    $job = $kernel::OpenJobObject(4, $false, [string]$request.jobName)
    if ($job -eq [IntPtr]::Zero) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 2) { exit 0 }
        throw [ComponentModel.Win32Exception]::new($errorCode, 'Cannot inspect owned native job')
    }
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            $info = [Activator]::CreateInstance([NativeAccounting])
            if (!$kernel::QueryInformationJobObject($job, 1, [ref]$info,
                [uint32][Runtime.InteropServices.Marshal]::SizeOf([Type][NativeAccounting]), [IntPtr]::Zero)) {
                throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
            }
            if ($info.ActiveProcesses -eq 0) { exit 0 }
            if ($timer.ElapsedMilliseconds -ge 10000) {
                throw [TimeoutException]::new('Owned native processes did not exit')
            }
            [Threading.Thread]::Sleep(25)
        }
    } finally { [void]$kernel::CloseHandle($job) }
}
$job = $kernel::CreateJobObject([IntPtr]::Zero, [string]$request.jobName)
if ($job -eq [IntPtr]::Zero) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
$limits = [Activator]::CreateInstance([NativeExtendedLimits])
$basic = [Activator]::CreateInstance([NativeBasicLimits])
$basic.Flags = 0x2000
$limits.Basic = $basic
if (!$kernel::SetInformationJobObject($job, 9, [ref]$limits,
    [uint32][Runtime.InteropServices.Marshal]::SizeOf([Type][NativeExtendedLimits])) -or
    !$kernel::AssignProcessToJobObject($job, $kernel::GetCurrentProcess())) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [void]$kernel::CloseHandle($job)
    throw [ComponentModel.Win32Exception]::new($errorCode, 'Native process containment failed; command was not launched')
}
# The supervisor alone owns this non-inheritable handle. Its exit, including
# execFile timeout/overflow termination, closes the job and all descendants.
$script:ownedJob = $job
$arguments = @($request.args | ForEach-Object { [string]$_ })
$global:LASTEXITCODE = $null
& $native @arguments
if ($null -eq $LASTEXITCODE) { throw 'Native validation did not produce a process exit code' }
exit $LASTEXITCODE
