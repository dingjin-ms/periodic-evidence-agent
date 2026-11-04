$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Native process containment requires PowerShell 7.3+' }
$PSNativeCommandArgumentPassing = 'Standard'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$request = $env:PILOT_NATIVE_COMMAND | ConvertFrom-Json
Remove-Item Env:\PILOT_NATIVE_COMMAND
if (!$request.executable -or $request.args -isnot [Array]) { throw 'Invalid native command request' }
if (($env:PATHEXT -split ';') -notcontains '.EXE') {
    throw 'Native validation requires PATHEXT including .EXE; command was not launched'
}
$native = $ExecutionContext.SessionState.InvokeCommand.GetCommand(
    [string]$request.executable, [System.Management.Automation.CommandTypes]::Application)
if ($null -eq $native) { throw 'Native validation executable did not resolve to an application; command was not launched' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NativeValidationJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // The supervisor alone owns this non-inheritable handle. Its exit, including
    // execFile timeout/overflow termination, closes the job and all descendants.
    static IntPtr ownedJob;
    public static void Enter() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "Native process containment failed; command was not launched");
        }
        ownedJob = job;
    }
}
'@
[NativeValidationJob]::Enter()
$recordPath = $env:PILOT_PHASE_NATIVE_EVENTS
Remove-Item Env:\PILOT_PHASE_NATIVE_EVENTS
function Record-NativePhase($phase, $detail) {
    $row = @{ phase=$phase; at=[DateTime]::UtcNow.ToString('o'); detail=$detail } | ConvertTo-Json -Depth 5 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($row + [Environment]::NewLine)
    $stream = [IO.File]::Open($recordPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
Record-NativePhase 'containment-established' @{ supervisorPid=$PID }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $native.Source
$info.WorkingDirectory = [Environment]::CurrentDirectory
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($argument in $request.args) { $info.ArgumentList.Add([string]$argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
try {
    if (!$process.Start()) { throw 'Native child was not started' }
    $outCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $errCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    Record-NativePhase 'native-started' @{ pid=$process.Id; creationTimeTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); executable=$native.Source }
    if (!$process.WaitForExit([int]$request.nativeDeadlineMs)) {
        Record-NativePhase 'native-deadline' @{ pid=$process.Id; timeoutMs=[int]$request.nativeDeadlineMs }
        # Exiting this sole Job Object owner releases the entire owned tree.
        exit 124
    }
    [Threading.Tasks.Task]::WaitAll(@($outCopy, $errCopy))
    $code = $process.ExitCode
    Record-NativePhase 'native-exited' @{ pid=$process.Id; exitCode=$code }
    exit $code
} catch {
    Record-NativePhase 'native-start-or-wait-failed' @{ exceptionType=$_.Exception.GetType().Name }
    throw
} finally { $process.Dispose() }
