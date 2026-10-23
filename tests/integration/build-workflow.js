// Builds the workflow n8n imports for the integration tests.
//
// It starts from n8n/referral-partner-program.json and changes only the nodes
// that talk to outside services:
//   - Google Sheets, HubSpot, Slack, Gmail become HTTP Request nodes that send
//     the same fields to a local recorder (tests/integration/mock-services.js).
//   - The four agent nodes stay real HTTP Request nodes with their real body,
//     headers, retries and credential. Only their URL changes, to a fake Claude,
//     unless LLM_MODE=live, which keeps https://api.anthropic.com.
// Everything else (IF checks, Set nodes, validators, merges, responses) runs
// exactly as exported.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'n8n', 'referral-partner-program.json');
const WORKFLOW_ID = 'itReferralWf0001';
const CREDENTIAL_ID = 'itAnthropicCred01';
const AGENTS = ['Lead Qualification Agent', 'CRM Enrichment Agent', 'Partner Communication Agent', 'Referral Decision Agent'];

function http(node, { method = 'POST', url, body, query }) {
  const keep = { id: node.id, name: node.name, position: node.position, onError: node.onError, alwaysOutputData: node.alwaysOutputData };
  const params = { method, url, options: {} };
  if (body) Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'keypair', bodyParameters: { parameters: Object.entries(body).map(([name, value]) => ({ name, value })) } });
  if (query) Object.assign(params, { sendQuery: true, queryParameters: { parameters: Object.entries(query).map(([name, value]) => ({ name, value })) } });
  return Object.fromEntries(Object.entries({ ...keep, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: params }).filter(([, v]) => v !== undefined));
}

function build({ mockUrl, live = false, apiKey = 'it-test-key' }) {
  const wf = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const swap = (name, fn) => {
    const i = wf.nodes.findIndex(n => n.name === name);
    if (i < 0) throw new Error('missing node ' + name);
    wf.nodes[i] = fn(wf.nodes[i]);
  };
  const columns = (n) => n.parameters.columns.value;

  swap('Find Partner1', n => http(n, { method: 'GET', url: `${mockUrl}/sheets/partners`, query: { partner_code: n.parameters.filtersUI.values[0].lookupValue } }));
  swap('Save Lead1', n => http(n, { url: `${mockUrl}/sheets/leads`, body: columns(n) }));
  swap('Log CRM Sync Error', n => http(n, { url: `${mockUrl}/sheets/crm-errors`, body: columns(n) }));
  swap('HubSpot: Upsert Contact', n => http(n, { url: `${mockUrl}/hubspot/contact`, body: { email: n.parameters.email, ...n.parameters.additionalFields } }));
  swap('Notify Sales1', n => http(n, { url: `${mockUrl}/slack`, body: { channel: n.parameters.channelId.cachedResultName, text: n.parameters.text } }));
  swap('Partner Confirmation1', n => http(n, { url: `${mockUrl}/gmail`, body: { kind: 'partner', to: n.parameters.sendTo, subject: n.parameters.subject, message: n.parameters.message } }));
  swap('Prospect Welcome1', n => http(n, { url: `${mockUrl}/gmail`, body: { kind: 'prospect', to: n.parameters.sendTo, subject: n.parameters.subject, message: n.parameters.message } }));

  for (const name of AGENTS) swap(name, n => {
    if (!live) n.parameters.url = `${mockUrl}/v1/messages`;
    n.credentials = { httpHeaderAuth: { id: CREDENTIAL_ID, name: 'Anthropic API Key' } };
    if (!live) n.waitBetweenTries = 100; // keep retries realistic in count, fast in time
    return n;
  });

  wf.id = WORKFLOW_ID;
  wf.name = 'Referral Partner Program (integration test)';
  wf.active = true;
  const credentials = [{ id: CREDENTIAL_ID, name: 'Anthropic API Key', type: 'httpHeaderAuth', data: { name: 'x-api-key', value: apiKey } }];
  return { workflow: wf, credentials };
}

module.exports = { build, WORKFLOW_ID };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', '..', '.it');
  const live = process.env.LLM_MODE === 'live';
  if (live && !process.env.ANTHROPIC_API_KEY) { console.error('LLM_MODE=live needs ANTHROPIC_API_KEY'); process.exit(1); }
  const { workflow, credentials } = build({ mockUrl: process.env.MOCK_URL || 'http://127.0.0.1:5699', live, apiKey: live ? process.env.ANTHROPIC_API_KEY : 'it-test-key' });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'workflow.json'), JSON.stringify(workflow, null, 2));
  fs.writeFileSync(path.join(out, 'credentials.json'), JSON.stringify(credentials, null, 2));
  console.log(`Wrote ${out}/workflow.json and credentials.json (${live ? 'LIVE Claude' : 'fake Claude'})`);
}
