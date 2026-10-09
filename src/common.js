import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export class PilotError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireThat(condition, message, code = 'blocked-config') {
  if (!condition) throw new PilotError(code, message);
}
export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value);
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function utc(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)), 'Expected an explicit UTC timestamp');
  return value;
}
export function windowCheck(window) {
  utc(window.start); utc(window.end);
  requireThat(Date.parse(window.start) < Date.parse(window.end), 'Window must be nonempty and half-open');
}
export function positive(value, name) {
  requireThat(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}
export function safeError(error) {
  if (error instanceof PilotError) return { code: error.code, message: error.message };
  // Library errors can contain request headers, source payloads or credentials.
  return { code: 'failed', message: `Operation failed (${error?.name ?? 'Error'}); inspect the operation and supported sign-in state, not credential caches.` };
}
export function boundedPath(root, name, { write = false } = {}) {
  requireThat(typeof name === 'string' && name && !isAbsolute(name) &&
    !name.includes(':') && !name.includes('\0'), 'Invalid relative path', 'blocked-scope');
  const base = realpathSync(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  requireThat(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel), 'Path escapes workspace', 'blocked-scope');
  const parts = rel.split(sep);
  requireThat(!parts.some(p => ['.git', '.copilot', '.env'].includes(p.toLowerCase()) ||
    p.toLowerCase().startsWith('.env.')), 'Protected path', 'blocked-scope');
  let current = base;
  for (const part of parts) {
    current = resolve(current, part);
    if (existsSync(current)) {
      requireThat(!lstatSync(current).isSymbolicLink(), 'Symlink/reparse paths are not allowed', 'blocked-scope');
      if (write && lstatSync(current).isFile()) requireThat(lstatSync(current).nlink === 1, 'Hard-linked writes are not allowed', 'blocked-scope');
    }
  }
  if (!write) requireThat(existsSync(target), 'Requested path does not exist', 'unavailable');
  return target;
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const contracts = readJson(new URL('../scaffold/contracts.schema.json', import.meta.url));
ajv.addSchema(contracts, 'contracts');
export function validateRecord(value, type = value.recordType) {
  const validate = ajv.getSchema(`contracts#/$defs/${type}`);
  requireThat(validate && validate(value), `Invalid ${type} record: ${ajv.errorsText(validate?.errors)}`, 'invalid-record');
  return value;
}
export const exclusions = contracts.$defs.exclusion.enum;
export function configAt(path) {
  const config = readJson(path);
  requireThat(config.version === 1, 'Unsupported configuration version');
  windowCheck(config.window);
  requireThat(config.activation && ['collect', 'review', 'dispatch'].every(k => typeof config.activation[k] === 'boolean'),
    'Explicit collect/review/dispatch activation booleans are required');
  requireThat(config.statePolicy?.retention === 'manual-no-auto-delete', 'Only explicit manual retention is supported');
  requireThat([0, 1].includes(config.followUp.maxDepth), 'Follow-up is limited to zero or one level');
  if (config.followUp.maxDepth === 1) {
    positive(config.followUp.maxItems, 'followUp.maxItems'); positive(config.followUp.maxToolCalls, 'followUp.maxToolCalls');
  }
  requireThat(Array.isArray(config.repositories), 'repositories must be an array');
  config.stateDirectory = resolve(dirname(resolve(path)), config.stateDirectory);
  return config;
}
export function collectionPreflight(config) {
  requireThat(config.activation.collect === true, 'Live collection is disabled');
  requireThat(config.statePolicy.accessApproved === true, 'Approve state directory ACLs and manual retention before storing live evidence');
  requireThat(config.identity.designatedUser, 'Designated delegated user is unresolved');
  positive(config.limits.maxItems, 'maxItems'); positive(config.limits.maxCalls, 'maxCalls');
}
export function modelPreflight(config) {
  requireThat(Number.isFinite(config.limits.maxAiCreditsPerSession) && config.limits.maxAiCreditsPerSession > 0,
    'A positive per-session AI credit ceiling must be approved before model execution');
}
export class Budget {
  constructor(limits) { this.items = positive(limits.maxItems, 'maxItems'); this.calls = positive(limits.maxCalls, 'maxCalls'); }
  call() { requireThat(this.calls-- > 0, 'Tool-call budget exhausted; coverage is partial', 'partial'); }
  item(count = 1) { this.items -= count; requireThat(this.items >= 0, 'Item budget exhausted; coverage is partial', 'partial'); }
}
