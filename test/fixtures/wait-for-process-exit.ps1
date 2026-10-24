param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $ProcessId
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class FixtureProcessExit
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void Wait(int pid, uint milliseconds)
    {
        // GetProcessById and kill(pid, 0) can report absence before kernel exit.
        IntPtr handle = OpenProcess(0x00100000, false, pid);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 87) throw new Win32Exception(error, "Cannot open fixture process " + pid);
            Console.WriteLine("Process " + pid + " is gone");
            return;
        }
        try
        {
            Console.WriteLine("Waiting for kernel exit of process " + pid);
            uint result = WaitForSingleObject(handle, milliseconds);
            if (result == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (result != 0)
                throw new TimeoutException("Fixture process " + pid + " did not signal exit; wait result " + result);
        }
        finally
        {
            if (!CloseHandle(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@
# Exercise the negative case in this already initialized host, not another cold launch.
try {
    [FixtureProcessExit]::Wait($PID, 0)
    throw 'The exit barrier incorrectly accepted its own active process'
}
catch [TimeoutException] {}
[FixtureProcessExit]::Wait($ProcessId, 5000)
