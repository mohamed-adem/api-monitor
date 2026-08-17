const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('seed data describes core monitor entities', () => { const data = JSON.parse(fs.readFileSync('data.json', 'utf8')); assert.ok(data.monitors.length >= 3); assert.ok(data.monitors.every(m => m.url && m.expectedStatus)); });
