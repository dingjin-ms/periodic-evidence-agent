$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Native process containment requires PowerShell 7.3+' }
$PSNativeCommandArgumentPassing = 'Standard'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$request = $env:PILOT_NATIVE_COMMAND | ConvertFrom-Json
Remove-Item Env:\PILOT_NATIVE_COMMAND
if ($request.jobName -notmatch '^Local\\PilotNative-[a-f0-9-]{36}$') { throw 'Invalid native job identity' }
if ($request.action -notin @('drain', 'compile') -and (!$request.executable -or $request.args -isnot [Array])) { throw 'Invalid native command request' }
if ($request.action -notin @('drain', 'compile')) {
    if (($env:PATHEXT -split ';') -notcontains '.EXE') {
        throw 'Native validation requires PATHEXT including .EXE; command was not launched'
    }
    $native = $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        [string]$request.executable, [System.Management.Automation.CommandTypes]::Application)
    if ($null -eq $native) { throw 'Native validation executable did not resolve to an application; command was not launched' }
}

$definition = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

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
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long ProcessTime, JobTime, PeriodProcessTime, PeriodJobTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // The supervisor alone owns this non-inheritable handle. Its exit, including
    // execFile timeout/overflow termination, closes the job and all descendants.
    static IntPtr ownedJob;
    public static void Enter(string name) {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
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
    public static void Drain(string name) {
        IntPtr job = OpenJobObject(4, false, name);
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return;
            throw new Win32Exception(error, "Cannot inspect owned native job");
        }
        try {
            var timer = Stopwatch.StartNew();
            while (true) {
                Accounting info;
                if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (info.ActiveProcesses == 0) return;
                if (timer.ElapsedMilliseconds >= 10000)
                    throw new TimeoutException("Owned native processes did not exit");
                Thread.Sleep(25);
            }
        } finally { CloseHandle(job); }
    }
}
'@
if ($request.action -eq 'compile') {
    # Compile only this trusted definition, in memory, before any application can run.
    Add-Type -AssemblyName Microsoft.CodeAnalysis.CSharp
    $references = [Microsoft.CodeAnalysis.MetadataReference[]]@(
        Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll' |
            ForEach-Object { [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile($_.FullName) }
    )
    $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($definition)
    $options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new(
        [Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary)
    $compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create(
        'PilotNativeJob', [Microsoft.CodeAnalysis.SyntaxTree[]]@($tree), $references, $options)
    $stream = [IO.MemoryStream]::new()
    try {
        $result = $compilation.Emit($stream)
        if (!$result.Success) {
            throw (($result.Diagnostics | ForEach-Object { $_.ToString() }) -join "`n")
        }
        [Console]::WriteLine([Convert]::ToBase64String($stream.ToArray()))
    } finally { $stream.Dispose() }
    exit 0
}
if ($request.assemblyFromStdin -eq $true) {
    $bytes = [Convert]::FromBase64String([Console]::ReadLine())
    $null = [Reflection.Assembly]::Load($bytes)
} else {
    Add-Type -TypeDefinition $definition
}
if ($request.action -eq 'drain') {
    [NativeValidationJob]::Drain([string]$request.jobName)
    exit 0
}
[NativeValidationJob]::Enter([string]$request.jobName)
$arguments = @($request.args | ForEach-Object { [string]$_ })
$global:LASTEXITCODE = $null
& $native @arguments
if ($null -eq $LASTEXITCODE) { throw 'Native validation did not produce a process exit code' }
exit $LASTEXITCODE
