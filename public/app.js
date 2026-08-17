const $ = selector => document.querySelector(selector);
let state = { monitors: [], incidents: [], checks: [] };
let config = { mode: 'local' };
let currentView = location.hash.replace('#', '') || 'overview';
let selectedMonitorId = null;
let loading = false;

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
  if (config.mode === 'aws' && !auth.accessToken) { setLoading(false); return showAuth('signin'); }
  try {
    state = config.mode === 'aws' ? await loadAwsState() : await fetch('/api/summary').then(response => response.json());
    $('#authScreen').classList.add('hidden');
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
  const [monitorPayload, incidentPayload] = await Promise.all([apiFetch('/api/monitors'), apiFetch('/api/incidents')]);
  const rawMonitors = monitorPayload.items || [];
  const checksByMonitor = await Promise.all(rawMonitors.map(monitor => apiFetch(`/api/monitors/${monitor.monitorId}/checks`).then(payload => payload.items || [])));
  const checks = checksByMonitor.flat().map(normalizeCheck).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const monitors = rawMonitors.map(monitor => normalizeMonitor(monitor, checks.filter(check => check.monitorId === monitor.monitorId)));
  return { monitors, checks, incidents: (incidentPayload.items || []).map(normalizeIncident) };
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
}

const viewCopy = {
  overview: ['MONITORING / OVERVIEW', null, "Here's what's happening with your endpoints."],
  monitors: ['MONITORING / MONITORS', 'Monitors', 'Create, inspect, pause, edit, and remove endpoint checks.'],
  checks: ['MONITORING / CHECK RUNS', 'Check runs', 'Inspect the latest synthetic requests and failure reasons.'],
  incidents: ['MONITORING / INCIDENTS', 'Incident history', 'See when failures began, recovered, and how long they lasted.'],
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
  $('#addBtn').classList.toggle('hidden', ['help', 'account'].includes(currentView));
}

function monitorStatusLabel(status) {
  return ({ up: 'Operational', pending: 'Not checked', down: 'Down', degraded: 'Degraded', paused: 'Paused' })[status] || status;
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
  $('#allIncidentList').innerHTML = incidents.length ? `<div class="table-head incident-head"><span>Status</span><span>Monitor</span><span>Failure reason</span><span>Started</span><span>Duration</span></div>${incidents.map(incident => { const monitor = state.monitors.find(item => item.id === incident.monitorId); return `<div class="table-row incident-row"><span class="status ${incident.open ? 'down' : 'up'}"><i class="dot ${incident.open ? 'orange-dot' : 'green-dot'}"></i>${incident.open ? 'Open' : 'Resolved'}</span><button class="table-link" data-details="${escapeHtml(incident.monitorId)}">${escapeHtml(monitor?.name || 'Deleted monitor')}</button><span>${escapeHtml(incident.reason || 'Endpoint check failed')}</span><time>${formatTime(incident.startedAt)}</time><strong>${escapeHtml(incident.duration)}</strong></div>`; }).join('')}` : '<div class="empty-state roomy"><strong>No incidents found</strong><span>Incidents appear after two consecutive failed checks.</span></div>';
  $('#allIncidentList').querySelectorAll('[data-details]').forEach(button => button.onclick = () => showDetails(button.dataset.details));
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
  const maxLatency = Math.max(...checks.map(check => check.latency), 1);
  const bars = checks.length ? [...checks].reverse().map(check => `<span class="latency-bar ${check.ok ? '' : 'failed'}" style="height:${Math.max(8, check.latency / maxLatency * 100)}%" title="${check.latency}ms"></span>`).join('') : '<p class="empty-state">Run this monitor to build latency history.</p>';
  const assertions = monitor.assertions?.length ? monitor.assertions.map(assertion => `<code>${escapeHtml(assertion.type)} ${escapeHtml(assertion.path || assertion.value)}</code>`).join('') : '<span class="muted">No response assertions</span>';
  $('#detailContent').innerHTML = `<p class="eyebrow">MONITOR DETAIL</p><div class="detail-title"><div><h2>${escapeHtml(monitor.name)}</h2><p class="muted">${escapeHtml(monitor.url)}</p></div><span class="status ${monitor.status}"><i class="dot ${monitor.status === 'up' ? 'green-dot' : 'orange-dot'}"></i>${monitorStatusLabel(monitor.status)}</span></div><div class="detail-actions"><button class="run-btn" data-edit="${monitor.id}">Edit</button><button class="run-btn" data-toggle="${monitor.id}">${monitor.status === 'paused' ? 'Resume monitoring' : 'Pause monitoring'}</button><button class="run-btn danger" data-delete="${monitor.id}">Delete</button></div><div class="detail-metrics"><div><small>UPTIME</small><strong>${monitor.uptime !== null && monitor.uptime !== undefined ? `${monitor.uptime.toFixed(2)}%` : '—'}</strong></div><div><small>P95 LATENCY</small><strong>${monitor.p95 !== null && monitor.p95 !== undefined ? `${monitor.p95}ms` : '—'}</strong></div><div><small>FAILURE STREAK</small><strong>${monitor.failureStreak || 0}</strong></div><div><small>INTERVAL</small><strong>${monitor.intervalMinutes}m</strong></div></div><div class="detail-section"><div class="section-line"><h3>Latency history</h3><button class="run-btn" data-run="${monitor.id}" ${monitor.status === 'paused' ? 'disabled' : ''}>Run now</button></div><div class="latency-chart">${bars}</div></div><div class="detail-section"><h3>Configuration</h3><div class="config-grid"><span>Method <strong>${monitor.method}</strong></span><span>Expected <strong>${monitor.expectedStatus}</strong></span><span>Timeout <strong>${monitor.timeoutMs}ms</strong></span></div><div class="assertion-list">${assertions}</div></div><div class="detail-section"><h3>Recent checks</h3>${checks.length ? checks.map(check => `<div class="check-row"><span class="status ${check.ok ? 'up' : 'down'}"><i class="dot ${check.ok ? 'green-dot' : 'orange-dot'}"></i>${check.ok ? 'Passed' : 'Failed'}</span><span>${escapeHtml(check.reason)}</span><strong>${check.latency}ms</strong><small>${formatTime(check.createdAt)}</small></div>`).join('') : '<p class="empty-state">No checks recorded yet.</p>'}</div>${incidents.length ? `<div class="detail-section"><h3>Incidents</h3>${incidents.map(incident => `<div class="check-row"><span>${incident.open ? 'Open' : 'Resolved'}</span><span>${escapeHtml(incident.reason)}</span><strong>${escapeHtml(incident.duration)}</strong></div>`).join('')}</div>` : ''}`;
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
  }
  updateAssertionFields();
  $('#detailModal').classList.add('hidden');
  $('#modal').classList.remove('hidden');
  form.elements.name.focus();
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
for (const modal of [$('#modal'), $('#detailModal')]) modal.onclick = event => { if (event.target === modal) modal.classList.add('hidden'); };
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
window.onpopstate = () => navigate(location.hash.replace('#', '') || 'overview', { fromHistory: true });
$('#monitorForm').onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  let assertionValue = data.assertionValue;
  if (data.assertionType === 'json_path_equals') { try { assertionValue = JSON.parse(data.assertionValue); } catch {} }
  const assertion = data.assertionType ? { type: data.assertionType, ...(data.assertionType !== 'contains_text' ? { path: data.assertionPath } : {}), ...(data.assertionType !== 'json_path_exists' ? { value: assertionValue } : {}) } : null;
  const monitorId = data.monitorId || selectedMonitorId;
  const payload = { ...data, assertions: assertion ? [assertion] : [] };
  delete payload.monitorId; delete payload.assertionType; delete payload.assertionPath; delete payload.assertionValue;
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
