const $ = selector => document.querySelector(selector);
let state = { monitors: [], incidents: [], checks: [], statusPage: null, alertPreferences: null };
let config = { mode: 'local' };
let currentView = location.hash.replace('#', '') || 'overview';
let selectedMonitorId = null;
let loading = false;
let publicRefreshTimer = null;

const auth = {
  get accessToken() { return sessionStorage.getItem('pulseAccessToken'); },
  get refreshToken() { return sessionStorage.getItem('pulseRefreshToken'); },
  setSession(result, email) {
    sessionStorage.setItem('pulseAccessToken', result.AccessToken);
    sessionStorage.setItem('pulseIdToken', result.IdToken);
    if (result.RefreshToken) sessionStorage.setItem('pulseRefreshToken', result.RefreshToken);
    sessionStorage.setItem('pulseEmail', email);
  },
  clear() {
    for (const key of ['pulseAccessToken', 'pulseIdToken', 'pulseRefreshToken', 'pulseEmail']) sessionStorage.removeItem(key);
  }
};

async function load() {
  setLoading(true);
  config = await fetch('/api/config', { cache: 'no-store' }).then(response => response.ok ? response.json() : ({ mode: 'local' })).catch(() => ({ mode: 'local' }));
  const publicSlug = getPublicStatusSlug();
  if (publicSlug) {
    try { await loadPublicStatusPage(publicSlug); }
    finally { setLoading(false); }
    return;
  }
  if (config.mode === 'aws' && !auth.accessToken) { setLoading(false); return showAuth('signin'); }
  try {
    state = config.mode === 'aws' ? await loadAwsState() : await fetch('/api/summary').then(response => response.json());
    $('#authScreen').classList.add('hidden');
    $('#publicStatusScreen').classList.add('hidden');
    $('.app-shell').classList.remove('hidden');
    render();
    clearGlobalMessage();
    finishBoot();
  } catch (error) {
    if (error.status === 401) {
      auth.clear();
      return showAuth('signin', 'Your session expired. Sign in again.');
    }
    showGlobalMessage(error.message || 'Could not load Pulse. Try refreshing.', 'error');
  } finally {
    setLoading(false);
  }
}

async function loadAwsState() {
  const [monitorPayload, incidentPayload, statusPagePayload, alertPayload] = await Promise.all([apiFetch('/api/monitors'), apiFetch('/api/incidents'), apiFetch('/api/status-page'), apiFetch('/api/alert-preferences')]);
  const rawMonitors = monitorPayload.items || [];
  const checksByMonitor = await Promise.all(rawMonitors.map(monitor => apiFetch(`/api/monitors/${monitor.monitorId}/checks`).then(payload => payload.items || [])));
  const checks = checksByMonitor.flat().map(normalizeCheck).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const monitors = rawMonitors.map(monitor => normalizeMonitor(monitor, checks.filter(check => check.monitorId === monitor.monitorId)));
  return { monitors, checks, incidents: (incidentPayload.items || []).map(normalizeIncident), statusPage: statusPagePayload.item || null, alertPreferences: alertPayload.item || null };
}

function getPublicStatusSlug() {
  const match = location.hash.match(/^#status\/([a-z0-9-]+)$/);
  return match ? match[1] : null;
}

async function loadPublicStatusPage(slug) {
  clearTimeout(publicRefreshTimer);
  $('.app-shell').classList.add('hidden');
  $('#authScreen').classList.add('hidden');
  $('#publicStatusScreen').classList.remove('hidden');
  $('#publicStatusContent').innerHTML = '<div class="public-status-loading">Loading current service health…</div>';
  try {
    const response = await fetch(`/api/status/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    const page = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(page.error || 'This status page is unavailable.');
    const monitors = page.monitors || [];
    const incidents = page.incidents || [];
    const ongoing = incidents.filter(item => String(item.status).toUpperCase() === 'OPEN');
    const recovered = incidents.filter(item => String(item.status).toUpperCase() === 'RESOLVED').slice(0, 5);
    const overall = monitors.some(item => ['DOWN', 'DEGRADED'].includes(String(item.status).toUpperCase())) ? 'Some systems are experiencing issues' : monitors.some(item => String(item.status).toUpperCase() === 'MAINTENANCE') ? 'Scheduled maintenance in progress' : 'All systems operational';
    const healthy = !overall.includes('issues');
    $('#publicStatusContent').innerHTML = `<header class="public-status-header"><p class="eyebrow">SERVICE STATUS</p><h1>${escapeHtml(page.name)}</h1><p class="muted">Live health for ${monitors.length} ${monitors.length === 1 ? 'service' : 'services'}.</p></header><section class="public-overall ${healthy ? 'healthy' : 'issue'}"><span>${healthy ? '✓' : '!'}</span><div><strong>${overall}</strong><small>Updated ${formatTime(page.generatedAt)}</small></div></section><section class="public-service-list">${monitors.length ? monitors.map(item => { const status = String(item.status || 'PENDING').toLowerCase(); const okay = status === 'up'; return `<article><div><strong>${escapeHtml(item.name)}</strong><small>${item.lastCheckedAt ? `Checked ${formatTime(item.lastCheckedAt)}` : 'Awaiting first check'}${Number.isFinite(item.lastLatencyMs) ? ` · ${item.lastLatencyMs}ms` : ''}</small></div><span class="public-badge ${okay ? 'up' : status}">${escapeHtml(monitorStatusLabel(status))}</span></article>`; }).join('') : '<div class="empty-state roomy">No services are currently listed.</div>'}</section><section class="public-incidents"><h2>Ongoing incidents</h2>${ongoing.length ? ongoing.map(incident => publicIncidentRow(incident, monitors, false)).join('') : '<p class="public-clear">✓ No ongoing incidents</p>'}</section>${recovered.length ? `<section class="public-incidents public-history"><h2>Recent recoveries</h2>${recovered.map(incident => publicIncidentRow(incident, monitors, true)).join('')}</section>` : ''}`;
    publicRefreshTimer = setTimeout(() => loadPublicStatusPage(slug), 60_000);
  } catch (error) {
    $('#publicStatusContent').innerHTML = `<section class="public-not-found"><span>◎</span><h1>Status page unavailable</h1><p>${escapeHtml(error.message)}</p><a href="/">Return to Pulse</a></section>`;
  }
  finishBoot();
}

function publicIncidentRow(incident, monitors, resolved) {
  const monitor = monitors.find(item => item.monitorId === incident.monitorId);
  return `<article><div class="public-incident-title"><strong>${escapeHtml(incident.publicTitle || monitor?.name || 'Service incident')}</strong>${resolved ? '<span>Resolved</span>' : ''}</div><p>${escapeHtml(incident.publicMessage || (resolved ? 'This service has recovered.' : 'We are investigating this interruption.'))}</p><small>${resolved ? `Recovered ${formatTime(incident.resolvedAt)}` : `Started ${formatTime(incident.startedAt)}`}${incident.publicUpdatedAt ? ` · Updated ${formatTime(incident.publicUpdatedAt)}` : ''}</small></article>`;
}

function normalizeMonitor(monitor, checks) {
  const latencies = checks.map(check => check.latency).sort((a, b) => a - b);
  const uptime = checks.length ? checks.filter(check => check.ok).length / checks.length * 100 : null;
  const status = String(monitor.status || 'PENDING').toLowerCase();
  return { ...monitor, id: monitor.monitorId, status: monitor.enabled === false ? 'paused' : status, uptime, p95: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * .95) - 1)] : null, color: ['down', 'degraded'].includes(status) ? 'orange' : 'purple' };
}

function normalizeCheck(check) {
  return { ...check, id: check.jobId, latency: check.latencyMs, createdAt: check.observedAt || String(check.checkedAt).split('#')[0] };
}

function normalizeIncident(incident) {
  const open = incident.status === 'OPEN';
  return { ...incident, id: incident.incidentId, title: open ? 'Endpoint check failed' : 'Endpoint recovered', open, duration: open ? 'Ongoing' : durationBetween(incident.startedAt, incident.resolvedAt) };
}

async function apiFetch(path, options = {}, retried = false) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${auth.accessToken}`, ...(options.headers || {}) } });
  if (response.status === 401 && !retried && auth.refreshToken) {
    try {
      const result = await cognito('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: config.userPoolClientId, AuthParameters: { REFRESH_TOKEN: auth.refreshToken } });
      auth.setSession(result.AuthenticationResult, sessionStorage.getItem('pulseEmail') || '');
      return apiFetch(path, options, true);
    } catch { /* Fall through to the original unauthorized response. */ }
  }
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function render() {
  const monitors = state.monitors;
  const open = state.incidents.filter(incident => incident.open).length;
  const completedChecks = state.checks.filter(check => new Date(check.createdAt).toDateString() === new Date().toDateString());
  const measured = monitors.filter(monitor => monitor.uptime !== null && monitor.uptime !== undefined);
  $('#incidentCount').textContent = open;
  $('#openText').textContent = open;
  $('#checksText').textContent = completedChecks.length || '—';
  $('#uptimeText').textContent = measured.length ? `${(measured.reduce((total, monitor) => total + monitor.uptime, 0) / measured.length).toFixed(2)}%` : '—';
  $('#systemText').textContent = monitors.some(monitor => monitor.status === 'down') ? 'Action needed' : monitors.some(monitor => monitor.status === 'degraded') ? 'Degraded' : 'Operational';
  const email = sessionStorage.getItem('pulseEmail');
  if (config.mode === 'aws') {
    $('#greetingName').textContent = email ? email.split('@')[0] : 'there';
    $('#profileName').textContent = email || 'Pulse user';
    $('#profileSubtitle').textContent = 'Account';
    $('#profileMenuEmail').textContent = email || 'PULSE ACCOUNT';
    $('#profileButton').classList.add('clickable');
    $('#accountEmail').textContent = email || 'Pulse user';
    $('#accountAuth').textContent = 'Amazon Cognito';
    $('#accountRegion').textContent = config.region || '—';
  } else {
    $('#accountEmail').textContent = 'Local preview';
    $('#accountAuth').textContent = 'Local mode';
    $('#accountRegion').textContent = '—';
  }
  renderView();
  $('#monitorList').innerHTML = monitors.length ? monitors.map(monitor => monitorRow(monitor)).join('') : '<p class="empty-state roomy">No monitors yet. Add your first endpoint to begin.</p>';
  $('#incidentList').innerHTML = state.incidents.length ? state.incidents.slice(0, 4).map(incident => `<div class="incident"><i class="incident-dot ${incident.open ? 'open' : ''}"></i><div><strong>${escapeHtml(incident.title)}</strong><small>${escapeHtml(incident.reason)}<br>${formatTime(incident.startedAt)} · ${escapeHtml(incident.duration)}</small></div><span class="resolved ${incident.open ? 'open-label' : ''}">${incident.open ? 'Open' : '✓ Resolved'}</span></div>`).join('') : '<p class="muted">No incidents yet. Nice work.</p>';
  document.querySelectorAll('[data-run]').forEach(button => button.onclick = () => runCheck(button));
  document.querySelectorAll('[data-details]').forEach(button => button.onclick = () => showDetails(button.dataset.details));
  renderMonitorManagement();
  renderCheckRuns();
  renderIncidentHistory();
  renderReliabilityInsights();
  renderStatusPageEditor();
  renderAlertPreferences();
}

const viewCopy = {
  overview: ['MONITORING / OVERVIEW', null, "Here's what's happening with your endpoints."],
  monitors: ['MONITORING / MONITORS', 'Monitors', 'Create, inspect, pause, edit, and remove endpoint checks.'],
  checks: ['MONITORING / CHECK RUNS', 'Check runs', 'Inspect the latest synthetic requests and failure reasons.'],
  incidents: ['MONITORING / INCIDENTS', 'Incident history', 'See when failures began, recovered, and how long they lasted.'],
  insights: ['MONITORING / RELIABILITY', 'Reliability insights', 'Compare latency, failure rate, and result stability across monitors.'],
  'status-page': ['MONITORING / STATUS PAGE', 'Public status page', 'Share service health and active incidents without requiring sign-in.'],
  help: ['PULSE / HELP CENTER', 'Help center', 'Set up reliable monitors and understand what Pulse is telling you.'],
  account: ['WORKSPACE / ACCOUNT', 'Account & security', 'Review your signed-in session and account security.']
};

function navigate(view, options = {}) {
  if (!viewCopy[view]) view = 'overview';
  closeMenus();
  if (currentView === view && !options.fromHistory) return;
  currentView = view;
  if (!options.fromHistory) history.pushState({ view }, '', `#${view}`);
  renderView();
}

function renderView() {
  if (!viewCopy[currentView]) currentView = 'overview';
  document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.viewPanel !== currentView));
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === currentView));
  const [eyebrow, title, description] = viewCopy[currentView];
  $('#pageEyebrow').textContent = eyebrow;
  if (currentView === 'overview') {
    const email = sessionStorage.getItem('pulseEmail');
    $('#pageTitle').innerHTML = `Good morning, <span id="greetingName">${escapeHtml(config.mode === 'aws' && email ? email.split('@')[0] : 'there')}</span> <span>✦</span>`;
  } else $('#pageTitle').textContent = title;
  $('#pageDescription').textContent = description;
  $('#addBtn').classList.toggle('hidden', ['help', 'account', 'status-page'].includes(currentView));
}

function renderStatusPageEditor() {
  const page = state.statusPage;
  const form = $('#statusPageForm');
  if (!form) return;
  form.elements.name.value = page?.name || '';
  form.elements.slug.value = page?.slug || '';
  form.elements.published.checked = page?.published !== false;
  const selected = new Set(page?.monitorIds || []);
  $('#statusMonitorChoices').innerHTML = state.monitors.length ? state.monitors.map(monitor => `<label><input type="checkbox" name="monitorIds" value="${escapeHtml(monitor.id)}" ${selected.has(monitor.id) ? 'checked' : ''}><span><strong>${escapeHtml(monitor.name)}</strong><small>${escapeHtml(monitorStatusLabel(monitor.status))}</small></span></label>`).join('') : '<div class="empty-state"><strong>Add a monitor first</strong><span>A status page needs at least one service.</span></div>';
  const share = $('#statusPageShare');
  if (!page) {
    share.innerHTML = '<div class="status-share-empty"><span>◎</span><p>Save your page to create a shareable link.</p></div>';
    return;
  }
  const url = `${location.origin}/#status/${page.slug}`;
  share.innerHTML = `<span class="publish-state ${page.published ? 'live' : ''}">${page.published ? '● Published' : '○ Unpublished'}</span><code>${escapeHtml(url)}</code><div class="share-actions"><a class="run-btn" href="#status/${escapeHtml(page.slug)}" target="_blank" rel="noopener">Open page</a><button class="run-btn" type="button" id="copyStatusLink">Copy link</button><button class="run-btn danger" type="button" id="deleteStatusPage">Delete</button></div>`;
  $('#copyStatusLink').onclick = async () => {
    try { await navigator.clipboard.writeText(url); showToast('Public link copied', 'success'); }
    catch { showToast('Could not copy automatically', 'error'); }
  };
  $('#deleteStatusPage').onclick = deleteStatusPage;
}

async function statusPageRequest(options) {
  if (config.mode === 'aws') return apiFetch('/api/status-page', options);
  const response = await fetch('/api/status-page', { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Could not update status page');
  return payload;
}

async function deleteStatusPage() {
  if (!confirm('Delete this public status page? Its shared link will stop working.')) return;
  try {
    await statusPageRequest({ method: 'DELETE' });
    state.statusPage = null;
    renderStatusPageEditor();
    showToast('Status page deleted', 'success');
  } catch (error) { showToast(error.message, 'error'); }
}

function monitorStatusLabel(status) {
  return ({ up: 'Operational', pending: 'Not checked', down: 'Down', degraded: 'Degraded', paused: 'Paused', maintenance: 'Maintenance' })[status] || status;
}

function monitorRow(monitor, management = false) {
  const healthy = monitor.status === 'up';
  return `<div class="monitor-row ${management ? 'management-row' : ''}"><button class="monitor-name monitor-link" data-details="${escapeHtml(monitor.id)}"><span class="monitor-icon ${monitor.color === 'orange' ? 'orange' : monitor.color === 'blue' ? 'blue' : ''}">⌁</span><span><strong>${escapeHtml(monitor.name)}</strong><small>${escapeHtml(monitor.url)}</small></span></button><div class="status ${monitor.status}"><i class="dot ${healthy ? 'green-dot' : 'orange-dot'}"></i>${monitorStatusLabel(monitor.status)}</div><div class="monitor-metric"><strong>${monitor.uptime !== null && monitor.uptime !== undefined ? `${monitor.uptime.toFixed(2)}%` : '—'}</strong><small>recent uptime</small></div>${management ? `<div class="row-actions"><button class="run-btn" data-edit="${escapeHtml(monitor.id)}">Edit</button><button class="run-btn" data-toggle="${escapeHtml(monitor.id)}">${monitor.status === 'paused' ? 'Resume' : 'Pause'}</button><button class="run-btn danger" data-delete="${escapeHtml(monitor.id)}">Delete</button></div>` : `<button class="run-btn" data-run="${escapeHtml(monitor.id)}" ${monitor.status === 'paused' ? 'disabled title="Resume this monitor before running it"' : ''}>Run now</button>`}</div>`;
}

function renderMonitorManagement() {
  const query = ($('#monitorSearch')?.value || '').trim().toLowerCase();
  const status = $('#monitorStatusFilter')?.value || 'all';
  const monitors = state.monitors.filter(monitor => (status === 'all' || monitor.status === status) && (!query || `${monitor.name} ${monitor.url}`.toLowerCase().includes(query)));
  $('#allMonitorList').innerHTML = monitors.length ? monitors.map(monitor => monitorRow(monitor, true)).join('') : '<div class="empty-state roomy"><strong>No matching monitors</strong><span>Try changing your search or filter.</span></div>';
  bindMonitorActions($('#allMonitorList'));
}

function renderCheckRuns() {
  const monitorValue = $('#checkMonitorFilter').value;
  const currentOptions = state.monitors.map(monitor => `<option value="${escapeHtml(monitor.id)}">${escapeHtml(monitor.name)}</option>`).join('');
  $('#checkMonitorFilter').innerHTML = `<option value="all">All monitors</option>${currentOptions}`;
  if (state.monitors.some(monitor => monitor.id === monitorValue)) $('#checkMonitorFilter').value = monitorValue;
  const status = $('#checkStatusFilter').value;
  const monitorId = $('#checkMonitorFilter').value;
  const checks = state.checks.filter(check => (monitorId === 'all' || check.monitorId === monitorId) && (status === 'all' || (status === 'passed') === Boolean(check.ok)));
  $('#checkRunList').innerHTML = checks.length ? `<div class="table-head"><span>Result</span><span>Monitor</span><span>Reason</span><span>Latency</span><span>Observed</span></div>${checks.map(check => { const monitor = state.monitors.find(item => item.id === check.monitorId); return `<div class="table-row"><span class="status ${check.ok ? 'up' : 'down'}"><i class="dot ${check.ok ? 'green-dot' : 'orange-dot'}"></i>${check.ok ? 'Passed' : 'Failed'}</span><button class="table-link" data-details="${escapeHtml(check.monitorId)}">${escapeHtml(monitor?.name || 'Deleted monitor')}</button><span>${escapeHtml(check.reason || 'Request completed')}</span><strong>${Number.isFinite(check.latency) ? `${check.latency}ms` : '—'}</strong><time>${formatTime(check.createdAt)}</time></div>`; }).join('')}` : '<div class="empty-state roomy"><strong>No check runs found</strong><span>Run a monitor to record its first result.</span></div>';
  $('#checkRunList').querySelectorAll('[data-details]').forEach(button => button.onclick = () => showDetails(button.dataset.details));
}

function renderIncidentHistory() {
  const status = $('#incidentStatusFilter').value;
  const incidents = state.incidents.filter(incident => status === 'all' || (status === 'open') === Boolean(incident.open));
  $('#allIncidentList').innerHTML = incidents.length ? `<div class="table-head incident-head"><span>Status</span><span>Monitor</span><span>Failure reason</span><span>Started</span><span>Action</span></div>${incidents.map(incident => { const monitor = state.monitors.find(item => item.id === incident.monitorId); return `<div class="table-row incident-row"><span class="status ${incident.open ? 'down' : 'up'}"><i class="dot ${incident.open ? 'orange-dot' : 'green-dot'}"></i>${incident.open ? 'Open' : 'Resolved'}</span><button class="table-link" data-details="${escapeHtml(incident.monitorId)}">${escapeHtml(monitor?.name || 'Deleted monitor')}</button><span>${escapeHtml(incident.reason || 'Endpoint check failed')}</span><time>${formatTime(incident.startedAt)} · ${escapeHtml(incident.duration)}</time><button class="run-btn" data-public-update="${escapeHtml(incident.id)}" data-monitor-id="${escapeHtml(incident.monitorId)}">Public update</button></div>`; }).join('')}` : '<div class="empty-state roomy"><strong>No incidents found</strong><span>Incidents appear after two consecutive failed checks.</span></div>';
  $('#allIncidentList').querySelectorAll('[data-details]').forEach(button => button.onclick = () => showDetails(button.dataset.details));
  $('#allIncidentList').querySelectorAll('[data-public-update]').forEach(button => button.onclick = () => openIncidentUpdate(button.dataset.monitorId, button.dataset.publicUpdate));
}

function analyticsFor(monitorId) {
  return PulseAnalytics.summarizeChecks(state.checks.filter(check => check.monitorId === monitorId));
}

function renderReliabilityInsights() {
  const rows = state.monitors.map(monitor => ({ monitor, analytics: analyticsFor(monitor.id) }))
    .sort((a, b) => (b.analytics.failureRate ?? -1) - (a.analytics.failureRate ?? -1) || b.analytics.stateChanges - a.analytics.stateChanges);
  const measured = rows.filter(row => row.analytics.sampleSize > 0);
  const flaky = rows.filter(row => row.analytics.label === 'Flaky' || row.analytics.label === 'Needs attention').length;
  const totalChecks = measured.reduce((total, row) => total + row.analytics.sampleSize, 0);
  const slowest = measured.filter(row => row.analytics.p95 !== null).sort((a, b) => b.analytics.p95 - a.analytics.p95)[0];
  $('#insightStats').innerHTML = `<div class="stat-card"><div class="stat-top"><span>CHECKS ANALYZED</span></div><strong>${totalChecks || '—'}</strong><p>Latest loaded samples</p></div><div class="stat-card"><div class="stat-top"><span>MEASURED MONITORS</span></div><strong>${measured.length || '—'}</strong><p>With recorded results</p></div><div class="stat-card"><div class="stat-top"><span>NEEDS REVIEW</span></div><strong>${flaky}</strong><p>Flaky or high failure rate</p></div><div class="stat-card"><div class="stat-top"><span>HIGHEST P95</span></div><strong>${slowest ? `${slowest.analytics.p95}ms` : '—'}</strong><p>${escapeHtml(slowest?.monitor.name || 'Awaiting data')}</p></div>`;
  $('#reliabilityList').innerHTML = rows.length ? `<div class="table-head reliability-head"><span>Monitor</span><span>Assessment</span><span>Failure rate</span><span>p50 / p95</span><span>State changes</span><span>Sample</span></div>${rows.map(({ monitor, analytics }) => `<div class="table-row reliability-row"><button class="table-link" data-details="${escapeHtml(monitor.id)}">${escapeHtml(monitor.name)}</button><span class="reliability-label ${analytics.label.toLowerCase().replaceAll(' ', '-')}">${escapeHtml(analytics.label)}</span><strong>${analytics.failureRate === null ? '—' : `${analytics.failureRate.toFixed(1)}%`}</strong><span>${analytics.p50 === null ? '—' : `${analytics.p50}ms / ${analytics.p95}ms`}</span><strong>${analytics.stateChanges}</strong><span>${analytics.sampleSize} checks</span></div>`).join('')}` : '<div class="empty-state roomy"><strong>No monitors yet</strong><span>Add and run a monitor to build reliability insights.</span></div>';
  $('#reliabilityList').querySelectorAll('[data-details]').forEach(button => button.onclick = () => showDetails(button.dataset.details));
  const current = $('#analyticsMonitor').value;
  $('#analyticsMonitor').innerHTML = state.monitors.length ? state.monitors.map(monitor => `<option value="${escapeHtml(monitor.id)}">${escapeHtml(monitor.name)}</option>`).join('') : '<option value="">No monitors</option>';
  if (state.monitors.some(monitor => monitor.id === current)) $('#analyticsMonitor').value = current;
}

async function loadHistoricalAnalytics() {
  const monitorId = $('#analyticsMonitor').value;
  if (!monitorId) return;
  $('#historicalAnalytics').innerHTML = '<p class="empty-state">Loading persisted rollups…</p>';
  try {
    const payload = config.mode === 'aws' ? await apiFetch(`/api/monitors/${monitorId}/analytics?window=${$('#analyticsWindow').value}`) : await fetch(`/api/monitors/${monitorId}/analytics?window=${$('#analyticsWindow').value}`).then(response => response.json());
    const summary = payload.summary || {};
    const maxChecks = Math.max(...(payload.points || []).map(point => point.totalChecks), 1);
    const bars = (payload.points || []).map(point => `<div class="aggregate-bar"><span style="height:${Math.max(6, point.totalChecks / maxChecks * 100)}%" title="${point.totalChecks} checks · ${point.averageLatencyMs}ms average"></span><small>${formatAggregateLabel(point.bucketStart, payload.window)}</small></div>`).join('');
    $('#historicalAnalytics').innerHTML = `<div class="detail-metrics"><div><small>UPTIME</small><strong>${summary.uptime == null ? '—' : `${summary.uptime.toFixed(2)}%`}</strong></div><div><small>AVERAGE LATENCY</small><strong>${summary.averageLatencyMs == null ? '—' : `${summary.averageLatencyMs}ms`}</strong></div><div><small>CHECKS</small><strong>${summary.totalChecks || 0}</strong></div><div><small>FAILURES</small><strong>${summary.failures || 0}</strong></div></div>${bars ? `<div class="aggregate-chart">${bars}</div>` : '<p class="empty-state">No rollups exist for this period yet. New checks will populate them.</p>'}`;
  } catch (error) { $('#historicalAnalytics').innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; }
}

function formatAggregateLabel(value, window) { const date = new Date(value); return window === '24h' ? date.toLocaleTimeString([], { hour: 'numeric' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' }); }

function renderAlertPreferences() {
  const form = $('#alertPreferencesForm');
  if (!form) return;
  const item = state.alertPreferences;
  form.elements.email.value = item?.email || sessionStorage.getItem('pulseEmail') || '';
  for (const checkbox of form.querySelectorAll('[name="events"]')) checkbox.checked = item ? item.events.includes(checkbox.value) : true;
  $('#alertPreferenceStatus').textContent = item ? (item.status === 'CONFIRMED' ? '✓ Email alerts are active.' : 'Confirmation pending — open the AWS email and confirm the subscription.') : 'No email alerts configured.';
  $('#removeAlertPreferences').classList.toggle('hidden', !item);
}

async function runCheck(button) {
  button.disabled = true;
  button.textContent = config.mode === 'aws' ? 'Queueing…' : 'Checking…';
  try {
    if (config.mode === 'aws') {
      await apiFetch(`/api/monitors/${button.dataset.run}/check`, { method: 'POST' });
      showToast('Check queued', 'success');
      setTimeout(load, 1800);
      setTimeout(load, 4500);
    } else {
      const response = await fetch(`/api/monitors/${button.dataset.run}/check`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Check failed');
      showToast(result.check.ok ? `Healthy · ${result.check.latency}ms` : result.check.reason, result.check.ok ? 'success' : 'error');
      await load();
    }
  } catch (error) {
    showToast(error.message, 'error');
    button.disabled = false;
    button.textContent = 'Run now';
  }
}

function showDetails(monitorId) {
  const monitor = state.monitors.find(item => item.id === monitorId);
  const checks = state.checks.filter(item => item.monitorId === monitorId).slice(0, 12);
  const incidents = state.incidents.filter(item => item.monitorId === monitorId).slice(0, 5);
  if (!monitor) return;
  const analytics = analyticsFor(monitorId);
  const maxLatency = Math.max(...checks.map(check => check.latency), 1);
  const bars = checks.length ? [...checks].reverse().map(check => `<span class="latency-bar ${check.ok ? '' : 'failed'}" style="height:${Math.max(8, check.latency / maxLatency * 100)}%" title="${check.latency}ms"></span>`).join('') : '<p class="empty-state">Run this monitor to build latency history.</p>';
  const assertions = monitor.assertions?.length ? monitor.assertions.map(assertion => `<code>${escapeHtml(assertion.type)} ${escapeHtml(assertion.path || assertion.value)}</code>`).join('') : '<span class="muted">No response assertions</span>';
  $('#detailContent').innerHTML = `<p class="eyebrow">MONITOR DETAIL</p><div class="detail-title"><div><h2>${escapeHtml(monitor.name)}</h2><p class="muted">${escapeHtml(monitor.url)}</p></div><span class="status ${monitor.status}"><i class="dot ${monitor.status === 'up' ? 'green-dot' : 'orange-dot'}"></i>${monitorStatusLabel(monitor.status)}</span></div><div class="detail-actions"><button class="run-btn" data-edit="${monitor.id}">Edit</button><button class="run-btn" data-toggle="${monitor.id}">${monitor.status === 'paused' ? 'Resume monitoring' : 'Pause monitoring'}</button><button class="run-btn danger" data-delete="${monitor.id}">Delete</button></div><div class="detail-metrics analytics-metrics"><div><small>UPTIME</small><strong>${monitor.uptime !== null && monitor.uptime !== undefined ? `${monitor.uptime.toFixed(2)}%` : '—'}</strong></div><div><small>P50 LATENCY</small><strong>${analytics.p50 === null ? '—' : `${analytics.p50}ms`}</strong></div><div><small>P95 LATENCY</small><strong>${analytics.p95 === null ? '—' : `${analytics.p95}ms`}</strong></div><div><small>FAILURE RATE</small><strong>${analytics.failureRate === null ? '—' : `${analytics.failureRate.toFixed(1)}%`}</strong></div><div><small>STATE CHANGES</small><strong>${analytics.stateChanges}</strong></div><div><small>ASSESSMENT</small><strong>${escapeHtml(analytics.label)}</strong></div></div><div class="detail-section"><div class="section-line"><h3>Latency history</h3><button class="run-btn" data-run="${monitor.id}" ${monitor.status === 'paused' ? 'disabled' : ''}>Run now</button></div><div class="latency-chart">${bars}</div></div><div class="detail-section"><h3>Configuration</h3><div class="config-grid"><span>Method <strong>${monitor.method}</strong></span><span>Expected <strong>${monitor.expectedStatus}</strong></span><span>Timeout <strong>${monitor.timeoutMs}ms</strong></span></div><div class="assertion-list">${assertions}</div></div><div class="detail-section"><h3>Recent checks</h3>${checks.length ? checks.map(check => `<div class="check-row"><span class="status ${check.ok ? 'up' : 'down'}"><i class="dot ${check.ok ? 'green-dot' : 'orange-dot'}"></i>${check.ok ? 'Passed' : 'Failed'}</span><span>${escapeHtml(check.reason)}</span><strong>${check.latency}ms</strong><small>${formatTime(check.createdAt)}</small></div>`).join('') : '<p class="empty-state">No checks recorded yet.</p>'}</div>${incidents.length ? `<div class="detail-section"><h3>Incidents</h3>${incidents.map(incident => `<div class="check-row"><span>${incident.open ? 'Open' : 'Resolved'}</span><span>${escapeHtml(incident.reason)}</span><strong>${escapeHtml(incident.duration)}</strong></div>`).join('')}</div>` : ''}`;
  $('#detailModal').classList.remove('hidden');
  const runButton = $('#detailContent').querySelector('[data-run]');
  if (runButton) runButton.onclick = event => runCheck(event.currentTarget);
  bindMonitorActions($('#detailContent'));
}

function bindMonitorActions(root) {
  root.querySelectorAll('[data-details]').forEach(button => button.onclick = () => showDetails(button.dataset.details));
  root.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => openMonitorForm(button.dataset.edit));
  root.querySelectorAll('[data-toggle]').forEach(button => button.onclick = () => toggleMonitor(button.dataset.toggle));
  root.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => deleteMonitor(button.dataset.delete));
}

function openMonitorForm(monitorId = null) {
  selectedMonitorId = monitorId;
  const form = $('#monitorForm');
  form.reset();
  const monitor = state.monitors.find(item => item.id === monitorId);
  $('#monitorModalEyebrow').textContent = monitor ? 'EDIT MONITOR' : 'NEW MONITOR';
  $('#monitorModalTitle').textContent = monitor ? 'Update endpoint' : 'Add an endpoint';
  $('#monitorModalDescription').textContent = monitor ? 'Changes apply to the next scheduled check.' : 'Pulse will check it on the schedule you choose.';
  $('#monitorSubmit').textContent = monitor ? 'Save changes' : 'Create monitor';
  if (monitor) {
    for (const name of ['name', 'url', 'method', 'expectedStatus', 'timeoutMs', 'intervalMinutes']) form.elements[name].value = monitor[name];
    form.elements.monitorId.value = monitor.id;
    const assertion = monitor.assertions?.[0];
    form.elements.assertionType.value = assertion?.type || '';
    form.elements.assertionPath.value = assertion?.path || '';
    form.elements.assertionValue.value = assertion?.value === undefined ? '' : typeof assertion.value === 'string' ? assertion.value : JSON.stringify(assertion.value);
    form.elements.maintenanceStartsAt.value = toLocalDateTime(monitor.maintenanceWindow?.startsAt);
    form.elements.maintenanceEndsAt.value = toLocalDateTime(monitor.maintenanceWindow?.endsAt);
    form.elements.maintenanceReason.value = monitor.maintenanceWindow?.reason || '';
  }
  updateAssertionFields();
  $('#detailModal').classList.add('hidden');
  $('#modal').classList.remove('hidden');
  form.elements.name.focus();
}

function toLocalDateTime(value) { if (!value) return ''; const date = new Date(value); const offset = date.getTimezoneOffset() * 60000; return new Date(date - offset).toISOString().slice(0, 16); }

function openIncidentUpdate(monitorId, incidentId) {
  const incident = state.incidents.find(item => item.id === incidentId);
  const form = $('#incidentUpdateForm');
  form.elements.monitorId.value = monitorId;
  form.elements.incidentId.value = incidentId;
  form.elements.publicTitle.value = incident?.publicTitle || '';
  form.elements.publicMessage.value = incident?.publicMessage || '';
  $('#incidentUpdateModal').classList.remove('hidden');
  form.elements.publicTitle.focus();
}

async function toggleMonitor(monitorId) {
  const monitor = state.monitors.find(item => item.id === monitorId);
  if (!monitor) return;
  const enabled = monitor.status === 'paused';
  try {
    await requestMonitor(monitorId, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    $('#detailModal').classList.add('hidden');
    showToast(enabled ? 'Monitoring resumed' : 'Monitoring paused', 'success');
    await load();
  } catch (error) { showToast(error.message, 'error'); }
}

async function deleteMonitor(monitorId) {
  const monitor = state.monitors.find(item => item.id === monitorId);
  if (!monitor || !confirm(`Delete “${monitor.name}” and its check and incident history? This cannot be undone.`)) return;
  try {
    await requestMonitor(monitorId, { method: 'DELETE' });
    $('#detailModal').classList.add('hidden');
    showToast('Monitor and history deleted', 'success');
    await load();
  } catch (error) { showToast(error.message, 'error'); }
}

async function requestMonitor(monitorId, options) {
  if (config.mode === 'aws') return apiFetch(`/api/monitors/${monitorId}`, options);
  const response = await fetch(`/api/monitors/${monitorId}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Could not update monitor');
  return payload;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? escapeHtml(value) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function durationBetween(start, end) {
  if (!end) return 'Ongoing';
  const minutes = Math.max(1, Math.round((new Date(end) - new Date(start)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

let toastTimer;
function showToast(message, type) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = `toast ${type || ''}`;
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 3500);
}

function setLoading(value) {
  loading = value;
  document.body.classList.toggle('is-loading', value);
  $('#addBtn').disabled = value;
}

function finishBoot() {
  document.body.classList.remove('booting');
  $('#bootScreen').setAttribute('aria-hidden', 'true');
}

function showGlobalMessage(message, type = '') {
  $('#globalMessage').textContent = message;
  $('#globalMessage').className = `global-message ${type}`;
}

function clearGlobalMessage() { $('#globalMessage').classList.add('hidden'); }

async function cognito(operation, input) {
  const response = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}` },
    body: JSON.stringify(input)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.__type || 'Authentication failed');
  return payload;
}

function showAuth(view, message = '') {
  finishBoot();
  $('#authScreen').classList.remove('hidden');
  for (const panel of ['signin', 'signup', 'confirm', 'forgot', 'reset']) $(`#${panel}Panel`).classList.toggle('hidden', panel !== view);
  $('#authMessage').textContent = message;
}

function updatePasswordRequirements() {
  const password = $('#signUpPassword').value;
  const rules = {
    length: password.length >= 10,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password)
  };
  for (const [rule, valid] of Object.entries(rules)) {
    const item = document.querySelector(`[data-password-rule="${rule}"]`);
    item.classList.toggle('valid', valid);
    item.querySelector('span').textContent = valid ? '✓' : '○';
  }
  const allValid = Object.values(rules).every(Boolean);
  $('#signUpSubmit').disabled = !allValid;
  return allValid;
}

$('#signInForm').onsubmit = async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  try {
    $('#authMessage').textContent = 'Signing in…';
    const result = await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: config.userPoolClientId, AuthParameters: { USERNAME: values.email, PASSWORD: values.password } });
    auth.setSession(result.AuthenticationResult, values.email);
    event.target.reset();
    await load();
  } catch (error) { $('#authMessage').textContent = error.message; }
};

$('#signUpForm').onsubmit = async event => {
  event.preventDefault();
  if (!updatePasswordRequirements()) {
    $('#authMessage').textContent = 'Your password must meet all four requirements.';
    return;
  }
  const values = Object.fromEntries(new FormData(event.target));
  try {
    $('#authMessage').textContent = 'Creating account…';
    await cognito('SignUp', { ClientId: config.userPoolClientId, Username: values.email, Password: values.password, UserAttributes: [{ Name: 'email', Value: values.email }] });
    sessionStorage.setItem('pulsePendingEmail', values.email);
    $('#confirmEmail').textContent = values.email;
    showAuth('confirm', 'Check your email for a six-digit confirmation code.');
  } catch (error) { $('#authMessage').textContent = error.message; }
};

$('#confirmForm').onsubmit = async event => {
  event.preventDefault();
  const email = sessionStorage.getItem('pulsePendingEmail');
  const values = Object.fromEntries(new FormData(event.target));
  try {
    await cognito('ConfirmSignUp', { ClientId: config.userPoolClientId, Username: email, ConfirmationCode: values.code });
    sessionStorage.removeItem('pulsePendingEmail');
    showAuth('signin', 'Account confirmed. You can sign in now.');
    $('#signInEmail').value = email;
  } catch (error) { $('#authMessage').textContent = error.message; }
};

$('#forgotForm').onsubmit = async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  try {
    $('#authMessage').textContent = 'Sending reset code…';
    await cognito('ForgotPassword', { ClientId: config.userPoolClientId, Username: values.email });
    sessionStorage.setItem('pulseResetEmail', values.email);
    $('#resetEmail').textContent = values.email;
    showAuth('reset', 'Check your email for the verification code.');
  } catch (error) { $('#authMessage').textContent = error.message; }
};

$('#resetForm').onsubmit = async event => {
  event.preventDefault();
  const email = sessionStorage.getItem('pulseResetEmail');
  const values = Object.fromEntries(new FormData(event.target));
  if (!email) return showAuth('forgot', 'Enter your account email again.');
  if (values.password.length < 10 || !/[A-Z]/.test(values.password) || !/[a-z]/.test(values.password) || !/[0-9]/.test(values.password)) {
    $('#authMessage').textContent = 'Use at least 10 characters with uppercase, lowercase, and a number.';
    return;
  }
  try {
    $('#authMessage').textContent = 'Updating password…';
    await cognito('ConfirmForgotPassword', { ClientId: config.userPoolClientId, Username: email, ConfirmationCode: values.code, Password: values.password });
    sessionStorage.removeItem('pulseResetEmail');
    event.target.reset();
    showAuth('signin', 'Password updated. You can sign in now.');
    $('#signInEmail').value = email;
  } catch (error) { $('#authMessage').textContent = error.message; }
};

$('#showSignup').onclick = () => showAuth('signup');
$('#showForgot').onclick = () => showAuth('forgot');
$('#showSignin').onclick = () => showAuth('signin');
$('#backToSignin').onclick = () => showAuth('signin');
document.querySelectorAll('[data-auth-view]').forEach(button => button.onclick = () => showAuth(button.dataset.authView));
$('#signUpPassword').oninput = () => {
  updatePasswordRequirements();
  $('#authMessage').textContent = '';
};
function signOut() {
  closeMenus();
  if (config.mode === 'aws') {
    auth.clear();
    showAuth('signin', 'Signed out.');
  } else navigate('account');
}

function toggleMenu(button, menu) {
  const opening = menu.classList.contains('hidden');
  closeMenus();
  menu.classList.toggle('hidden', !opening);
  button.setAttribute('aria-expanded', String(opening));
}

function closeMenus() {
  for (const id of ['workspace', 'profile']) {
    $(`#${id}Menu`).classList.add('hidden');
    $(`#${id}Button`).setAttribute('aria-expanded', 'false');
  }
}

$('#workspaceButton').onclick = event => { event.stopPropagation(); toggleMenu($('#workspaceButton'), $('#workspaceMenu')); };
$('#profileButton').onclick = event => { event.stopPropagation(); toggleMenu($('#profileButton'), $('#profileMenu')); };
$('#signOutButton').onclick = signOut;
$('#accountSignOut').onclick = signOut;
$('#mobileProfileButton').onclick = () => navigate('account');
$('#helpButton').onclick = () => navigate('help');
document.querySelectorAll('[data-menu-view]').forEach(button => button.onclick = () => navigate(button.dataset.menuView));
document.querySelector('[data-help-action="add"]').onclick = () => openMonitorForm();
document.addEventListener('click', event => { if (!event.target.closest('.menu-anchor')) closeMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
$('#addBtn').onclick = () => openMonitorForm();
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');
$('#detailClose').onclick = () => $('#detailModal').classList.add('hidden');
$('#incidentUpdateClose').onclick = () => $('#incidentUpdateModal').classList.add('hidden');
for (const modal of [$('#modal'), $('#detailModal'), $('#incidentUpdateModal')]) modal.onclick = event => { if (event.target === modal) modal.classList.add('hidden'); };
function updateAssertionFields() {
  const type = $('#assertionType').value;
  $('#assertionFields').classList.toggle('hidden', !type);
  $('#pathLabel').classList.toggle('hidden', type === 'contains_text');
  $('#valueLabel').classList.toggle('hidden', type === 'json_path_exists');
}
$('#assertionType').onchange = updateAssertionFields;
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => navigate(button.dataset.view));
document.querySelectorAll('[data-view-link]').forEach(button => button.onclick = () => navigate(button.dataset.viewLink));
$('#monitorSearch').oninput = renderMonitorManagement;
$('#monitorStatusFilter').onchange = renderMonitorManagement;
$('#checkMonitorFilter').onchange = renderCheckRuns;
$('#checkStatusFilter').onchange = renderCheckRuns;
$('#incidentStatusFilter').onchange = renderIncidentHistory;
$('#loadAnalytics').onclick = loadHistoricalAnalytics;
window.onpopstate = () => {
  if (getPublicStatusSlug()) return location.reload();
  navigate(location.hash.replace('#', '') || 'overview', { fromHistory: true });
};
$('#statusPageForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const monitorIds = [...form.querySelectorAll('input[name="monitorIds"]:checked')].map(input => input.value);
  const payload = { name: form.elements.name.value.trim(), slug: form.elements.slug.value.trim().toLowerCase(), monitorIds, published: form.elements.published.checked };
  if (!monitorIds.length) return showToast('Select at least one monitor', 'error');
  const submit = $('#statusPageSubmit');
  submit.disabled = true;
  submit.textContent = 'Saving…';
  try {
    state.statusPage = await statusPageRequest({ method: 'PUT', body: JSON.stringify(payload) });
    renderStatusPageEditor();
    showToast(payload.published ? 'Status page published' : 'Status page saved', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { submit.disabled = false; submit.textContent = 'Save status page'; }
};
$('#alertPreferencesForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const events = [...form.querySelectorAll('[name="events"]:checked')].map(input => input.value);
  if (!events.length) return showToast('Select at least one alert event', 'error');
  const button = $('#alertPreferencesSubmit');
  button.disabled = true; button.textContent = 'Saving…';
  try {
    const options = { method: 'PUT', body: JSON.stringify({ email: form.elements.email.value, events }) };
    state.alertPreferences = config.mode === 'aws' ? await apiFetch('/api/alert-preferences', options) : await fetch('/api/alert-preferences', { ...options, headers: { 'Content-Type': 'application/json' } }).then(response => response.json());
    renderAlertPreferences();
    showToast(config.mode === 'aws' ? 'Check your email to confirm alerts' : 'Alert preferences saved', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Save alerts'; }
};
$('#removeAlertPreferences').onclick = async () => {
  if (!confirm('Remove this email alert subscription?')) return;
  try {
    if (config.mode === 'aws') await apiFetch('/api/alert-preferences', { method: 'DELETE' });
    else await fetch('/api/alert-preferences', { method: 'DELETE' });
    state.alertPreferences = null; renderAlertPreferences(); showToast('Email alerts removed', 'success');
  } catch (error) { showToast(error.message, 'error'); }
};
$('#incidentUpdateForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = { publicTitle: form.elements.publicTitle.value, publicMessage: form.elements.publicMessage.value };
  const path = `/api/monitors/${form.elements.monitorId.value}/incidents/${form.elements.incidentId.value}`;
  try {
    const updated = config.mode === 'aws' ? await apiFetch(path, { method: 'PATCH', body: JSON.stringify(payload) }) : await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(response => response.json());
    const index = state.incidents.findIndex(item => item.id === form.elements.incidentId.value);
    if (index >= 0) state.incidents[index] = normalizeIncident(updated);
    $('#incidentUpdateModal').classList.add('hidden'); render(); showToast('Public incident update published', 'success');
  } catch (error) { showToast(error.message, 'error'); }
};
$('#monitorForm').onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  let assertionValue = data.assertionValue;
  if (data.assertionType === 'json_path_equals') { try { assertionValue = JSON.parse(data.assertionValue); } catch {} }
  const assertion = data.assertionType ? { type: data.assertionType, ...(data.assertionType !== 'contains_text' ? { path: data.assertionPath } : {}), ...(data.assertionType !== 'json_path_exists' ? { value: assertionValue } : {}) } : null;
  const monitorId = data.monitorId || selectedMonitorId;
  const hasMaintenance = data.maintenanceStartsAt || data.maintenanceEndsAt || data.maintenanceReason;
  if (hasMaintenance && (!data.maintenanceStartsAt || !data.maintenanceEndsAt)) return showToast('Choose both maintenance start and end times', 'error');
  const maintenanceWindow = hasMaintenance ? { startsAt: new Date(data.maintenanceStartsAt).toISOString(), endsAt: new Date(data.maintenanceEndsAt).toISOString(), reason: data.maintenanceReason || 'Scheduled maintenance' } : null;
  const payload = { ...data, assertions: assertion ? [assertion] : [], maintenanceWindow };
  for (const field of ['monitorId', 'assertionType', 'assertionPath', 'assertionValue', 'maintenanceStartsAt', 'maintenanceEndsAt', 'maintenanceReason']) delete payload[field];
  try {
    if (monitorId) await requestMonitor(monitorId, { method: 'PATCH', body: JSON.stringify(payload) });
    else if (config.mode === 'aws') await apiFetch('/api/monitors', { method: 'POST', body: JSON.stringify(payload) });
    else {
      const response = await fetch('/api/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error('Could not create monitor');
    }
    event.target.reset();
    $('#assertionFields').classList.add('hidden');
    $('#modal').classList.add('hidden');
    selectedMonitorId = null;
    showToast(monitorId ? 'Monitor updated' : 'Monitor created', 'success');
    await load();
  } catch (error) { showToast(error.message, 'error'); }
};

load();
