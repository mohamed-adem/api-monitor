const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeChecks } = require('../public/analytics');

function checks(results, latencies = results.map((_, index) => (index + 1) * 100)) {
  return results.map((ok, index) => ({ ok, latency: latencies[index], createdAt: `2026-01-01T00:0${index}:00.000Z` }));
}

test('calculates latency percentiles and failure rate from observed checks', () => {
  const result = summarizeChecks(checks([true, true, false, true, true], [100, 200, 300, 400, 500]));
  assert.equal(result.p50, 300);
  assert.equal(result.p95, 500);
  assert.equal(result.failureRate, 20);
  assert.equal(result.sampleSize, 5);
});

test('classifies repeatedly changing results as flaky', () => {
  const result = summarizeChecks(checks([true, false, true, false, true, true]));
  assert.equal(result.stateChanges, 4);
  assert.equal(result.label, 'Flaky');
});

test('does not label tiny samples as stable or flaky', () => {
  assert.equal(summarizeChecks(checks([true, false])).label, 'Gathering data');
  assert.equal(summarizeChecks([]).failureRate, null);
});
