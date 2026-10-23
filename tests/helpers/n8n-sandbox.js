// Runs code and expressions taken straight from the n8n workflow export, so the
// unit tests execute the exact logic n8n would, not a copy of it.
// It provides the parts of n8n's runtime those snippets use: $json, $(),
// $node[...], $now. It is not a full n8n; the integration tests cover that.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', 'n8n', 'referral-partner-program.json');

function loadWorkflow() {
  const wf = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const byName = Object.fromEntries(wf.nodes.map(n => [n.name, n]));
  return { wf, byName };
}

// `nodes` maps node name -> that node's output json for the current item.
function context({ json = {}, nodes = {} } = {}) {
  const ref = (name) => {
    if (!(name in nodes)) throw new Error(`Test did not provide output for node "${name}"`);
    return { item: { json: nodes[name] }, first: () => ({ json: nodes[name] }), json: nodes[name] };
  };
  const $node = new Proxy({}, { get: (_, name) => ref(String(name)) });
  const now = new Date('2026-10-20T12:00:00.000Z');
  const $now = { toISO: () => now.toISOString(), toString: () => now.toISOString(), toJSON: () => now.toISOString() };
  return { $json: json, $: ref, $node, $now };
}

// Run a Code node's jsCode the way n8n does: as an async function body that
// returns an array of { json } items.
// `name` tags the script so coverage can attribute it to that workflow node.
const BODY_PREFIX = 'return (async () => {\n';
async function runCode(jsCode, ctx, name) {
  const c = context(ctx);
  const tag = name ? `\n//# sourceURL=n8n-node/${encodeURIComponent(name)}` : '';
  const fn = new Function('$json', '$', '$node', '$now', `${BODY_PREFIX}${jsCode}\n})();${tag}`);
  return fn(c.$json, c.$, c.$node, c.$now);
}

// Evaluate an n8n parameter value. Values starting with "=" are expressions:
// every {{ … }} is evaluated, the rest is literal text.
function evaluate(value, ctx) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const c = context(ctx);
  const tpl = value.slice(1);
  const run = (code) => new Function('$json', '$', '$node', '$now', `return (${code});`)(c.$json, c.$, c.$node, c.$now);
  const whole = tpl.match(/^\s*\{\{([\s\S]*)\}\}\s*$/);
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, code) => {
    const v = run(code);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

module.exports = { loadWorkflow, runCode, evaluate, BODY_PREFIX };
