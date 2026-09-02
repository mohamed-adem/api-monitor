const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runHealthCheck } = require('./src/check-engine');
const { applyCheckToMonitor } = require('./src/incident-engine');

const PORT = process.env.PORT || 3000;
const root = path.join(__dirname, 'public');
const dbPath = path.join(__dirname, 'data.json');
const seed = {
  monitors: [
    { id: 'mon_media', name: 'Media Tracker API', url: 'https://media-tracker-1hj2.onrender.com/api/health', method: 'GET', expectedStatus: 200, timeoutMs: 3000, intervalMinutes: 5, assertions: [{ type: 'json_path_equals', path: '$.status', value: 'ok' }], status: 'up', uptime: 99.98, p95: 412, lastChecked: '2 min ago', region: 'us-west-2', color: 'purple' },
    { id: 'mon_demo', name: 'Demo Payments API', url: 'https://api.stripe.com/health', method: 'GET', expectedStatus: 200, timeoutMs: 5000, intervalMinutes: 10, assertions: [], status: 'degraded', uptime: 98.72, p95: 1240, lastChecked: '4 min ago', region: 'us-east-1', color: 'orange' },
    { id: 'mon_school', name: 'Class Project', url: 'https://example.com/api/v1/status', method: 'GET', expectedStatus: 200, timeoutMs: 2000, intervalMinutes: 5, assertions: [], status: 'up', uptime: 100, p95: 188, lastChecked: '5 min ago', region: 'us-west-2', color: 'blue' }
  ],
  incidents: [{ id: 'inc_1', monitorId: 'mon_demo', title: 'High latency detected', reason: 'p95 latency exceeded 1000ms', startedAt: 'Today, 09:42 AM', duration: '18 min', open: false }],
  checks: [],
  statusPage: null,
  alertPreferences: null
};

function load() { try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { fs.writeFileSync(dbPath, JSON.stringify(seed, null, 2)); return seed; } }
function save(data) { fs.writeFileSync(dbPath, JSON.stringify(data, null, 2)); }
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = load();
  if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { mode: 'local' });
  if (url.pathname === '/api/summary' && req.method === 'GET') return json(res, 200, { monitors: db.monitors, incidents: db.incidents, checks: db.checks, statusPage: db.statusPage || null, alertPreferences: db.alertPreferences || null });
  if (url.pathname === '/api/alert-preferences' && req.method === 'GET') return json(res, 200, { item: db.alertPreferences || null });
  if (url.pathname === '/api/alert-preferences' && req.method === 'PUT') {
    const input = await body(req);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email || '')) || !Array.isArray(input.events) || !input.events.length) return json(res, 400, { error: 'Enter a valid email and select an event' });
    const now = new Date().toISOString(); db.alertPreferences = { email: String(input.email).toLowerCase(), events: input.events, status: 'CONFIRMED', createdAt: db.alertPreferences?.createdAt || now, updatedAt: now }; save(db); return json(res, 200, db.alertPreferences);
  }
  if (url.pathname === '/api/alert-preferences' && req.method === 'DELETE') { db.alertPreferences = null; save(db); res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/status-page' && req.method === 'GET') return json(res, 200, { item: db.statusPage || null });
  if (url.pathname === '/api/status-page' && req.method === 'PUT') {
    const input = await body(req);
    const monitorIds = Array.isArray(input.monitorIds) ? [...new Set(input.monitorIds.map(String))] : [];
    if (!input.name || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(String(input.slug || '')) || !monitorIds.length) return json(res, 400, { error: 'Enter a valid name, slug, and at least one monitor' });
    if (monitorIds.some(id => !db.monitors.some(monitor => monitor.id === id))) return json(res, 400, { error: 'One or more selected monitors were not found' });
    const now = new Date().toISOString();
    db.statusPage = { name: String(input.name).trim(), slug: String(input.slug), monitorIds, published: input.published !== false, createdAt: db.statusPage?.createdAt || now, updatedAt: now };
    save(db); return json(res, 200, db.statusPage);
  }
  if (url.pathname === '/api/status-page' && req.method === 'DELETE') {
    db.statusPage = null; save(db); res.writeHead(204); return res.end();
  }
  const statusMatch = url.pathname.match(/^\/api\/status\/([^/]+)$/);
  if (statusMatch && req.method === 'GET') {
    const page = db.statusPage;
    if (!page?.published || page.slug !== statusMatch[1]) return json(res, 404, { error: 'Status page not found' });
    const monitors = page.monitorIds.map(id => db.monitors.find(item => item.id === id)).filter(Boolean).map(monitor => ({ monitorId: monitor.id, name: monitor.name, status: monitor.enabled === false ? 'MAINTENANCE' : String(monitor.status).toUpperCase(), lastCheckedAt: monitor.lastChecked, lastLatencyMs: monitor.p95 }));
    const selected = new Set(page.monitorIds);
    const incidents = db.incidents.filter(item => selected.has(item.monitorId)).slice(0, 10).map(item => ({ incidentId: item.id, monitorId: item.monitorId, status: item.open ? 'OPEN' : 'RESOLVED', publicTitle: item.publicTitle || (item.open ? 'Service disruption detected' : 'Service restored'), publicMessage: item.publicMessage || (item.open ? 'We are investigating an interruption to this service.' : 'This service has recovered and is operating normally.'), publicUpdatedAt: item.publicUpdatedAt, startedAt: item.startedAt, resolvedAt: item.resolvedAt }));
    return json(res, 200, { name: page.name, slug: page.slug, updatedAt: page.updatedAt, generatedAt: new Date().toISOString(), monitors, incidents });
  }
  if (url.pathname === '/api/monitors' && req.method === 'POST') {
    const input = await body(req);
    const assertions = Array.isArray(input.assertions) ? input.assertions.filter(item => item && item.type) : [];
    const monitor = { id: `mon_${randomUUID().slice(0, 8)}`, name: input.name || 'Untitled monitor', url: input.url, method: input.method || 'GET', expectedStatus: Number(input.expectedStatus || 200), timeoutMs: Number(input.timeoutMs || 3000), intervalMinutes: Number(input.intervalMinutes || 5), assertions, maintenanceWindow: input.maintenanceWindow || undefined, enabled: true, status: 'pending', uptime: 0, p95: 0, failureStreak: 0, lastChecked: 'Not checked yet', region: 'us-west-2', color: 'green' };
    db.monitors.unshift(monitor); save(db); return json(res, 201, monitor);
  }
  const monitorMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)$/);
  if (monitorMatch && req.method === 'PATCH') {
    const monitor = db.monitors.find(item => item.id === monitorMatch[1]);
    if (!monitor) return json(res, 404, { error: 'Monitor not found' });
    const input = await body(req);
    for (const field of ['name', 'url', 'method']) if (input[field] !== undefined) monitor[field] = input[field];
    for (const field of ['expectedStatus', 'timeoutMs', 'intervalMinutes']) if (input[field] !== undefined) monitor[field] = Number(input[field]);
    if (Array.isArray(input.assertions)) monitor.assertions = input.assertions.filter(item => item && item.type);
    if (input.maintenanceWindow !== undefined) monitor.maintenanceWindow = input.maintenanceWindow || undefined;
    if (input.enabled !== undefined) {
      monitor.enabled = Boolean(input.enabled);
      monitor.status = monitor.enabled ? 'pending' : 'paused';
    }
    save(db); return json(res, 200, monitor);
  }
  if (monitorMatch && req.method === 'DELETE') {
    const index = db.monitors.findIndex(item => item.id === monitorMatch[1]);
    if (index < 0) return json(res, 404, { error: 'Monitor not found' });
    db.monitors.splice(index, 1);
    db.checks = db.checks.filter(item => item.monitorId !== monitorMatch[1]);
    db.incidents = db.incidents.filter(item => item.monitorId !== monitorMatch[1]);
    save(db); res.writeHead(204); return res.end();
  }
  const runMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)\/check$/);
  if (runMatch && req.method === 'POST') {
    const monitor = db.monitors.find(m => m.id === runMatch[1]);
    if (!monitor) return json(res, 404, { error: 'Monitor not found' });
    if (monitor.enabled === false || monitor.status === 'paused') return json(res, 409, { error: 'Resume this monitor before running a check' });
    if (monitor.maintenanceWindow && Date.now() >= Date.parse(monitor.maintenanceWindow.startsAt) && Date.now() < Date.parse(monitor.maintenanceWindow.endsAt)) return json(res, 409, { error: 'This monitor is in a scheduled maintenance window' });
    const result = await runHealthCheck(monitor);
    const checkedAt = new Date().toISOString();
    const check = { id: randomUUID(), monitorId: monitor.id, ok: result.ok, latency: result.latencyMs, statusCode: result.statusCode, reason: result.reason, createdAt: checkedAt };
    db.checks.unshift(check);
    const lifecycle = applyCheckToMonitor({ ...monitor, monitorId: monitor.id, status: String(monitor.status).toUpperCase() }, { ok: result.ok, latencyMs: result.latencyMs, reason: result.reason, checkedAt });
    monitor.status = lifecycle.monitor.status.toLowerCase();
    monitor.failureStreak = lifecycle.monitor.failureStreak;
    monitor.activeIncidentId = lifecycle.monitor.activeIncidentId;
    monitor.lastChecked = 'just now';
    const history = db.checks.filter(item => item.monitorId === monitor.id).slice(0, 100);
    monitor.uptime = history.length ? history.filter(item => item.ok).length / history.length * 100 : 0;
    const latencies = history.map(item => item.latency).sort((a, b) => a - b);
    monitor.p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * .95) - 1)] : 0;
    for (const event of lifecycle.events) {
      if (event.type === 'INCIDENT_OPENED') db.incidents.unshift({ id: event.incidentId, monitorId: monitor.id, title: 'Endpoint check failed', reason: event.reason, startedAt: event.startedAt, duration: 'Ongoing', open: true });
      if (event.type === 'INCIDENT_RESOLVED') {
        const incident = db.incidents.find(item => item.id === event.incidentId);
        if (incident) { incident.open = false; incident.resolvedAt = event.resolvedAt; incident.duration = formatDuration(new Date(event.resolvedAt) - new Date(incident.startedAt)); }
      }
    }
    save(db); return json(res, 200, { monitor, check, events: lifecycle.events });
  }
  const incidentUpdateMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)\/incidents\/([^/]+)$/);
  if (incidentUpdateMatch && req.method === 'PATCH') {
    const incident = db.incidents.find(item => item.monitorId === incidentUpdateMatch[1] && item.id === incidentUpdateMatch[2]);
    if (!incident) return json(res, 404, { error: 'Incident not found' });
    const input = await body(req); incident.publicTitle = String(input.publicTitle || '').slice(0, 100); incident.publicMessage = String(input.publicMessage || '').slice(0, 500); incident.publicUpdatedAt = new Date().toISOString(); save(db); return json(res, 200, { ...incident, incidentId: incident.id, status: incident.open ? 'OPEN' : 'RESOLVED' });
  }
  const analyticsMatch = url.pathname.match(/^\/api\/monitors\/([^/]+)\/analytics$/);
  if (analyticsMatch && req.method === 'GET') {
    const window = ['24h', '7d', '30d'].includes(url.searchParams.get('window')) ? url.searchParams.get('window') : '24h';
    const hours = window === '24h' ? 24 : window === '7d' ? 168 : 720;
    const checks = db.checks.filter(item => item.monitorId === analyticsMatch[1] && new Date(item.createdAt) >= new Date(Date.now() - hours * 3600000));
    const totalChecks = checks.length, successCount = checks.filter(item => item.ok).length, failures = totalChecks - successCount;
    return json(res, 200, { window, points: [], summary: { totalChecks, failures, uptime: totalChecks ? successCount / totalChecks * 100 : null, averageLatencyMs: totalChecks ? Math.round(checks.reduce((sum, item) => sum + item.latency, 0) / totalChecks) : null } });
  }
  if (req.method === 'GET') {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.normalize(path.join(root, file));
    if (filePath.startsWith(root) && fs.existsSync(filePath)) { const ext = path.extname(filePath); const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript'; res.writeHead(200, { 'Content-Type': type }); return res.end(fs.readFileSync(filePath)); }
  }
  json(res, 404, { error: 'Not found' });
});
function formatDuration(ms) { const minutes = Math.max(1, Math.round(ms / 60000)); return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
server.listen(PORT, () => console.log(`API Monitor running at http://localhost:${PORT}`));
