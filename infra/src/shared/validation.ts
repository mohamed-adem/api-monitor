import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import type { AlertEventType, Assertion, MaintenanceWindow } from './model.js';

const MAX_MAINTENANCE_MS = 7 * 24 * 60 * 60 * 1000;

function validateMaintenanceWindow(value: unknown): MaintenanceWindow | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Maintenance window must include a start and end time');
  const raw = value as Record<string, unknown>;
  const starts = Date.parse(String(raw.startsAt || ''));
  const ends = Date.parse(String(raw.endsAt || ''));
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) throw new Error('Maintenance window must include valid start and end times');
  if (ends <= starts) throw new Error('Maintenance window must end after it starts');
  if (ends - starts > MAX_MAINTENANCE_MS) throw new Error('Maintenance window cannot exceed 7 days');
  if (ends <= Date.now()) throw new Error('Maintenance window must end in the future');
  const reason = String(raw.reason || 'Scheduled maintenance').trim();
  if (!reason || reason.length > 160) throw new Error('Maintenance reason must be between 1 and 160 characters');
  return { startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), reason };
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    const mapped = value.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (mapped?.[2] && mapped[3]) {
      const high = Number.parseInt(mapped[2], 16);
      const low = Number.parseInt(mapped[3], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8');
  }
  return true;
}

export function validateMonitorInput(input: Record<string, unknown>) {
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 80) throw new Error('Name must be between 2 and 80 characters');
  if (typeof input.url !== 'string') throw new Error('A URL is required');
  let url: URL;
  try { url = new URL(input.url); } catch { throw new Error('A valid URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', 'localhost.localdomain'].includes(hostname) || (net.isIP(hostname) > 0 && isPrivateAddress(hostname))) throw new Error('Private or local endpoints are not allowed');
  const method = String(input.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD checks are supported in the MVP');
  const expectedStatus = Number(input.expectedStatus ?? 200);
  const timeoutMs = Number(input.timeoutMs ?? 3000);
  const intervalMinutes = Number(input.intervalMinutes ?? 5);
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new Error('Expected status must be between 100 and 599');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30000) throw new Error('Timeout must be between 250 and 30000 milliseconds');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('Interval must be between 1 and 1440 minutes');
  const assertions = Array.isArray(input.assertions) ? input.assertions : [];
  if (assertions.length > 10) throw new Error('A monitor supports at most 10 assertions');
  for (const assertion of assertions as Assertion[]) {
    if (!['contains_text', 'json_path_exists', 'json_path_equals'].includes(assertion.type)) throw new Error(`Unsupported assertion type: ${String(assertion.type)}`);
    if ('path' in assertion && (typeof assertion.path !== 'string' || !assertion.path.startsWith('$.'))) throw new Error('JSON assertion paths must start with $.');
  }
  return { name: input.name.trim(), url: url.toString(), method: method as 'GET' | 'HEAD', expectedStatus, timeoutMs, intervalMinutes, assertions: assertions as Assertion[], maintenanceWindow: validateMaintenanceWindow(input.maintenanceWindow) };
}

export function validateAlertPreferenceInput(input: Record<string, unknown>) {
  const email = String(input.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid alert email is required');
  const allowed = new Set<AlertEventType>(['incident_opened', 'incident_resolved']);
  const events = Array.isArray(input.events) ? [...new Set(input.events.map(String))] : [];
  if (!events.length || events.some(event => !allowed.has(event as AlertEventType))) throw new Error('Select at least one valid alert event');
  return { email, events: events as AlertEventType[] };
}

export function validatePublicIncidentUpdate(input: Record<string, unknown>) {
  const publicTitle = String(input.publicTitle || '').trim();
  const publicMessage = String(input.publicMessage || '').trim();
  if (publicTitle.length > 100) throw new Error('Public incident title cannot exceed 100 characters');
  if (publicMessage.length > 500) throw new Error('Public incident message cannot exceed 500 characters');
  return { publicTitle, publicMessage };
}

export function validateStatusPageInput(input: Record<string, unknown>) {
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 80) throw new Error('Status page name must be between 2 and 80 characters');
  const slug = String(input.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) throw new Error('Slug must be 3 to 40 lowercase letters, numbers, or hyphens');
  const monitorIds = Array.isArray(input.monitorIds) ? [...new Set(input.monitorIds.map(String))] : [];
  if (!monitorIds.length || monitorIds.length > 20) throw new Error('Select between 1 and 20 monitors');
  if (monitorIds.some(id => !/^mon_[a-zA-Z0-9-]+$/.test(id))) throw new Error('A selected monitor ID is invalid');
  return { name: input.name.trim(), slug, monitorIds, published: input.published !== false };
}

export async function assertPublicDestination(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Private or reserved network targets are not allowed');
}

export function valueAtPath(input: unknown, path: string): unknown {
  if (path === '$') return input;
  if (!path.startsWith('$.')) return undefined;
  const keys = path.slice(2).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return keys.reduce<unknown>((value, key) => value == null ? undefined : (value as Record<string, unknown>)[key], input);
}
