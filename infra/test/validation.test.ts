import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, validateMonitorInput, valueAtPath } from '../src/shared/validation.js';

test('accepts a public HTTPS monitor', () => {
  const result = validateMonitorInput({ name: 'Example API', url: 'https://example.com/health', method: 'GET', expectedStatus: 200, timeoutMs: 3000, intervalMinutes: 5 });
  assert.equal(result.url, 'https://example.com/health');
  assert.equal(result.method, 'GET');
});

test('rejects local and private targets', () => {
  assert.throws(() => validateMonitorInput({ name: 'Local API', url: 'http://localhost:3000', method: 'GET' }), /Private or local/);
  assert.throws(() => validateMonitorInput({ name: 'Metadata', url: 'http://169.254.169.254/latest/meta-data', method: 'GET' }), /Private or local/);
  assert.throws(() => validateMonitorInput({ name: 'Mapped loopback', url: 'http://[::ffff:7f00:1]', method: 'GET' }), /Private or local/);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('198.51.100.10'), true);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('reads nested values for JSON assertions', () => {
  assert.equal(valueAtPath({ services: [{ status: 'ok' }] }, '$.services[0].status'), 'ok');
});
