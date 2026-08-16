const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAssertions, isPrivateAddress, runHealthCheck, valueAtPath } = require('../src/check-engine');

test('reads simple JSON paths and array indices', () => {
  const data = { status: 'ok', services: [{ name: 'api' }] };
  assert.equal(valueAtPath(data, '$.status'), 'ok');
  assert.equal(valueAtPath(data, '$.services[0].name'), 'api');
});

test('evaluates supported assertions', () => {
  const result = evaluateAssertions({ bodyText: '{"status":"ok","version":2}', assertions: [
    { type: 'json_path_exists', path: '$.version' },
    { type: 'json_path_equals', path: '$.status', value: 'ok' },
    { type: 'contains_text', value: 'version' }
  ] });
  assert.equal(result.ok, true);
});

test('returns an actionable assertion failure', () => {
  const result = evaluateAssertions({ bodyText: '{"status":"down"}', assertions: [{ type: 'json_path_equals', path: '$.status', value: 'ok' }] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected "ok"/);
});

test('blocks private and link-local network targets', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.1.2', '172.20.0.1', '192.168.1.2', '169.254.169.254', '198.51.100.2', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1']) assert.equal(isPrivateAddress(address), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('performs a successful health check through an injected fetch', async () => {
  const response = new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await runHealthCheck({ url: 'https://example.com/health', method: 'GET', expectedStatus: 200, timeoutMs: 500, assertions: [{ type: 'json_path_equals', path: '$.status', value: 'ok' }] }, { fetchImpl: async () => response, skipNetworkValidation: true });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
});
