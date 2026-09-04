(function exposeAnalytics(root) {
  function percentile(values, percentileValue) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))];
  }

  function summarizeChecks(checks) {
    const observed = (checks || []).filter(check => typeof check.ok === 'boolean');
    const chronological = [...observed].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const latencies = observed.map(check => Number(check.latency)).filter(Number.isFinite);
    const failures = observed.filter(check => !check.ok).length;
    let stateChanges = 0;
    for (let index = 1; index < chronological.length; index += 1) {
      if (chronological[index].ok !== chronological[index - 1].ok) stateChanges += 1;
    }
    const failureRate = observed.length ? failures / observed.length * 100 : null;
    let label = 'Gathering data';
    if (observed.length >= 5) {
      if (stateChanges >= 3) label = 'Flaky';
      else if (failureRate >= 25) label = 'Needs attention';
      else if (failures > 0) label = 'Mostly stable';
      else label = 'Stable';
    }
    return {
      sampleSize: observed.length,
      failures,
      failureRate,
      stateChanges,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      label
    };
  }

  const api = { summarizeChecks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PulseAnalytics = api;
})(typeof window !== 'undefined' ? window : globalThis);
