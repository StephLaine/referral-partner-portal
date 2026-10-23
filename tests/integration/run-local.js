#!/usr/bin/env node
// Runs the n8n integration tests on this machine:
//   N8N_BIN=/path/to/n8n npm run test:n8n
// N8N_BIN defaults to `n8n` on your PATH (npm install -g n8n@2.43.8).
// It uses a throwaway n8n data folder, so your own n8n is never touched.
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WORKFLOW_ID } = require('./build-workflow.js');

const ROOT = path.join(__dirname, '..', '..');
const N8N = process.env.N8N_BIN || 'n8n';
const PORT = Number(process.env.N8N_PORT || 5688);
const MOCK_PORT = Number(process.env.MOCK_PORT || 5699);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-n8n-'));
const itDir = path.join(home, 'it');
const env = { ...process.env, N8N_USER_FOLDER: home, N8N_PORT: String(PORT), N8N_LISTEN_ADDRESS: '127.0.0.1', N8N_DIAGNOSTICS_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false', N8N_RUNNERS_BROKER_PORT: String(PORT + 1), MOCK_URL: `http://127.0.0.1:${MOCK_PORT}` };
const n8n = (...args) => execFileSync(N8N, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let server;
const cleanup = () => { try { server && server.kill('SIGTERM'); } catch (_) {} fs.rmSync(home, { recursive: true, force: true }); };
process.on('exit', cleanup);

(async () => {
  execFileSync(process.execPath, [path.join(__dirname, 'build-workflow.js'), itDir], { env, stdio: 'inherit' });
  console.log('Importing into a throwaway n8n…');
  n8n('import:credentials', `--input=${itDir}/credentials.json`);
  n8n('import:workflow', `--input=${itDir}/workflow.json`);
  n8n('publish:workflow', `--id=${WORKFLOW_ID}`);
  server = spawn(N8N, ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/healthz')).ok && /Editor is now accessible/.test(log)) break; } catch (_) {}
    if (i > 180) { console.error(log.slice(-3000)); throw new Error('n8n did not start'); }
    await new Promise(r => setTimeout(r, 1000));
  }
  // n8n answers /healthz before it has registered the workflow's webhook.
  // A GET on a registered POST-only webhook says "Did you mean to make a POST request?".
  for (let i = 0; ; i++) {
    const r = await fetch(base + '/webhook/referral').then(x => x.text()).catch(() => '');
    if (/POST request/i.test(r)) break;
    if (i > 60) { console.error(r, log.slice(-3000)); throw new Error('webhook never registered'); }
    await new Promise(r2 => setTimeout(r2, 500));
  }
  console.log('n8n is up at', base, 'and the referral webhook is registered');
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.itest.js')).map(f => path.join(__dirname, f));
  const t = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { env: { ...env, N8N_BASE_URL: base }, stdio: 'inherit', cwd: ROOT });
  t.on('exit', (code) => { cleanup(); process.exit(code); });
})().catch(e => { console.error(e.message); cleanup(); process.exit(1); });
