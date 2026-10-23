#!/usr/bin/env node
// npm run mutation
// Coverage says a line ran. This checks the tests would actually FAIL if the
// code broke: it plants one known bug at a time in a copy of the project and
// expects the test suite to catch it. Most of these bugs really happened.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WF = 'n8n/referral-partner-program.json';
const MUTANTS = [
  { name: 'Slack reads AI fields from $json again (real bug, Oct 19)', file: WF, from: "$('Validate Referral Decision').item.json.lead_score", to: '$json.lead_score' },
  { name: 'An agent stops the run on an API error (real bug)', file: WF, from: '"onError": "continueRegularOutput"', to: '"onError": "stopWorkflow"' },
  { name: 'IF node back to strict types: numeric phone crashes (real bug)', file: WF, from: '"typeValidation": "loose"', to: '"typeValidation": "strict"' },
  { name: 'Validator no longer strips ```json fences (real bug)', file: WF, from: ".replace(/^```(?:json)?\\\\s*/i, '')", to: '' },
  { name: 'Validator lets the model overwrite lead fields (found this week)', file: WF, from: 'parsed = {};', to: 'parsed = data;' },
  { name: 'Validator accepts any tier value', file: WF, from: 'Array.isArray(rule) ? rule.includes(value)', to: 'Array.isArray(rule) ? true' },
  { name: 'Success response drops routing_tier', file: WF, from: ', routing_tier: $node[\\"Validate Referral Decision\\"].json.routing_tier', to: '' },
  { name: 'HubSpot failure stops the run', file: WF, from: '"onError": "continueErrorOutput"', to: '"onError": "stopWorkflow"' },
  { name: 'CRM error message becomes unreadable', file: WF, from: "$json.error || $json.message || 'Unknown HubSpot error'", to: "'x'" },
  { name: 'Portal no longer recognises "Unknown partner code"', file: 'app.js', from: '/unknown partner/i', to: '/unknown-partner/i' },
  { name: 'Portal stops uppercasing partner codes', file: 'app.js', from: ".replace(/\\s+/g, '').toUpperCase()", to: ".replace(/\\s+/g, '')" },
  { name: 'Portal sends without the consent check', file: 'app.js', from: "if (!data.consent) e.consent = 'Confirm your client agreed to be contacted.';", to: '' },
  { name: 'Portal keeps the draft after a successful send', file: 'app.js', from: '          store(DRAFT_KEY, null);\n          store(CODE_KEY, data.partner_code);', to: '          store(CODE_KEY, data.partner_code);' },
  { name: 'Hidden elements show again ("Sending…" always visible, real bug)', file: 'index.html', from: '[hidden] { display: none !important; }', to: '' },
  { name: 'Timeout message replaced by the generic network error', file: 'app.js', from: "if (err && err.name === 'AbortError') renderError('timeout'", to: "if (false) renderError('timeout'" }
];

function copyProject(dest) {
  for (const entry of fs.readdirSync(ROOT)) {
    if (['.git', 'coverage', 'node_modules', '.it', 'demo'].includes(entry)) continue;
    fs.cpSync(path.join(ROOT, entry), path.join(dest, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(dest, 'demo'));
  for (const f of ['server.js', 'feed.html']) fs.copyFileSync(path.join(ROOT, 'demo', f), path.join(dest, 'demo', f));
}

let caught = 0;
const results = [];
for (const m of MUTANTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-mut-'));
  try {
    copyProject(dir);
    const file = path.join(dir, m.file);
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(m.from)) throw new Error(`mutation "${m.name}" no longer applies: update tests/mutation-check.js`);
    fs.writeFileSync(file, src.split(m.from).join(m.to));
    const tests = fs.readdirSync(path.join(dir, 'tests')).filter(f => f.endsWith('.test.js')).map(f => path.join('tests', f));
    const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8' });
    const failed = (r.stdout.match(/^ℹ fail (\d+)/m) || [])[1];
    const ok = r.status !== 0;
    if (ok) caught++;
    results.push({ name: m.name, caught: ok, failing: Number(failed || 0) });
    console.log(`${ok ? '✔ caught ' : '✖ MISSED'}  ${m.name}${ok ? `  (${failed} failing tests)` : ''}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const line = `\nMutation score: ${caught} of ${MUTANTS.length} planted bugs caught.`;
console.log(line);
fs.mkdirSync(path.join(ROOT, 'coverage'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'coverage', 'mutation.json'), JSON.stringify({ caught, total: MUTANTS.length, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Mutation check\n${results.map(r => `- ${r.caught ? '✅' : '❌'} ${r.name}`).join('\n')}\n${line}\n`);
process.exit(caught === MUTANTS.length ? 0 : 1);
