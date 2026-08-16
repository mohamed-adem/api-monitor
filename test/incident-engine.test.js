const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCheckToMonitor } = require('../src/incident-engine');

test('opens an incident after the configured failure threshold', () => {
  const first = applyCheckToMonitor({ monitorId: 'mon_1', status: 'UP', failureStreak: 0 }, { ok: false, latencyMs: 50, reason: '500', checkedAt: '2026-09-10T00:00:00.000Z' });
  assert.equal(first.monitor.status, 'DEGRADED');
  assert.equal(first.events.length, 0);
  const second = applyCheckToMonitor(first.monitor, { ok: false, latencyMs: 60, reason: '500', checkedAt: '2026-09-10T00:01:00.000Z' });
  assert.equal(second.monitor.status, 'DOWN');
  assert.equal(second.events[0].type, 'INCIDENT_OPENED');
});

test('resolves an active incident after recovery', () => {
  const result = applyCheckToMonitor({ monitorId: 'mon_1', status: 'DOWN', failureStreak: 3, activeIncidentId: 'inc_1' }, { ok: true, latencyMs: 40, checkedAt: '2026-09-10T00:02:00.000Z' });
  assert.equal(result.monitor.status, 'UP');
  assert.equal(result.monitor.activeIncidentId, undefined);
  assert.equal(result.events[0].type, 'INCIDENT_RESOLVED');
});
