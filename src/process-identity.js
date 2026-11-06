import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { requireThat } from './common.js';

const format = 'windows-process-identity-v1';
const pidValid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;
export function validateProcessIdentity(value) {
  requireThat(value?.format === format && value.host === hostname() && pidValid(value.pid) &&
    typeof value.creationTimeTicks === 'string' && /^[1-9][0-9]{17}$/.test(value.creationTimeTicks),
  'Verified OS process identity is missing or invalid', 'blocked-process-identity');
  return value;
}

// CIM CreationDate is converted to invariant UTC ticks without millisecond truncation.
// Only requested PIDs and creation times are returned; no command lines or credentials.
export function readProcessIdentities(pids, execute = execFileSync, probe = pid => process.kill(pid, 0)) {
  requireThat(process.platform === 'win32' && Array.isArray(pids) && pids.length > 0 && pids.length <= 64 &&
    pids.every(pidValid), 'Process identity inspection requires bounded Windows PIDs', 'blocked-process-identity');
  const requested = [...new Set(pids)];
  const script = `$ErrorActionPreference='Stop'; $ids=ConvertFrom-Json $env:PILOT_PROCESS_IDS; $filter=($ids | ForEach-Object { 'ProcessId = '+[uint32]$_ }) -join ' OR '; $self=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID) -ErrorAction Stop; if(!$self.CreationDate){throw 'Process visibility unavailable'}; $rows=@(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop); $result=@($rows | ForEach-Object { if(!$_.CreationDate){throw 'Process creation time unavailable'}; @{ pid=[long]$_.ProcessId; creationTimeTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } }); ConvertTo-Json -Compress -InputObject $result`;
  let rows;
  try {
    rows = JSON.parse(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PILOT_PROCESS_IDS: JSON.stringify(requested) }, encoding: 'utf8', timeout: 30000,
      maxBuffer: 65536, windowsHide: true
    }).trim());
  } catch {
    requireThat(false, 'OS process visibility/creation time could not be verified', 'blocked-process-identity');
  }
  requireThat(Array.isArray(rows) && rows.length <= requested.length && new Set(rows.map(row => row.pid)).size === rows.length &&
    rows.every(row => requested.includes(row.pid)), 'Invalid OS process identity response', 'blocked-process-identity');
  for (const pid of requested.filter(pid => !rows.some(row => row.pid === pid))) {
    let absent = false;
    try { probe(pid); } catch (error) { if (error.code === 'ESRCH') absent = true; }
    requireThat(absent, 'OS process visibility is unavailable or changed during inspection', 'blocked-process-identity');
  }
  return rows.map(row => validateProcessIdentity({ format, host: hostname(), pid: row.pid, creationTimeTicks: row.creationTimeTicks }));
}

export function captureProcessIdentity(pid, read = readProcessIdentities) {
  requireThat(pidValid(pid), 'Invalid process capture PID', 'blocked-process-identity');
  const rows = read([pid]);
  requireThat(Array.isArray(rows) && rows.length === 1 && rows[0].pid === pid,
    'Original process exited before its identity was captured', 'blocked-process-identity');
  return validateProcessIdentity(rows[0]);
}

let ownIdentity;
export function currentProcessIdentity() {
  // This module instance cannot outlive the process whose immutable start time it caches.
  return { ...(ownIdentity ??= captureProcessIdentity(process.pid)) };
}

export function verifyProcessRelease(identities, read = readProcessIdentities) {
  requireThat(Array.isArray(identities) && identities.length > 0 && identities.length <= 64,
    'Original process identities are required', 'blocked-process-identity');
  identities.forEach(validateProcessIdentity);
  const pids = [...new Set(identities.map(value => value.pid))];
  const observed = read(pids);
  requireThat(Array.isArray(observed) && observed.length <= pids.length && new Set(observed.map(value => value.pid)).size === observed.length &&
    observed.every(value => pids.includes(value.pid)), 'Process visibility is incomplete or invalid', 'blocked-process-identity');
  observed.forEach(validateProcessIdentity);
  return identities.map(original => {
    const current = observed.find(value => value.pid === original.pid);
    requireThat(!current || current.creationTimeTicks !== original.creationTimeTicks,
      'Original process is still present with its recorded creation time', 'overlap');
    requireThat(!current || BigInt(current.creationTimeTicks) > BigInt(original.creationTimeTicks),
      'Observed process creation time precedes recorded ownership', 'blocked-process-identity');
    return { original, state: current ? 'pid-reused' : 'exited', ...(current ? { observed: current } : {}) };
  });
}
