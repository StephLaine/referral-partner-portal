'use strict';
// Unit tests for the four validator Code nodes. The code under test is read
// from n8n/referral-partner-program.json and executed as-is.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorkflow, runCode } = require('./helpers/n8n-sandbox.js');

const { byName } = loadWorkflow();
const lead = {
  partner_code: 'PARTNER001', partner_name: 'ABC Insurance', partner_email: 'partner1@example.com',
  prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '+14155550192',
  intent: 'Ready to buy term life this month', status: 'New', timestamp: '2026-10-20T12:00:00.000Z'
};
const claude = (text) => ({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' });
// What an HTTP Request node set to "continue" outputs when the API call fails.
const httpError = { error: { message: '529 - Overloaded', name: 'NodeApiError' } };

const VALIDATORS = [
  {
    node: 'Validate Lead Qualification', key: 'lead_score', flag: 'validate_lead_qualification',
    good: { lead_score: 'hot', confidence: 0.9, reasoning: 'Clear intent' },
    fallback: { lead_score: 'warm', confidence: 0, reasoning: 'fallback - agent output invalid' },
    invalid: [['lead_score', 'very hot'], ['lead_score', 'HOT'], ['confidence', 1.5], ['confidence', '0.9'], ['reasoning', 42]]
  },
  {
    node: 'Validate CRM Enrichment', key: 'lifecyclestage', flag: 'validate_crm_enrichment',
    good: { lifecyclestage: 'opportunity', recommended_product: 'Term Life', internal_note: 'Call this week' },
    fallback: { lifecyclestage: 'lead', recommended_product: 'General inquiry', internal_note: 'fallback - agent output invalid' },
    invalid: [['lifecyclestage', 'customer'], ['recommended_product', null]]
  },
  {
    node: 'Validate Partner Communication', key: 'partner_email_body', flag: 'validate_partner_communication',
    good: { partner_email_body: 'Thanks for the referral.', prospect_email_body: 'Welcome aboard.' },
    fallback: {
      partner_email_body: 'Thank you for sending us a referral for Maria Sanchez. We have received the referral and our team will follow up with the prospect.',
      prospect_email_body: "Thank you for your interest. We've received your request and a member of our team will follow up with you shortly."
    },
    invalid: [['prospect_email_body', ['a', 'b']]]
  },
  {
    node: 'Validate Referral Decision', key: 'routing_tier', flag: 'validate_referral_decision', original: 'Merge ABC',
    good: { routing_tier: 'immediate', final_summary: 'Hot term life lead.' },
    fallback: { routing_tier: 'standard', final_summary: 'Automated summary unavailable - agent output invalid; please review referral manually.' },
    invalid: [['routing_tier', 'urgent'], ['routing_tier', 'Immediate'], ['final_summary', {}]]
  }
];

const run = (v, json) => {
  const nodes = { 'Prepare Lead Data1': lead, 'Merge ABC': { ...lead, lead_score: 'hot' } };
  return runCode(byName[v.node].parameters.jsCode, { json, nodes }, v.node).then(out => { assert.equal(out.length, 1); return out[0].json; });
};
const original = (v) => (v.original ? { ...lead, lead_score: 'hot' } : lead);

for (const v of VALIDATORS) {
  test.describe(v.node, () => {
    test('accepts a clean JSON answer and keeps every lead field', async () => {
      const out = await run(v, claude(JSON.stringify(v.good)));
      assert.deepEqual(out, { ...original(v), ...v.good, [`${v.flag}_valid`]: true, [`${v.flag}_error`]: '' });
    });

    test('accepts JSON wrapped in a ```json fence', async () => {
      const out = await run(v, claude('```json\n' + JSON.stringify(v.good, null, 2) + '\n```'));
      assert.equal(out[`${v.flag}_valid`], true);
      assert.equal(out[v.key], v.good[v.key]);
    });

    test('accepts a bare ``` fence and surrounding whitespace', async () => {
      const out = await run(v, claude('  \n```\n' + JSON.stringify(v.good) + '\n```  \n'));
      assert.equal(out[`${v.flag}_valid`], true);
    });

    test('falls back when the model answers in prose', async () => {
      const out = await run(v, claude('Sure! Here is my assessment: this lead looks promising.'));
      assert.deepEqual(out, { ...original(v), ...v.fallback, [`${v.flag}_valid`]: false, [`${v.flag}_error`]: out[`${v.flag}_error`] });
      assert.match(out[`${v.flag}_error`], /JSON/);
    });

    test(`falls back when "${v.key}" is missing`, async () => {
      const { [v.key]: _drop, ...rest } = v.good;
      const out = await run(v, claude(JSON.stringify(rest)));
      assert.equal(out[`${v.flag}_valid`], false);
      assert.equal(out[`${v.flag}_error`], `missing required key: ${v.key}`);
      assert.equal(out[v.key], v.fallback[v.key]);
    });

    test('falls back instead of crashing when the API call itself failed', async () => {
      const out = await run(v, httpError);
      assert.equal(out[`${v.flag}_valid`], false);
      assert.equal(out[v.key], v.fallback[v.key]);
    });

    test('falls back on an empty content list', async () => {
      const out = await run(v, { content: [] });
      assert.equal(out[`${v.flag}_valid`], false);
    });

    test('a model answer can never overwrite lead fields', async () => {
      const out = await run(v, claude(JSON.stringify({ ...v.good, prospect_email: 'attacker@example.com', partner_code: 'X', status: 'Won' })));
      assert.equal(out[`${v.flag}_valid`], true, 'extra keys are dropped, not fatal');
      assert.equal(out.prospect_email, lead.prospect_email);
      assert.equal(out.partner_code, lead.partner_code);
      assert.equal(out.status, 'New');
    });

    test('falls back when the answer is a JSON array or a bare value', async () => {
      for (const text of ['[1,2,3]', '"hot"', 'null', '42']) {
        const out = await run(v, claude(text));
        assert.equal(out[`${v.flag}_valid`], false, text);
        assert.equal(out[v.key], v.fallback[v.key]);
      }
    });

    for (const [field, bad] of v.invalid) {
      test(`falls back when ${field} is ${JSON.stringify(bad)}`, async () => {
        const out = await run(v, claude(JSON.stringify({ ...v.good, [field]: bad })));
        assert.equal(out[`${v.flag}_valid`], false);
        assert.equal(out[`${v.flag}_error`], `invalid ${field}: ${JSON.stringify(bad)}`);
        assert.equal(out[v.key], v.fallback[v.key]);
      });
    }
  });
}

test('the partner communication validator needs both email bodies', async () => {
  const v = VALIDATORS[2];
  const out = await run(v, claude(JSON.stringify({ partner_email_body: 'Thanks!' })));
  assert.equal(out.validate_partner_communication_valid, false);
  assert.equal(out.validate_partner_communication_error, 'missing required key: prospect_email_body');
  assert.ok(out.prospect_email_body.length > 20, 'the client still gets a real email');
});

test('the four validators are generated from one template', () => {
  for (const v of VALIDATORS) assert.match(byName[v.node].parameters.jsCode, /^\/\/ Generated by n8n\/build-validators\.js/);
});

test('the demo server uses the same fallbacks as the workflow', () => {
  const src = require('node:fs').readFileSync(require.resolve('../demo/server.js'), 'utf8');
  for (const v of VALIDATORS) for (const val of Object.values(v.fallback)) {
    if (typeof val === 'string' && !val.includes('Maria Sanchez')) assert.ok(src.includes(val), `${v.node} fallback "${val}" missing from demo/server.js`);
  }
});
