#!/usr/bin/env node
// Dry run of the 5-minute live demo, at real speed, in headless Chrome.
//   npm run rehearse
// Prints how long each step takes, so you can check the demo fits its slot
// before you are on stage. Typing time is added as an estimate.
//
//   WITH_OPTIONAL=1 npm run rehearse      include the optional wrong-code step
//   WEBHOOK=https://…/webhook/referral npm run rehearse
//        send the referrals to the REAL n8n workflow instead of the simulator.
//        This sends real emails and Slack posts and writes real rows.
'use strict';
const { createDemoServer } = require('./server.js');
const { launch } = require('../tests/helpers/browser.js');

const TYPING_S = Number(process.env.TYPING_S || 25); // a person filling the form with copy-paste
const WEBHOOK = process.env.WEBHOOK || '';
const WITH_OPTIONAL = !!process.env.WITH_OPTIONAL;
const BUDGET_S = 5 * 60;
const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !el.closest('[hidden]'); })()`;
const base = { partner_code: 'PARTNER001', prospect_phone: '+1 415 555 0192', intent: 'other', consent: true };
const STEPS = [
  { say: 'Map slide, switch windows', talk: 30 },
  { name: 'Maria Sanchez', email: 'maria.sanchez@example.com', want: 'Ready to buy term life for my family this month', expect: 'Priority follow-up', talk: 45 },
  { name: 'David Kim', email: 'david.kim@example.com', want: 'Comparing auto insurance quotes, not urgent', expect: 'Standard follow-up', talk: 20 },
  { name: 'Emily Carter', email: 'emily.carter@example.com', want: 'Just browsing, curious what home insurance costs', expect: 'Added to our nurture list', talk: 20 },
  { name: 'Wrong code (optional)', email: 'test@example.com', want: 'Auto quote', code: 'PARTNER01', expect: 'unknown', talk: 20, optional: true },
  { name: 'AI outage (demo server only)', email: 'jordan.lee@example.com', want: 'Need home insurance before closing next week', expect: 'Standard follow-up', aiDown: true, talk: 50, person: 'Jordan Lee', simOnly: true }
];

(async () => {
  const demo = createDemoServer({ quiet: true, webhookUrl: WEBHOOK || undefined });
  if (WEBHOOK) console.log('Rehearsing against the REAL workflow at', WEBHOOK);
  await new Promise(r => demo.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${demo.server.address().port}`;
  const browser = await launch();
  const rows = []; let total = 0, ok = true;
  try {
    const page = await browser.newPage({ width: 1280, height: 900, scale: 1 });
    await page.goto(url); await page.eval('localStorage.clear(), true'); await page.goto(url);
    for (const s of STEPS) {
      if (!s.name) { rows.push([s.say, '-', '-', s.talk, 'ok']); total += s.talk; continue; }
      if ((s.optional && !WITH_OPTIONAL) || (s.simOnly && WEBHOOK)) { rows.push([s.name, '-', '-', '-', 'skipped']); continue; }
      demo.state.aiDown = !!s.aiDown;
      if (await page.eval(visible('#reset-btn'))) await page.click('#reset-btn');
      await page.fill({ ...base, partner_code: s.code || base.partner_code, prospect_name: s.person || s.name, prospect_email: s.email, intent_other: s.want });
      const t0 = Date.now();
      await page.click('#submit-btn');
      let got;
      if (s.expect === 'unknown') { await page.waitFor(visible('#err-partner_code'), 60000); got = 'unknown'; }
      else { await page.waitFor(visible('.status-panel'), 60000); got = await page.eval("(document.querySelector('.tier-badge')||{}).textContent || document.querySelector('.status-panel h2').textContent"); }
      const wait = (Date.now() - t0) / 1000;
      const pass = got === s.expect; ok = ok && pass;
      const step = TYPING_S + wait + s.talk; total += step;
      rows.push([s.name, TYPING_S, wait.toFixed(1), s.talk, pass ? 'ok' : `GOT "${got}"`]);
    }
    if (page.errors.length) { ok = false; console.log('JS errors:', page.errors); }
  } finally { await browser.close(); demo.server.close(); }

  console.log('\nStep                          typing  system  talking  result');
  for (const [n, t, w, k, r] of rows) console.log(`${String(n).padEnd(30)}${String(t).padStart(6)}s${String(w).padStart(7)}s${String(k).padStart(8)}s  ${r}`);
  const m = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
  console.log(`\nLive demo estimate: ${m(total)} of a ${m(BUDGET_S)} slot  ${total <= BUDGET_S ? '(fits)' : '(OVER: cut a step)'}`);
  console.log('Every step behaved as expected:', ok ? 'yes' : 'NO');
  process.exit(ok && total <= BUDGET_S ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
