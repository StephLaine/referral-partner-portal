// Tiny Chrome DevTools Protocol client, so browser tests need no dependencies.
// Uses the Chrome already installed on the machine (or CHROME_PATH).
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

function findChrome() { return CANDIDATES.find(p => fs.existsSync(p)) || null; }

async function launch() {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found. Set CHROME_PATH.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-chrome-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on('exit', c => reject(new Error('Chrome exited ' + c)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else listeners.forEach(fn => fn(msg));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  async function newPage({ width = 430, height = 932, scale = 2 } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Page.enable'); await s('Runtime.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 });
    const errors = [];
    listeners.push(m => { if (m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const page = {
      errors,
      async eval(expr) {
        const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async goto(url) { await s('Page.navigate', { url }); await page.waitFor("document.readyState === 'complete'"); },
      async waitFor(expr, timeout = 15000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) { try { if (await page.eval(expr)) return true; } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
        throw new Error('Timed out waiting for: ' + expr);
      },
      async fill(values) {
        return page.eval(`(() => { const v = ${JSON.stringify(values)};
          for (const [id, val] of Object.entries(v)) { const el = document.getElementById(id);
            if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
            el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
          return true; })()`);
      },
      click(sel) { return page.eval(`document.querySelector(${JSON.stringify(sel)}).click(), true`); },
      async screenshot(file) {
        const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      },
      async fullHeight() { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 }); const h = await page.eval('Math.ceil(document.documentElement.scrollHeight)'); await s('Emulation.setDeviceMetricsOverride', { width, height: Math.max(height, h), deviceScaleFactor: scale, mobile: width < 600 }); },
      close: () => send('Target.closeTarget', { targetId })
    };
    return page;
  }

  async function close() {
    try { ws.close(); } catch (_) {}
    proc.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return { newPage, close };
}

module.exports = { launch, findChrome };
