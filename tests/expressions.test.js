'use strict';
// Unit tests for the n8n expressions that shape data between nodes. Each
// expression is read from the workflow export and evaluated.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorkflow, evaluate } = require('./helpers/n8n-sandbox.js');

const { byName } = loadWorkflow();
const p = (node) => byName[node].parameters;
const webhook = { body: { partner_code: 'PARTNER001', prospect_name: 'Maria Ann Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '+14155550192', intent: 'Ready to buy term life this month' } };
const partner = { partner_code: 'PARTNER001', partner_name: 'ABC Insurance', partner_email: 'partner1@example.com' };
const lead = { ...partner, ...webhook.body, status: 'New', timestamp: '2026-10-20T12:00:00.000Z' };
const decision = { ...lead, lead_score: 'hot', confidence: 0.86, reasoning: 'Clear intent', lifecyclestage: 'opportunity', recommended_product: 'Term Life', internal_note: 'Call soon', partner_email_body: 'Thanks!', prospect_email_body: 'Welcome!', routing_tier: 'immediate', final_summary: 'Hot term life lead.' };
const nodes = { Webhook1: webhook, 'Prepare Lead Data1': lead, 'Validate Referral Decision': decision, 'Merge ABC': decision };

test('Prepare Lead Data maps the webhook body and the partner row into one lead', () => {
  const out = Object.fromEntries(p('Prepare Lead Data1').assignments.assignments.map(a => [a.name, evaluate(a.value, { json: partner, nodes })]));
  assert.deepEqual({ ...out, timestamp: undefined }, { ...lead, timestamp: undefined });
});

for (const agent of ['Lead Qualification Agent', 'CRM Enrichment Agent', 'Partner Communication Agent', 'Referral Decision Agent']) {
  test(`${agent} sends a valid Messages API request`, () => {
    const body = JSON.parse(evaluate(p(agent).jsonBody, { json: decision, nodes }));
    assert.equal(p(agent).url, 'https://api.anthropic.com/v1/messages');
    assert.ok(p(agent).headerParameters.parameters.some(h => h.name === 'anthropic-version'), 'anthropic-version header');
    assert.match(body.model, /^claude-/);
    assert.ok(body.max_tokens >= 200, 'room for the JSON answer');
    assert.match(body.system, /Respond with ONLY a JSON object/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(!/undefined/.test(body.messages[0].content), `every field the prompt names is filled: ${body.messages[0].content}`);
  });

  test(`${agent} keeps the request valid when the partner types quotes, backticks and newlines`, () => {
    const intent = 'Needs "full" coverage\nfor `two` cars, ${not code} \\ ok';
    const nasty = { ...lead, intent, prospect_name: "D'Angelo \"DJ\" O'Neil" };
    const n = { ...nodes, 'Prepare Lead Data1': nasty };
    const body = JSON.parse(evaluate(p(agent).jsonBody, { json: { ...decision, ...nasty }, nodes: n }));
    if (agent !== 'Referral Decision Agent') assert.ok(body.messages[0].content.includes(intent), 'the intent reaches the model unchanged');
  });
}

test('the decision agent is told the scores the specialists produced', () => {
  const body = JSON.parse(evaluate(p('Referral Decision Agent').jsonBody, { json: decision, nodes }));
  for (const v of ['hot', '0.86', 'Clear intent', 'Term Life', 'Call soon']) assert.ok(body.messages[0].content.includes(v), v);
});

test('the Slack message shows the AI score, tier and summary on the success path', () => {
  // On the success path $json is the CRM Success output: the HubSpot response
  // plus crm_* fields. It does NOT contain the AI fields. This was the bug.
  const crmSuccess = { vid: 4242, crm_synced: true, crm_contact_id: '4242', crm_error: '' };
  const text = evaluate(p('Notify Sales1').text, { json: crmSuccess, nodes });
  assert.match(text, /AI Lead Score: hot \(86% confidence\)/);
  assert.match(text, /AI Routing Tier: immediate/);
  assert.match(text, /AI Summary: Hot term life lead\./);
  assert.match(text, /HubSpot ID 4242/);
  assert.match(text, /Prospect: Maria Ann Sanchez/);
});

test('the Slack message says the CRM sync failed and why on the error path', () => {
  const crmError = { crm_synced: false, crm_contact_id: '', crm_error: 'Property "referral_intent" does not exist' };
  const text = evaluate(p('Notify Sales1').text, { json: crmError, nodes });
  assert.match(text, /CRM Synced: ❌ No - logged to CRM_Sync_Errors \(Property "referral_intent" does not exist\)/);
  assert.match(text, /AI Lead Score: hot/, 'sales still sees the AI fields');
});

test('the HubSpot contact id is read from either id or vid', () => {
  const a = p('CRM Success').assignments.assignments.find(x => x.name === 'crm_contact_id');
  assert.equal(evaluate(a.value, { json: { id: '77' }, nodes }), '77');
  assert.equal(evaluate(a.value, { json: { vid: 4242 } , nodes }), 4242);
  assert.equal(evaluate(a.value, { json: {}, nodes }), '');
});

test('the CRM error message is readable whatever shape the error has', () => {
  const a = p('CRM Error').assignments.assignments.find(x => x.name === 'crm_error');
  assert.equal(evaluate(a.value, { json: { error: 'Rate limited' }, nodes }), 'Rate limited');
  assert.equal(evaluate(a.value, { json: { message: 'Timeout' }, nodes }), 'Timeout');
  assert.equal(evaluate(a.value, { json: {}, nodes }), 'Unknown HubSpot error');
});

test('HubSpot splits multi-word names into first and last name', () => {
  const f = p('HubSpot: Upsert Contact').additionalFields;
  assert.equal(evaluate(f.firstname, { json: decision, nodes }), 'Maria');
  assert.equal(evaluate(f.lastname, { json: decision, nodes }), 'Ann Sanchez');
  assert.equal(evaluate(f.lastname, { json: { ...decision, prospect_name: 'Cher' }, nodes }), '');
});

test('the success response is valid JSON even when the name has quotes', () => {
  const n = { ...nodes, 'Prepare Lead Data1': { ...lead, prospect_name: 'D\'Angelo "DJ" O\'Neil' } };
  const body = JSON.parse(evaluate(p('Success Response1').responseBody, { json: {}, nodes: n }));
  assert.deepEqual(body, { success: true, message: 'Referral received successfully', partner_code: 'PARTNER001', prospect: 'D\'Angelo "DJ" O\'Neil', routing_tier: 'immediate' });
});

test('both emails go to the addresses from the lead, never from AI output', () => {
  assert.match(p('Partner Confirmation1').sendTo, /\$node\["Prepare Lead Data1"\]\.json\.partner_email/);
  assert.match(p('Prospect Welcome1').sendTo, /\$node\["Prepare Lead Data1"\]\.json\.prospect_email/);
  const msg = evaluate(p('Prospect Welcome1').message, { json: {}, nodes });
  assert.match(msg, /^Hello Maria Ann Sanchez,\n\nWelcome!\n/);
});
