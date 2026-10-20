'use strict';
// Structural checks on the n8n workflow export. Each test guards a problem
// that was found when the workflow was executed on a real n8n instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize } = require('../app.js');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n', 'referral-partner-program.json'), 'utf8'));
const byName = Object.fromEntries(wf.nodes.map(n => [n.name, n]));
const out = (name, port = 0) => ((wf.connections[name]?.main || [])[port] || []).map(c => c.node);
const AGENTS = ['Lead Qualification Agent', 'CRM Enrichment Agent', 'Partner Communication Agent', 'Referral Decision Agent'];

test('every connection points at a node that exists', () => {
  assert.equal(new Set(wf.nodes.map(n => n.name)).size, wf.nodes.length, 'node names must be unique');
  for (const [src, types] of Object.entries(wf.connections)) {
    assert.ok(byName[src], `unknown source ${src}`);
    for (const ports of Object.values(types)) for (const port of ports) for (const c of port || []) assert.ok(byName[c.node], `${src} -> unknown ${c.node}`);
  }
});

test('every branch ends by answering the webhook', () => {
  const leaves = wf.nodes.filter(n => !(wf.connections[n.name]?.main || []).some(p => p && p.length)).map(n => n.name);
  for (const leaf of leaves) assert.equal(byName[leaf].type, 'n8n-nodes-base.respondToWebhook', `${leaf} is a dead end`);
});

test('the webhook matches what the portal calls', () => {
  const hook = wf.nodes.find(n => n.type === 'n8n-nodes-base.webhook');
  assert.equal(hook.parameters.httpMethod, 'POST');
  assert.equal(hook.parameters.path, 'referral');
  assert.equal(hook.parameters.responseMode, 'responseNode');
});

test('the required-field check uses exactly the fields the portal sends', () => {
  const ifNode = byName['Validate Required Fields1'];
  const checked = ifNode.parameters.conditions.conditions.map(c => c.leftValue.match(/body\.(\w+)/)[1]).sort();
  const sent = Object.keys(normalize({})).filter(k => k !== 'consent').sort();
  assert.deepEqual(checked, sent);
});

test('IF nodes convert types, so a numeric phone or partner code cannot crash the run', () => {
  for (const name of ['Validate Required Fields1', 'Partner Valid?1']) {
    const p = byName[name].parameters;
    assert.equal(p.looseTypeValidation, true, name);
    assert.equal(p.conditions.options.typeValidation, 'loose', `${name}: the stored "strict" value overrides the toggle`);
  }
});

test('the three specialist agents fan out from Save Lead and merge before the decision agent', () => {
  assert.deepEqual(out('Save Lead1').sort(), AGENTS.slice(0, 3).sort());
  const into = (target) => Object.entries(wf.connections).flatMap(([src, t]) => (t.main || []).flatMap(p => (p || []).filter(c => c.node === target).map(c => [src, c.index])));
  assert.deepEqual(into('Merge AB').map(x => x[1]).sort(), [0, 1]);
  assert.deepEqual(into('Merge ABC').map(x => x[1]).sort(), [0, 1]);
  assert.deepEqual(out('Merge ABC'), ['Referral Decision Agent']);
});

test('each agent survives API failures and is followed by a validator with a fallback', () => {
  for (const a of AGENTS) {
    const node = byName[a];
    assert.equal(node.onError, 'continueRegularOutput', `${a} must not stop the run on an API error`);
    assert.ok(node.retryOnFail, `${a} should retry`);
    const [validator] = out(a);
    assert.match(validator, /^Validate /);
    const code = byName[validator].parameters.jsCode;
    assert.match(code, /replace\(\/\^```/, `${validator} must strip markdown fences before JSON.parse`);
    assert.match(code, /catch \(e\)[\s\S]*parsed = \{/, `${validator} must substitute a fallback`);
  }
});

test('the decision agent only produces tiers the portal knows how to show', () => {
  const body = byName['Referral Decision Agent'].parameters.jsonBody;
  for (const t of ['immediate', 'standard', 'nurture']) assert.ok(body.includes(t), t);
});

test('the Slack message reads AI fields from the decision validator, not from the HubSpot output', () => {
  const text = byName['Notify Sales1'].parameters.text;
  for (const f of ['lead_score', 'routing_tier', 'final_summary', 'confidence']) {
    assert.ok(!new RegExp(`\\$json\\.${f}`).test(text), `${f} would be blank: HubSpot replaces $json`);
    assert.ok(text.includes(`$('Validate Referral Decision').item.json.${f}`), f);
  }
});

test('a HubSpot failure is logged and still notifies sales', () => {
  assert.equal(byName['HubSpot: Upsert Contact'].onError, 'continueErrorOutput');
  assert.deepEqual(out('HubSpot: Upsert Contact', 1), ['CRM Error']);
  assert.deepEqual(out('CRM Error'), ['Log CRM Sync Error']);
  assert.deepEqual(out('Log CRM Sync Error'), ['Notify Sales1']);
});

test('the success response carries the fields the portal reads', () => {
  const body = byName['Success Response1'].parameters.responseBody;
  for (const f of ['success: true', 'prospect:', 'routing_tier:']) assert.ok(body.includes(f), f);
  assert.match(byName['Unknown Partner1'].parameters.responseBody, /Unknown partner code/);
  assert.match(byName['Missing required Field1'].parameters.responseBody, /Missing required field/);
});
