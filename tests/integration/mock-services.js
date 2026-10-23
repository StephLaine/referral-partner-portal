// The outside world, as seen by the workflow during integration tests:
// a fake Claude Messages API and recorders for Sheets, HubSpot, Slack and Gmail.
// Words in the referral's intent pick the fake model's behaviour:
//   fence    answers wrapped in ```json
//   prose    the qualification agent answers in prose
//   inject   the qualification agent tries to overwrite prospect_email
// Emails containing "hubfail" make HubSpot reject the contact.
// Set state.aiDown = true to make every Claude call return HTTP 529.
'use strict';
const http = require('node:http');

const PARTNERS = { PARTNER001: { partner_code: 'PARTNER001', partner_name: 'ABC Insurance', partner_email: 'partner1@example.com' } };
const HOT = /this (week|month)|ready to buy|asap|closing/i;
const COLD = /just browsing|curious/i;

function fakeClaude(body, state) {
  const system = String(body.system || '');
  const user = String(body.messages?.[0]?.content || '');
  const intent = (user.match(/intent: \\?"([^"\\]*)/i) || [])[1] || '';
  const flags = (s) => user.toLowerCase().includes(s);
  if (state.aiDown) return { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
  let answer;
  if (/lead qualification specialist/.test(system)) {
    const score = HOT.test(intent) ? 'hot' : COLD.test(intent) ? 'cold' : 'warm';
    answer = flags('prose') ? 'This looks like a strong lead to me!' : { lead_score: score, confidence: 0.8, reasoning: `Intent: ${intent}`.slice(0, 120), ...(flags('inject') ? { prospect_email: 'attacker@example.com' } : {}) };
  } else if (/CRM data specialist/.test(system)) {
    answer = { lifecyclestage: HOT.test(intent) ? 'opportunity' : 'lead', recommended_product: /life/i.test(intent) ? 'Term Life' : /auto/i.test(intent) ? 'Auto' : 'Home', internal_note: 'Fake CRM note' };
  } else if (/communications specialist/.test(system)) {
    answer = { partner_email_body: 'FAKE-AI partner body', prospect_email_body: 'FAKE-AI prospect body' };
  } else if (/final decision-maker/.test(system)) {
    const score = (user.match(/Lead score: (\w+)/) || [])[1];
    answer = { routing_tier: { hot: 'immediate', warm: 'standard', cold: 'nurture' }[score] || 'standard', final_summary: `FAKE-AI summary for a ${score} lead` };
  } else return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'unknown agent' } } };
  let text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  if (flags('fence')) text = '```json\n' + text + '\n```';
  return { status: 200, json: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } } };
}

function createMockServices() {
  const state = { aiDown: false };
  const calls = { claude: [], partners: [], leads: [], crmErrors: [], hubspot: [], slack: [], gmail: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      switch (url.pathname) {
        case '/v1/messages': {
          calls.claude.push({ headers: { 'x-api-key': req.headers['x-api-key'], 'anthropic-version': req.headers['anthropic-version'] }, body });
          const r = fakeClaude(body, state); return reply(r.status, r.json);
        }
        case '/sheets/partners': { const code = url.searchParams.get('partner_code'); calls.partners.push(code); return reply(200, PARTNERS[code] || {}); }
        case '/sheets/leads': calls.leads.push(body); return reply(200, body);
        case '/sheets/crm-errors': calls.crmErrors.push(body); return reply(200, body);
        case '/hubspot/contact':
          calls.hubspot.push(body);
          if (String(body.email).includes('hubfail')) return reply(400, { status: 'error', message: 'Property "referral_partner_code" does not exist' });
          return reply(200, { vid: 4242, isNew: true });
        case '/slack': calls.slack.push(body); return reply(200, { ok: true, ts: '1.0' });
        case '/gmail': calls.gmail.push(body); return reply(200, { id: 'gmail-1', labelIds: ['SENT'] });
        default: return reply(404, { message: 'not found' });
      }
    });
  });
  const reset = () => { Object.values(calls).forEach(a => { a.length = 0; }); state.aiDown = false; };
  return { server, calls, state, reset };
}

module.exports = { createMockServices };
