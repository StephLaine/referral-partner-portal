#!/usr/bin/env node
/*
 * Demo server for the Referral Partner Portal. Zero dependencies.
 *
 *   npm run demo            then open http://localhost:8787
 *
 * It serves the portal and answers POST /webhook/referral with the SAME
 * response contract as the n8n workflow in n8n/referral-partner-program.json.
 * The four AI agents are SIMULATED with simple keyword rules, so the demo
 * works with no internet, no n8n and no API keys. Say so out loud if you
 * use it in front of an audience.
 *
 * Live toggles (press the key in this terminal):
 *   a  AI outage on/off     every agent fails, so the validators' fallbacks kick in
 *   h  HubSpot outage on/off the CRM error branch runs and the referral still succeeds
 *   x  crash the next run    the workflow errors with HTTP 500, like n8n does
 *   c  clear the sales feed
 *   q  quit
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/feed': ['demo/feed.html', 'text/html; charset=utf-8']
};

// Same rows as the Partners tab of the Google Sheet the workflow reads.
const PARTNERS = {
  PARTNER001: { partner_name: 'ABC Insurance', partner_email: 'partner1@example.com' },
  PARTNER002: { partner_name: 'XYZ Agency', partner_email: 'partner2@example.com' },
  PARTNER003: { partner_name: 'Demo Partner', partner_email: 'partner3@example.com' }
};
const REQUIRED = ['partner_code', 'prospect_name', 'prospect_email', 'prospect_phone', 'intent'];

// ── Simulated agents (keyword rules standing in for Claude) ──────────
const COLD = /\b(just (browsing|looking|curious)|curious|someday|maybe|not sure|thinking about|down the road|next year)\b/i;
const NOT_URGENT = /\b(not urgent|no rush|no hurry|comparing|shopping around)\b/i;
const HOT = /\b(today|tomorrow|asap|urgent|this (week|month)|by (monday|tuesday|wednesday|thursday|friday|the end of)|ready to (buy|sign|start)|renewal|expires?|closing|right away)\b/i;
const PRODUCTS = [
  [/term life/i, 'Term Life Insurance'], [/life/i, 'Life Insurance'], [/auto|car|vehicle/i, 'Auto Insurance'],
  [/home|house|condo/i, 'Home Insurance'], [/rent/i, 'Renters Insurance'], [/business|commercial/i, 'Business Insurance']
];

function nameMatchesEmail(name, email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, ' ');
  return String(name).toLowerCase().split(/\s+/).some(t => t.length >= 3 && local.includes(t));
}

function leadQualification(lead) {
  let score = COLD.test(lead.intent) ? 'cold' : NOT_URGENT.test(lead.intent) ? 'warm' : HOT.test(lead.intent) ? 'hot' : 'warm';
  let confidence = score === 'warm' ? 0.62 : 0.85;
  let reasoning = score === 'hot' ? 'Clear, time-bound buying intent.' : score === 'cold' ? 'Early research with no buying signals.' : 'Real interest but no urgency stated.';
  if (!nameMatchesEmail(lead.prospect_name, lead.prospect_email)) {
    confidence = Math.round((confidence - 0.3) * 100) / 100;
    if (score === 'hot') score = 'warm';
    reasoning += ' Email does not match the name, so verify contact details first.';
  }
  return { lead_score: score, confidence, reasoning };
}
function crmEnrichment(lead, lq) {
  const product = (PRODUCTS.find(([re]) => re.test(lead.intent)) || [null, 'General inquiry'])[1];
  return { lifecyclestage: lq.lead_score === 'hot' ? 'opportunity' : 'lead', recommended_product: product, internal_note: `Referred by ${lead.partner_name}: ${lead.intent}`.slice(0, 150) };
}
function partnerCommunication(lead) {
  return {
    partner_email_body: `Thank you for referring ${lead.prospect_name}. Our team has the details and will reach out shortly. We appreciate your trust.`,
    prospect_email_body: `${lead.partner_name} told us you're interested in ${lead.intent.toLowerCase()}. A member of our team will contact you soon to help.`
  };
}
function referralDecision(m) {
  const tier = { hot: 'immediate', warm: 'standard', cold: 'nurture' }[m.lead_score] || 'standard';
  return { routing_tier: tier, final_summary: `${m.lead_score[0].toUpperCase() + m.lead_score.slice(1)} ${m.recommended_product} lead. ${m.reasoning}`.slice(0, 200) };
}
// Same fallbacks as the validator Code nodes in the n8n workflow.
const FALLBACK = {
  lq: { lead_score: 'warm', confidence: 0, reasoning: 'fallback - agent output invalid' },
  crm: { lifecyclestage: 'lead', recommended_product: 'General inquiry', internal_note: 'fallback - agent output invalid' },
  pc: lead => ({ partner_email_body: `Thank you for sending us a referral for ${lead.prospect_name}. We have received the referral and our team will follow up with the prospect.`, prospect_email_body: "Thank you for your interest. We've received your request and a member of our team will follow up with you shortly." }),
  rd: { routing_tier: 'standard', final_summary: 'Automated summary unavailable - agent output invalid; please review referral manually.' }
};

// ── Terminal output ─────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const C = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = C('2'), green = C('32'), red = C('31'), yellow = C('33'), cyan = C('36'), bold = C('1');

function createDemoServer(opts = {}) {
  const speed = opts.speed ?? Number(process.env.DEMO_SPEED || 1);
  const quiet = opts.quiet ?? false;
  const state = { aiDown: false, hubspotDown: false, crashNext: false };
  const feed = [];
  let runs = 0;
  const log = (...a) => { if (!quiet) console.log(...a); };
  // `unref` lets tests exit while a deliberately slow run is still in progress.
  const wait = (ms) => new Promise(r => { const t = setTimeout(r, ms * speed); if (opts.unref) t.unref(); });

  async function agent(label, fn, fallback, run) {
    const t0 = Date.now();
    await wait(900 + Math.random() * 700);
    try {
      if (state.aiDown) throw new Error('529 Overloaded (simulated AI outage)');
      const out = fn();
      log(`   ${green('✓')} ${label.padEnd(30)} ${dim(JSON.stringify(out).slice(0, 90))} ${dim(`${Date.now() - t0}ms`)}`);
      return { ...out, valid: true };
    } catch (e) {
      log(`   ${yellow('!')} ${label.padEnd(30)} ${yellow(e.message)} ${dim('→ validator used the safe fallback')}`);
      run.fallbacks.push(label);
      return { ...fallback, valid: false };
    }
  }

  async function handleReferral(body) {
    const n = ++runs;
    const started = Date.now();
    log(`\n${bold(`▶ Execution #${n}`)} ${dim(new Date().toLocaleTimeString())}  ${cyan(body.prospect_name || '(no name)')}`);
    if (state.crashNext) {
      state.crashNext = false;
      log(`   ${red('✗')} Workflow crashed (simulated) → HTTP 500`);
      return [500, { message: 'Error in workflow' }];
    }
    const missing = REQUIRED.filter(k => typeof body[k] !== 'string' || body[k] === '');
    if (missing.length) {
      log(`   ${red('✗')} Validate Required Fields → missing ${missing.join(', ')}`);
      return [200, { success: false, error: 'Missing required field' }];
    }
    log(`   ${green('✓')} Validate Required Fields`);
    await wait(250);
    const partner = PARTNERS[body.partner_code];
    if (!partner) {
      log(`   ${red('✗')} Find Partner → "${body.partner_code}" is not in the Partners sheet`);
      return [200, { success: false, error: 'Unknown partner code' }];
    }
    log(`   ${green('✓')} Find Partner                   ${dim(partner.partner_name)}`);
    const lead = { partner_code: body.partner_code, ...partner, prospect_name: body.prospect_name, prospect_email: body.prospect_email, prospect_phone: body.prospect_phone, intent: body.intent, status: 'New', timestamp: new Date().toISOString() };
    await wait(250);
    log(`   ${green('✓')} Save Lead                      ${dim('Leads sheet')}`);
    const run = { fallbacks: [] };
    log(dim('   ── three specialist agents ──'));
    const lq = await agent('Lead Qualification Agent', () => leadQualification(lead), FALLBACK.lq, run);
    const crm = await agent('CRM Enrichment Agent', () => crmEnrichment(lead, lq), FALLBACK.crm, run);
    const pc = await agent('Partner Communication Agent', () => partnerCommunication(lead), FALLBACK.pc(lead), run);
    log(dim('   ── merge → decision agent ──'));
    const merged = { ...lead, ...lq, ...crm, ...pc };
    const rd = await agent('Referral Decision Agent', () => referralDecision(merged), FALLBACK.rd, run);
    await wait(300);
    let crm_synced = true, crm_error = '';
    if (state.hubspotDown) {
      crm_synced = false; crm_error = 'Authorization failed - please check your credentials (simulated)';
      log(`   ${yellow('!')} HubSpot: Upsert Contact        ${yellow('failed')} ${dim('→ logged to CRM_Sync_Errors, flow continues')}`);
    } else log(`   ${green('✓')} HubSpot: Upsert Contact`);
    await wait(250);
    log(`   ${green('✓')} Notify Sales (Slack)  ${green('✓')} Partner email  ${green('✓')} Client email`);
    const ms = Date.now() - started;
    feed.unshift({
      id: n, at: new Date().toISOString(), ms, partner_name: lead.partner_name, partner_code: lead.partner_code,
      prospect_name: lead.prospect_name, prospect_email: lead.prospect_email, prospect_phone: lead.prospect_phone, intent: lead.intent,
      lead_score: lq.lead_score, confidence: lq.confidence, routing_tier: rd.routing_tier, final_summary: rd.final_summary,
      recommended_product: crm.recommended_product, crm_synced, crm_error, fallbacks: run.fallbacks,
      partner_email_body: pc.partner_email_body, prospect_email_body: pc.prospect_email_body
    });
    log(`   ${bold('→ HTTP 200')} routing_tier=${bold(rd.routing_tier)} ${dim(`in ${(ms / 1000).toFixed(1)}s`)}`);
    return [200, { success: true, message: 'Referral received successfully', partner_code: lead.partner_code, prospect: lead.prospect_name, routing_tier: rd.routing_tier }];
  }

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && url.pathname === '/config.js') {
      return send(res, 200, `window.PORTAL_CONFIG = { webhookUrl: ${JSON.stringify(opts.webhookUrl || '/webhook/referral')}, timeoutMs: ${opts.timeoutMs || 45000}, demo: true };\n`, 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(ROOT, file)), type);
    }
    if (req.method === 'POST' && url.pathname === '/webhook/referral') {
      const body = await readBody(req);
      if (body === null) return send(res, 500, { message: 'Error in workflow' });
      const [status, out] = await handleReferral(body);
      return send(res, status, out);
    }
    if (url.pathname === '/__demo/feed') return send(res, 200, { state, feed });
    if (req.method === 'POST' && url.pathname === '/__demo/state') {
      const b = (await readBody(req)) || {};
      ['aiDown', 'hubspotDown', 'crashNext'].forEach(k => { if (typeof b[k] === 'boolean') state[k] = b[k]; });
      if (b.clear) feed.length = 0;
      return send(res, 200, { state });
    }
    send(res, 404, { message: 'Not found' });
  });
  return { server, state, feed };
}

module.exports = { createDemoServer, leadQualification, crmEnrichment, referralDecision, nameMatchesEmail, PARTNERS };

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const { server, state, feed } = createDemoServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(bold('\nReferral Partner Portal · demo server') + dim('  (agents are SIMULATED, not Claude)'));
    console.log(`  Portal      ${cyan(`http://localhost:${port}`)}`);
    console.log(`  Sales feed  ${cyan(`http://localhost:${port}/feed`)}`);
    console.log(dim('  Partner codes: PARTNER001, PARTNER002, PARTNER003'));
    console.log(dim('  Keys: [a] AI outage  [h] HubSpot outage  [x] crash next run  [c] clear feed  [q] quit'));
  });
  const status = () => console.log(dim(`\n  state → AI ${state.aiDown ? red('DOWN') : green('up')} · HubSpot ${state.hubspotDown ? red('DOWN') : green('up')}${state.crashNext ? red(' · next run will crash') : ''}`));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => {
      if (k === 'q' || k === '\u0003') process.exit(0);
      if (k === 'a') state.aiDown = !state.aiDown;
      if (k === 'h') state.hubspotDown = !state.hubspotDown;
      if (k === 'x') state.crashNext = true;
      if (k === 'c') { feed.length = 0; console.log(dim('\n  sales feed cleared')); }
      if ('ahx'.includes(k)) status();
    });
  }
}
