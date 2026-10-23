#!/usr/bin/env node
// npm run coverage
// Runs the test suite with V8 coverage on, in Node and in Chrome, and writes
// coverage/REPORT.md. Coverage is measured on the code that matters:
//   - app.js, the whole portal (pure logic in Node, browser wiring in Chrome)
//   - the four validator scripts inside the n8n workflow JSON
//   - demo/server.js, the demo backend (reported, but not a production path)
// plus the workflow branch coverage from the n8n integration test, if it ran.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { BODY_PREFIX } = require('./helpers/n8n-sandbox.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'coverage');
const V8 = path.join(OUT, 'v8');
const MIN = Number(process.env.COVERAGE_MIN || 85);

fs.rmSync(V8, { recursive: true, force: true });
fs.mkdirSync(V8, { recursive: true });
const tests = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).map(f => path.join('tests', f));
const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: V8, COVERAGE_DIR: V8 }, encoding: 'utf8' });
const summary = (run.stdout.match(/^ℹ (tests|pass|fail|skipped) \d+$/gm) || []).join('  ');
if (run.status !== 0) { process.stdout.write(run.stdout.slice(-4000)); console.error('Tests failed; no report.'); process.exit(run.status || 1); }

// ── V8 block coverage → line coverage ──────────────────────────────
function executableLines(text) {
  let inBlock = false;
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return false; }
    if (t.startsWith('/*')) { inBlock = !t.includes('*/'); return false; }
    return t !== '' && !t.startsWith('//');
  });
}
// Returns the set of covered line numbers (0-based) of `source`, counting
// only characters in [from, to).
function coveredLines(source, functions, from = 0, to = source.length) {
  const counts = new Int32Array(source.length).fill(-1);
  const ranges = functions.flatMap(f => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, source.length));
  const lines = new Set();
  let line = 0;
  for (let i = from; i < to; i++) {
    if (source[i] === '\n') { line++; continue; }
    if (counts[i] > 0 && source[i].trim()) lines.add(line);
  }
  return lines;
}

const dumps = fs.readdirSync(V8).filter(f => f.endsWith('.json')).flatMap(f => JSON.parse(fs.readFileSync(path.join(V8, f), 'utf8')).result || []);
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n', 'referral-partner-program.json'), 'utf8'));
const targets = [
  { label: 'app.js (portal)', file: 'app.js', critical: true, match: u => u.endsWith('/app.js') },
  ...wf.nodes.filter(n => n.type === 'n8n-nodes-base.code').map(n => ({ label: `n8n: ${n.name}`, node: n, critical: true, match: u => u === `n8n-node/${encodeURIComponent(n.name)}` })),
  { label: 'demo/server.js (demo only)', file: 'demo/server.js', critical: false, match: u => u.endsWith('/demo/server.js') }
];

const rows = [];
for (const t of targets) {
  const text = t.file ? fs.readFileSync(path.join(ROOT, t.file), 'utf8') : t.node.parameters.jsCode;
  const exec = executableLines(text);
  const covered = new Set();
  for (const d of dumps.filter(d => t.match(d.url))) {
    if (t.file) { for (const l of coveredLines(text, d.functions)) covered.add(l); continue; }
    // new Function source: "(function anonymous(<params>\n) {\n" + BODY_PREFIX + jsCode + ...
    const header = '(function anonymous($json,$,$node,$now\n) {\n' + BODY_PREFIX;
    const full = header + text + '\n})();';
    for (const l of coveredLines(full, d.functions, header.length, header.length + text.length)) covered.add(l);
  }
  const total = exec.filter(Boolean).length;
  const hit = exec.reduce((n, isExec, i) => n + (isExec && covered.has(i) ? 1 : 0), 0);
  const missed = exec.map((isExec, i) => (isExec && !covered.has(i) ? i + 1 : null)).filter(Boolean);
  rows.push({ ...t, total, hit, pct: total ? (100 * hit) / total : 100, missed });
}

const critical = rows.filter(r => r.critical);
const critHit = critical.reduce((n, r) => n + r.hit, 0), critTotal = critical.reduce((n, r) => n + r.total, 0);
const critPct = (100 * critHit) / critTotal;
const branchesFile = path.join(OUT, 'workflow-branches.json');
const branches = fs.existsSync(branchesFile) ? JSON.parse(fs.readFileSync(branchesFile, 'utf8')) : null;

const ranges = (nums) => nums.reduce((acc, n) => { const last = acc[acc.length - 1]; if (last && n === last[1] + 1) last[1] = n; else acc.push([n, n]); return acc; }, []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
const md = [
  '# Test coverage report',
  '',
  `Generated ${new Date().toISOString()} by \`npm run coverage\`. Tests: ${summary}.`,
  '',
  `**Critical-path line coverage: ${critPct.toFixed(1)}%** (${critHit} of ${critTotal} executable lines in the portal and the workflow's validator code).`,
  branches ? `**Workflow branch coverage on real n8n: ${branches.covered.length} of ${branches.total}** critical branches (${branches.mode}). Source: \`npm run test:n8n\`.` : '**Workflow branch coverage:** not measured in this run. Run `npm run test:n8n` first.',
  '',
  '| Code | Lines covered | % | Uncovered lines |',
  '|---|---|---|---|',
  ...rows.map(r => `| ${r.label} | ${r.hit} / ${r.total} | ${r.pct.toFixed(1)}% | ${r.missed.length ? ranges(r.missed) : 'none'} |`),
  '',
  'Line coverage merges Node and Chrome runs. Blank and comment-only lines are not counted.',
  branches && branches.missed.length ? `\nUncovered workflow branches: ${branches.missed.join(', ')}.` : ''
].join('\n');
fs.writeFileSync(path.join(OUT, 'REPORT.md'), md + '\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
if (critPct < MIN) { console.error(`\nCritical-path coverage ${critPct.toFixed(1)}% is below the ${MIN}% floor.`); process.exit(1); }
