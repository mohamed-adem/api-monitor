import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import type { Assertion } from './model.js';

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
  return { name: input.name.trim(), url: url.toString(), method: method as 'GET' | 'HEAD', expectedStatus, timeoutMs, intervalMinutes, assertions: assertions as Assertion[] };
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
