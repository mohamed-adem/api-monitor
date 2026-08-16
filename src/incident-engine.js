function applyCheckToMonitor(monitor, check, failureThreshold = 2) {
  const now = check.checkedAt || new Date().toISOString();
  const next = { ...monitor, lastCheckedAt: now, lastLatencyMs: check.latencyMs };
  const events = [];

  if (check.ok) {
    next.failureStreak = 0;
    next.status = 'UP';
    if (monitor.activeIncidentId) {
      events.push({ type: 'INCIDENT_RESOLVED', incidentId: monitor.activeIncidentId, resolvedAt: now });
      delete next.activeIncidentId;
    }
  } else {
    next.failureStreak = (monitor.failureStreak || 0) + 1;
    next.status = next.failureStreak >= failureThreshold ? 'DOWN' : 'DEGRADED';
    if (next.failureStreak === failureThreshold && !monitor.activeIncidentId) {
      const incidentId = `inc_${Date.parse(now)}_${monitor.monitorId || monitor.id}`;
      next.activeIncidentId = incidentId;
      events.push({ type: 'INCIDENT_OPENED', incidentId, startedAt: now, reason: check.reason });
    }
  }
  return { monitor: next, events };
}

module.exports = { applyCheckToMonitor };
