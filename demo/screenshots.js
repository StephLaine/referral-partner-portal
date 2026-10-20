#!/usr/bin/env node
// Captures every portal state against the demo server: npm run screenshots
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createDemoServer } = require('./server.js');
const { launch } = require('../tests/helpers/browser.js');

const OUT = path.join(__dirname, 'screenshots');
const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !el.closest('[hidden]'); })()`;
const maria = { partner_code: 'PARTNER001', prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '+1 415 555 0192', intent: 'other', intent_other: 'Ready to buy term life for my family this month', consent: true };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const demo = createDemoServer({ speed: 0.3, quiet: true });
  await new Promise(r => demo.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  const browser = await launch();
  const shot = async (page, name) => { await new Promise(r => setTimeout(r, 700)); await page.eval('window.scrollTo(0,0), true'); await page.fullHeight(); await page.screenshot(path.join(OUT, name + '.png')); console.log('  saved', name + '.png'); };
  try {
    const page = await browser.newPage({ width: 430, height: 932 });
    await page.goto(base); await page.eval('localStorage.clear(), true'); await page.goto(base);
    await shot(page, '1-form');
    await page.click('#submit-btn'); await shot(page, '2-validation');
    await page.goto(base); await page.fill(maria); await page.click('#submit-btn');
    await new Promise(r => setTimeout(r, 1200)); await shot(page, '3-sending');
    await page.waitFor(visible('.status-panel.success'), 30000); await shot(page, '4-success-priority');
    await page.click('#reset-btn');
    await page.fill({ ...maria, prospect_name: 'Emily Carter', prospect_email: 'emily.carter@example.com', intent_other: 'Just browsing, curious what home insurance costs' });
    await page.click('#submit-btn'); await page.waitFor(visible('.status-panel.success'), 30000); await shot(page, '5-success-nurture');
    await page.click('#reset-btn');
    await page.fill({ ...maria, partner_code: 'PARTNER999' }); await page.click('#submit-btn');
    await page.waitFor(visible('#err-partner_code'), 30000); await shot(page, '6-unknown-partner');
    demo.state.crashNext = true;
    await page.fill({ partner_code: 'PARTNER001' }); await page.click('#submit-btn');
    await page.waitFor(visible('.status-panel.error'), 30000);
    await page.eval("document.querySelector('.tech-detail').open = true, true"); await shot(page, '7-server-error');
    await page.close();

    // Fill the feed with the three personas from the real September run, then capture it.
    demo.feed.length = 0;
    const post = (b) => fetch(base + '/webhook/referral', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const p = { partner_code: 'PARTNER001', prospect_phone: '+14155550192' };
    await post({ ...p, prospect_name: 'Emily Carter', prospect_email: 'emily.carter@example.com', intent: 'Just browsing, curious what home insurance costs' });
    await post({ ...p, prospect_name: 'David Kim', prospect_email: 'david.kim@example.com', intent: 'Comparing auto insurance quotes, not urgent' });
    await post({ ...p, prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', intent: 'Ready to buy term life insurance for my family this month' });
    const feed = await browser.newPage({ width: 1100, height: 900, scale: 2 });
    await feed.goto(base + '/feed'); await feed.waitFor("document.querySelectorAll('.msg').length === 3");
    await shot(feed, '8-sales-feed');
  } finally { await browser.close(); demo.server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
