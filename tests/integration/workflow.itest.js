'use strict';
// End-to-end: real n8n running the real workflow, outside services recorded.
// Needs N8N_BASE_URL pointing at an n8n where tests/integration/build-workflow.js
// output is imported and active. `npm run test:n8n` sets all of that up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockServices } = require('./mock-services.js');

const BASE = process.env.N8N_BASE_URL;
const LIVE = process.env.LLM_MODE === 'live';
const MOCK_PORT = Number(process.env.MOCK_PORT || 5699);
const skip = BASE ? false : 'N8N_BASE_URL not set (run `npm run test:n8n`)';

const mock = createMockServices();
const branches = {};
const hit = (name) => { branches[name] = true; };
const lead = (over = {}) => ({ partner_code: 'PARTNER001', prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '+1 415 555 0192', intent: 'Ready to buy term life this month', ...over });
const send = async (body) => {
  const r = await fetch(`${BASE}/webhook/referral`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text }; }
};
const FALLBACK_SUMMARY = 'Automated summary unavailable - agent output invalid; please review referral manually.';

test.describe('n8n workflow end to end', { skip, timeout: 240000 }, () => {
  test.before(async () => { await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r)); });
  test.after(() => {
    mock.server.close();
    const all = ['missing-field rejection', 'unknown-partner rejection', 'lead saved before AI', 'agents answer (happy path)', 'tier immediate', 'tier standard', 'tier nurture',
      'validator: fenced JSON accepted', 'validator: prose falls back', 'validator: injected keys dropped', 'agents fail: all four fallbacks', 'HubSpot success', 'HubSpot error branch logged',
      'Slack shows AI fields', 'partner email sent', 'client email sent', 'numeric phone accepted'];
    const report = { mode: LIVE ? 'live Claude' : 'fake Claude', covered: all.filter(b => branches[b]), missed: all.filter(b => !branches[b]), total: all.length };
    fs.mkdirSync(path.join(__dirname, '..', '..', 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', '..', 'coverage', `workflow-branches${LIVE ? '-live' : ''}.json`), JSON.stringify(report, null, 2));
  });
  test.beforeEach(() => mock.reset());

  test('a missing field is rejected before anything is looked up', async () => {
    const r = await send({ ...lead(), prospect_phone: '' });
    assert.deepEqual(r, { status: 200, json: { success: false, error: 'Missing required field' } });
    assert.equal(mock.calls.partners.length, 0);
    hit('missing-field rejection');
  });

  test('an unknown partner code is rejected and nothing is saved', async () => {
    const r = await send(lead({ partner_code: 'NOPE' }));
    assert.deepEqual(r.json, { success: false, error: 'Unknown partner code' });
    assert.deepEqual(mock.calls.partners, ['NOPE']);
    assert.equal(mock.calls.leads.length, 0);
    assert.equal(mock.calls.claude.length, 0, 'no AI spend on a rejected referral');
    hit('unknown-partner rejection');
  });

  test('a hot referral flows through every step and comes back as immediate', async () => {
    const r = await send(lead());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, message: 'Referral received successfully', partner_code: 'PARTNER001', prospect: 'Maria Sanchez', routing_tier: LIVE ? r.json.routing_tier : 'immediate' });
    if (LIVE) assert.ok(['immediate', 'standard', 'nurture'].includes(r.json.routing_tier));
    else hit('tier immediate');

    const [row] = mock.calls.leads;
    assert.deepEqual({ ...row, timestamp: undefined }, { timestamp: undefined, partner_code: 'PARTNER001', partner_name: 'ABC Insurance', partner_email: 'partner1@example.com', prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '+1 415 555 0192', intent: 'Ready to buy term life this month', status: 'New' });
    hit('lead saved before AI');

    if (!LIVE) {
      assert.equal(mock.calls.claude.length, 4, 'four agent calls');
      for (const c of mock.calls.claude) {
        assert.equal(c.headers['x-api-key'], 'it-test-key', 'the credential is sent as x-api-key');
        assert.equal(c.headers['anthropic-version'], '2023-06-01');
        assert.match(c.body.model, /^claude-/);
      }
      hit('agents answer (happy path)');
    }

    const [hub] = mock.calls.hubspot;
    assert.equal(hub.email, 'maria.sanchez@example.com');
    assert.equal(hub.firstname, 'Maria');
    assert.equal(hub.lastname, 'Sanchez');
    assert.equal(hub.referral_partner_code, 'PARTNER001');
    assert.ok(['lead', 'opportunity'].includes(hub.lifecyclestage));
    hit('HubSpot success');

    const [slack] = mock.calls.slack;
    assert.match(slack.text, /CRM Synced: ✅ Yes \(HubSpot ID 4242\)/);
    assert.match(slack.text, /AI Lead Score: (hot|warm|cold) \(\d+% confidence\)/, 'score is never blank');
    assert.match(slack.text, /AI Routing Tier: (immediate|standard|nurture)/);
    assert.ok(!slack.text.includes(FALLBACK_SUMMARY), 'no agent fell back');
    hit('Slack shows AI fields');

    const partnerMail = mock.calls.gmail.find(g => g.kind === 'partner');
    const clientMail = mock.calls.gmail.find(g => g.kind === 'prospect');
    assert.equal(partnerMail.to, 'partner1@example.com');
    assert.match(partnerMail.message, /^Hello ABC Insurance,/);
    assert.equal(clientMail.to, 'maria.sanchez@example.com');
    assert.match(clientMail.message, /^Hello Maria Sanchez,/);
    if (!LIVE) assert.match(clientMail.message, /FAKE-AI prospect body/);
    else assert.ok(!clientMail.message.includes("We've received your request and a member of our team"), 'the live model wrote the email');
    hit('partner email sent'); hit('client email sent');
  });

  test('warm and cold referrals land in standard and nurture', { skip: LIVE && 'tier choice is the live model’s judgment' }, async () => {
    assert.equal((await send(lead({ intent: 'Comparing auto quotes' }))).json.routing_tier, 'standard'); hit('tier standard');
    assert.equal((await send(lead({ intent: 'Just browsing, curious about home insurance' }))).json.routing_tier, 'nurture'); hit('tier nurture');
  });

  test('answers wrapped in ```json fences are still understood', { skip: LIVE && 'fake model only' }, async () => {
    const r = await send(lead({ intent: 'Ready to buy this month (fence)' }));
    assert.equal(r.json.routing_tier, 'immediate');
    assert.ok(!mock.calls.slack[0].text.includes(FALLBACK_SUMMARY));
    hit('validator: fenced JSON accepted');
  });

  test('a prose answer falls back to a safe default instead of breaking', { skip: LIVE && 'fake model only' }, async () => {
    const r = await send(lead({ intent: 'Ready to buy this month (prose)' }));
    assert.equal(r.json.success, true);
    assert.equal(r.json.routing_tier, 'standard', 'warm fallback means standard');
    assert.match(mock.calls.slack[0].text, /AI Lead Score: warm \(0% confidence\)/);
    hit('validator: prose falls back');
  });

  test('a model trying to change the client email cannot redirect HubSpot', { skip: LIVE && 'fake model only' }, async () => {
    const r = await send(lead({ intent: 'Ready to buy this month (inject)' }));
    assert.equal(r.json.success, true);
    assert.equal(mock.calls.hubspot[0].email, 'maria.sanchez@example.com');
    assert.equal(mock.calls.gmail.find(g => g.kind === 'prospect').to, 'maria.sanchez@example.com');
    hit('validator: injected keys dropped');
  });

  test('when every AI call fails, the referral still succeeds on fallbacks', { skip: LIVE && 'fake model only' }, async () => {
    mock.state.aiDown = true;
    const r = await send(lead());
    assert.deepEqual(r.json, { success: true, message: 'Referral received successfully', partner_code: 'PARTNER001', prospect: 'Maria Sanchez', routing_tier: 'standard' });
    assert.equal(mock.calls.claude.length, 12, 'each of the 4 agents tried 3 times');
    assert.ok(mock.calls.slack[0].text.includes(FALLBACK_SUMMARY));
    assert.match(mock.calls.gmail.find(g => g.kind === 'prospect').message, /a member of our team will follow up with you shortly/);
    hit('agents fail: all four fallbacks');
  });

  test('a HubSpot rejection is logged and sales is still told', { skip: LIVE && 'fake services only' }, async () => {
    const r = await send(lead({ prospect_email: 'maria.hubfail@example.com' }));
    assert.equal(r.json.success, true);
    const [logged] = mock.calls.crmErrors;
    assert.equal(logged.failed_node, 'HubSpot: Upsert Contact');
    assert.equal(logged.prospect_email, 'maria.hubfail@example.com');
    assert.ok(logged.error_message && !/\[object Object\]/.test(logged.error_message), `readable error, got "${logged.error_message}"`);
    assert.match(mock.calls.slack[0].text, /CRM Synced: ❌ No - logged to CRM_Sync_Errors/);
    assert.equal(mock.calls.gmail.length, 2, 'both emails still go out');
    hit('HubSpot error branch logged');
  });

  test('a phone number sent as digits does not crash the run', { skip: LIVE && 'fake model only' }, async () => {
    const r = await send({ ...lead(), prospect_phone: 4155550192 });
    assert.equal(r.json.success, true);
    hit('numeric phone accepted');
  });
});
