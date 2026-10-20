'use strict';
// End-to-end: the real page in headless Chrome against the demo server.
// Skips itself when Chrome is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoServer } = require('../demo/server.js');
const { launch, findChrome } = require('./helpers/browser.js');

const skip = findChrome() ? false : 'Chrome not installed (set CHROME_PATH to run browser tests)';
let demo, base, browser, page;

test.describe('portal in a real browser', { skip }, () => {
  test.before(async () => {
    demo = createDemoServer({ speed: 0.05, quiet: true });
    await new Promise(r => demo.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${demo.server.address().port}`;
    browser = await launch();
    page = await browser.newPage();
  });
  test.after(async () => { await browser?.close(); demo?.server.close(); });
  test.beforeEach(async () => {
    Object.assign(demo.state, { aiDown: false, hubspotDown: false, crashNext: false });
    await page.goto(base + '/');
    await page.eval('localStorage.clear(), true');
    await page.goto(base + '/');
  });

  const referral = { partner_code: 'partner001', prospect_name: 'Maria Sanchez', prospect_email: 'maria.sanchez@example.com', prospect_phone: '415 555 0192', intent: 'other', intent_other: 'Ready to buy term life for my family this month', consent: true };
  const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !el.closest('[hidden]') && !el.hidden; })()`;

  test('hidden helpers stay hidden until they are needed', async () => {
    for (const id of ['sending-indicator', 'draft-note', 'config-warning']) {
      assert.equal(await page.eval(`getComputedStyle(document.getElementById('${id}')).display`), 'none', id);
    }
  });

  test('an empty form shows every error and focuses the first field', async () => {
    await page.click('#submit-btn');
    const shown = await page.eval("[...document.querySelectorAll('.field-error')].filter(e => !e.hidden).map(e => e.id)");
    assert.deepEqual(shown.sort(), ['err-consent', 'err-intent', 'err-partner_code', 'err-prospect_email', 'err-prospect_name', 'err-prospect_phone']);
    assert.equal(await page.eval('document.activeElement.id'), 'partner_code');
    assert.equal(demo.feed.length, 0, 'nothing should be sent');
  });

  test('a valid referral reaches the success panel with the right tier', async () => {
    await page.fill(referral);
    await page.click('#submit-btn');
    assert.ok(await page.eval(visible('#sending-indicator')), 'shows progress while sending');
    await page.waitFor(visible('.status-panel.success'));
    assert.equal(await page.eval("document.querySelector('.tier-badge').textContent"), 'Priority follow-up');
    assert.equal(await page.eval('document.activeElement.tagName'), 'H2', 'focus moves to the result for screen readers');
    assert.equal(demo.feed[0].partner_code, 'PARTNER001', 'the partner code was normalized');
    assert.equal(demo.feed[0].prospect_email, 'maria.sanchez@example.com');
  });

  test('"Send another referral" keeps the partner code and clears the rest', async () => {
    await page.fill(referral);
    await page.click('#submit-btn');
    await page.waitFor(visible('#reset-btn'));
    await page.click('#reset-btn');
    assert.equal(await page.eval("document.getElementById('partner_code').value"), 'PARTNER001');
    assert.equal(await page.eval("document.getElementById('prospect_name').value"), '');
    await page.goto(base + '/');
    assert.equal(await page.eval("document.getElementById('partner_code').value"), 'PARTNER001', 'remembered on this device');
  });

  test('an unknown partner code is explained next to the field, with the form intact', async () => {
    await page.fill({ ...referral, partner_code: 'PARTNER999' });
    await page.click('#submit-btn');
    await page.waitFor(visible('#err-partner_code'));
    assert.match(await page.eval("document.getElementById('err-partner_code').textContent"), /don't recognize/);
    assert.equal(await page.eval("document.getElementById('prospect_name').value"), 'Maria Sanchez');
    assert.equal(await page.eval("document.getElementById('submit-btn').disabled"), false);
  });

  test('a half-finished referral survives a reload', async () => {
    await page.fill({ prospect_name: 'David Kim', prospect_email: 'david.kim@example.com' });
    await page.goto(base + '/');
    assert.equal(await page.eval("document.getElementById('prospect_name').value"), 'David Kim');
    assert.ok(await page.eval(visible('#draft-note')));
    await page.click('#discard-draft');
    assert.equal(await page.eval("document.getElementById('prospect_name').value"), '');
  });

  test('a workflow crash shows a calm error and nothing typed is lost', async () => {
    demo.state.crashNext = true;
    await page.fill(referral);
    await page.click('#submit-btn');
    await page.waitFor(visible('.status-panel.error'));
    assert.match(await page.eval("document.querySelector('.status-panel h2').textContent"), /Something went wrong/);
    assert.match(await page.eval("document.querySelector('.tech-detail code').textContent"), /Error in workflow/);
    await page.click('#retry-btn');
    assert.equal(await page.eval("document.getElementById('prospect_email').value"), 'maria.sanchez@example.com');
  });

  test('an AI outage still confirms the referral', async () => {
    demo.state.aiDown = true;
    await page.fill(referral);
    await page.click('#submit-btn');
    await page.waitFor(visible('.status-panel.success'));
    assert.equal(await page.eval("document.querySelector('.tier-badge').dataset.tier"), 'standard');
  });

  test('the page throws no JavaScript errors', () => {
    assert.deepEqual(page.errors, []);
  });
});
