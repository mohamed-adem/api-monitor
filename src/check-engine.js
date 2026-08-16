const dns = require('node:dns').promises;
const net = require('node:net');

function valueAtPath(input, path) {
  if (path === '$') return input;
  if (typeof path !== 'string' || !path.startsWith('$.')) return undefined;
  const parts = path.slice(2).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return parts.reduce((value, key) => value == null ? undefined : value[key], input);
}

function evaluateAssertions({ assertions = [], bodyText = '', contentType = '' }) {
  let parsed;
  const getJson = () => {
    if (parsed !== undefined) return parsed;
    try { parsed = JSON.parse(bodyText); return parsed; }
    catch { parsed = null; return null; }
  };

  for (const assertion of assertions) {
    if (assertion.type === 'contains_text' && !bodyText.includes(String(assertion.value))) {
      return { ok: false, reason: `Response did not contain: ${assertion.value}` };
    }
    if (assertion.type === 'json_path_exists') {
      const json = getJson();
      if (!json || valueAtPath(json, assertion.path) === undefined) {
        return { ok: false, reason: `JSON path does not exist: ${assertion.path}` };
      }
    }
    if (assertion.type === 'json_path_equals') {
      const json = getJson();
      const actual = json ? valueAtPath(json, assertion.path) : undefined;
      if (!json || actual !== assertion.value) {
        return { ok: false, reason: `JSON path ${assertion.path} expected ${JSON.stringify(assertion.value)}, received ${JSON.stringify(actual)}` };
      }
    }
  }
  return { ok: true, reason: assertions.length ? 'All assertions passed' : 'Healthy response', contentType };
}

function isPrivateAddress(address) {
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
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (mapped?.[2] && mapped[3]) {
      const high = Number.parseInt(mapped[2], 16);
      const low = Number.parseInt(mapped[3], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8');
  }
  return true;
}

async function validatePublicUrl(rawUrl, lookup = dns.lookup) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('A valid URL is required'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (parsed.username || parsed.password) throw new Error('URLs with embedded credentials are not supported');
  if (['localhost', 'localhost.localdomain'].includes(parsed.hostname.toLowerCase())) throw new Error('Private or local endpoints are not allowed');
  const addresses = await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('Private or reserved network targets are not allowed');
  return parsed;
}

async function runHealthCheck(monitor, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  if (!options.skipNetworkValidation) await validatePublicUrl(monitor.url, options.lookup || dns.lookup);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs);
  try {
    const response = await fetchImpl(monitor.url, { method: monitor.method, signal: controller.signal, redirect: 'manual', headers: { 'user-agent': 'Pulse-API-Monitor/0.1' } });
    const bodyText = await response.text();
    const latencyMs = Date.now() - startedAt;
    if (response.status !== monitor.expectedStatus) return { ok: false, statusCode: response.status, latencyMs, reason: `Expected status ${monitor.expectedStatus}, received ${response.status}` };
    if (latencyMs > monitor.timeoutMs) return { ok: false, statusCode: response.status, latencyMs, reason: `Latency ${latencyMs}ms exceeded ${monitor.timeoutMs}ms` };
    const assertionResult = evaluateAssertions({ assertions: monitor.assertions, bodyText, contentType: response.headers.get('content-type') || '' });
    return { ...assertionResult, statusCode: response.status, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return { ok: false, statusCode: null, latencyMs, reason: error.name === 'AbortError' ? `Timed out after ${monitor.timeoutMs}ms` : `Request failed: ${error.message}` };
  } finally { clearTimeout(timer); }
}

module.exports = { evaluateAssertions, isPrivateAddress, runHealthCheck, validatePublicUrl, valueAtPath };
