'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, validate, interpretResponse, tierInfo } = require('../app.js');

const good = { partner_code: 'PARTNER001', prospect_name: 'Maria Sanchez', prospect_email: 'maria@example.com', prospect_phone: '+1 415 555 0192', intent: 'Life insurance quote', consent: true };

test('normalize trims, uppercases the partner code and lowercases the email', () => {
  const d = normalize({ partner_code: ' partner 001 ', prospect_name: '  Maria   Sanchez ', prospect_email: ' Maria@Example.COM ', prospect_phone: ' 415-555-0192 ', intent: 'Auto insurance quote', consent: true });
  assert.deepEqual(d, { partner_code: 'PARTNER001', prospect_name: 'Maria Sanchez', prospect_email: 'maria@example.com', prospect_phone: '415-555-0192', intent: 'Auto insurance quote', consent: true });
});

test('normalize uses the free-text box when "other" is chosen', () => {
  assert.equal(normalize({ intent: 'other', intent_other: '  Renters policy, moving next week ' }).intent, 'Renters policy, moving next week');
});

test('normalize never sends a non-boolean consent', () => {
  assert.equal(normalize({ consent: 'yes' }).consent, false);
});

test('validate accepts a complete referral', () => {
  assert.deepEqual(validate(good), {});
});

test('validate reports every missing field at once', () => {
  const e = validate(normalize({}));
  assert.deepEqual(Object.keys(e).sort(), ['consent', 'intent', 'partner_code', 'prospect_email', 'prospect_name', 'prospect_phone']);
});

test('validate puts the intent error on the free-text box when "other" is chosen', () => {
  const e = validate({ ...good, intent: '' }, true);
  assert.ok(e.intent_other);
  assert.equal(e.intent, undefined);
});

test('validate rejects malformed emails, short phones and odd partner codes', () => {
  assert.ok(validate({ ...good, prospect_email: 'maria@example' }).prospect_email);
  assert.ok(validate({ ...good, prospect_phone: '12345' }).prospect_phone);
  assert.ok(validate({ ...good, partner_code: 'P!' }).partner_code);
  assert.deepEqual(validate({ ...good, prospect_phone: '(415) 555-0192' }), {});
});

test('validate enforces length limits', () => {
  assert.ok(validate({ ...good, intent: 'x'.repeat(301) }).intent);
});

test('interpretResponse recognises the workflow success payload', () => {
  const o = interpretResponse(200, { success: true, message: 'Referral received successfully', partner_code: 'PARTNER001', prospect: 'Maria Sanchez', routing_tier: 'immediate' });
  assert.deepEqual(o, { kind: 'success', prospect: 'Maria Sanchez', tier: 'immediate' });
});

test('interpretResponse maps the workflow rejection messages', () => {
  assert.equal(interpretResponse(200, { success: false, error: 'Unknown partner code' }).kind, 'unknown_partner');
  assert.equal(interpretResponse(200, { success: false, error: 'Missing required field' }).kind, 'missing_field');
});

test('interpretResponse treats n8n crashes and odd payloads as server errors', () => {
  const o = interpretResponse(500, { message: 'Error in workflow' });
  assert.equal(o.kind, 'server');
  assert.match(o.detail, /Error in workflow.*500/);
  assert.equal(interpretResponse(200, null).kind, 'server');
  assert.equal(interpretResponse(500, { success: true }).kind, 'server');
});

test('tierInfo covers the three tiers and defaults to standard', () => {
  assert.equal(tierInfo('immediate').label, 'Priority follow-up');
  assert.equal(tierInfo('nurture').cls, 'tier-nurture');
  assert.equal(tierInfo('banana').label, 'Standard follow-up');
});
