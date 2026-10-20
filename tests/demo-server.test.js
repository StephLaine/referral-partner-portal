'use strict';
// The demo server must answer exactly like the n8n workflow, or the demo
// would show behaviour the real system doesn't have.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoServer, leadQualification } = require('../demo/server.js');

let base, demo;
test.before(async () => {
  demo = createDemoServer({ speed: 0, quiet: true });
  await new Promise(r => demo.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${demo.server.address().port}`;
});
test.after(() => demo.server.close());
test.beforeEach(() => Object.assign(demo.state, { aiDown: false, hubspotDown: false, crashNext: false }));

const post = (body) => fetch(base + '/webhook/referral', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
const lead = { partner_code: 'PARTNER001', prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '+1-415-555-0192', intent: 'Ready to buy term life insurance for my family this month' };

test('missing fields get the workflow rejection', async () => {
  assert.deepEqual(await post({}), { status: 200, json: { success: false, error: 'Missing required field' } });
});

test('unknown partner codes get the workflow rejection', async () => {
  assert.deepEqual((await post({ ...lead, partner_code: 'NOPE' })).json, { success: false, error: 'Unknown partner code' });
});

test('a valid referral returns the workflow success payload', async () => {
  const r = await post(lead);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { success: true, message: 'Referral received successfully', partner_code: 'PARTNER001', prospect: 'Maria Sanchez', routing_tier: 'immediate' });
});

test('the simulated agents spread leads across all three tiers', async () => {
  const tiers = [];
  for (const intent of ['Need auto coverage by Friday, closing on a car this week', 'Comparing auto insurance quotes, not urgent', 'Just browsing, curious what home insurance costs']) tiers.push((await post({ ...lead, intent })).json.routing_tier);
  assert.deepEqual(tiers, ['immediate', 'standard', 'nurture']);
});

test('a name and email that do not match lower confidence, like the real agent did', () => {
  const real = leadQualification({ ...lead, prospect_email: 'stephane.laine@edlight.org' });
  assert.equal(real.lead_score, 'warm');
  assert.match(real.reasoning, /does not match/);
});

test('an AI outage still produces a successful referral via the fallbacks', async () => {
  demo.state.aiDown = true;
  const r = await post(lead);
  assert.equal(r.json.success, true);
  assert.equal(r.json.routing_tier, 'standard');
  assert.equal(demo.feed[0].fallbacks.length, 4);
  assert.match(demo.feed[0].final_summary, /review referral manually/);
});

test('a HubSpot outage is logged and the referral still succeeds', async () => {
  demo.state.hubspotDown = true;
  const r = await post(lead);
  assert.equal(r.json.success, true);
  assert.equal(demo.feed[0].crm_synced, false);
});

test('a workflow crash returns HTTP 500 like n8n', async () => {
  demo.state.crashNext = true;
  assert.deepEqual(await post(lead), { status: 500, json: { message: 'Error in workflow' } });
});

test('the served config points the portal at the demo webhook', async () => {
  const js = await fetch(base + '/config.js').then(r => r.text());
  assert.match(js, /webhookUrl: "\/webhook\/referral"/);
});
