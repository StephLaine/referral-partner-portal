# Production hardening: Path 1, Test it

[![Tests](https://github.com/StephLaine/referral-partner-portal/actions/workflows/test.yml/badge.svg)](https://github.com/StephLaine/referral-partner-portal/actions/workflows/test.yml)

## Why testing, and why now

Every serious bug I found in Week 9 lived inside the n8n workflow, and not one showed up by reading it: blank AI scores in every Slack message, one AI error stopping the whole referral, stray formatting quietly demoting hot leads, and a numeric phone number crashing the run. Yet the tests I shipped for Demo Day only checked the workflow's JSON and never executed it. For something a paying customer relies on, that's the most dangerous gap, because these failures are silent: a misranked lead or a score-less Slack message looks fine until a deal is lost. Gaya's team will also need to change prompts, add fields and swap models, and without tests that run the real workflow every edit is a gamble. Observability and deploy hardening matter too, but they only pay off once the system behaves correctly, and testing makes it trustworthy wherever it ends up running, so it's the right investment first. The tradeoff I accepted: tests stop known failures from shipping, but they can't tell anyone when the live system breaks at 2 a.m. There's still no alerting or dashboard. And by default, the integration test fakes Claude and the four outside services, so it won't catch an expired credential or a model whose behavior drifts until the live-Claude job runs with a real key.

## Test report

Latest CI run: https://github.com/StephLaine/referral-partner-portal/actions/runs/39931061397 (passed).

| Measure | Result |
|---|---|
| Automated tests | **121**: 111 unit and browser tests, plus 10 integration tests on real n8n |
| Critical-path line coverage | **100%** (336 of 336 lines in the portal and the workflow's four validators) |
| Workflow branch coverage on real n8n | **17 of 17** critical branches |
| Mutation check | **15 of 15** planted bugs caught |

**What "critical path" means here.** Every line of `app.js`, which is the whole portal, and the four validator scripts that decide what happens to AI output. Coverage merges V8 data from Node and from headless Chrome. The demo server is reported but excluded, because it never runs in production. It sits at 86%, and the gaps are its terminal key handling.

**Why the coverage number isn't theatre.** Coverage only proves a line ran. So `npm run mutation` plants 15 known bugs one at a time, 6 of them bugs that really happened, and requires the suite to fail on each. It caught all 15. Along the way it showed that one catch was an accident: a stale draft was only noticed because of a lowercase partner code. I added a test that checks it directly.

### The four layers

| Layer | Tests | What it proves |
|---|---|---|
| Unit: portal logic (`tests/app.test.js`) | 12 | Input cleaning, validation, and reading every response the workflow can send |
| Unit: workflow code (`tests/validators.test.js`, `tests/expressions.test.js`) | 67 | Runs the validator scripts and expressions **read from the workflow JSON itself**: fences, prose, missing keys, bad values, API errors, injected fields, quotes and newlines in user input |
| Contracts (`tests/workflow.test.js`, `tests/demo-server.test.js`) | 20 | The workflow's wiring and settings, and the demo server answering exactly like the workflow |
| Browser (`tests/e2e.test.js`) | 12 | The real page in headless Chrome: validation, success, unknown code, drafts, crash, network failure, timeout, AI outage |
| Integration on real n8n (`tests/integration/`) | 10 | The **actual workflow file** running on n8n 2.43.8: every rejection, all three tiers, fenced and prose answers, every agent failing, a HubSpot rejection, a prompt-injection attempt, a numeric phone |

**What the integration test fakes, and what it doesn't.** Google Sheets, HubSpot, Slack and Gmail are replaced by HTTP calls to a local recorder, so the test can check every row, message and email the workflow would have produced. The four agent nodes stay real: their request bodies, headers, credential and three-try retry all run on n8n. Only their URL points at a fake Claude. With `LLM_MODE=live` and an API key, the same test is built to call the real Anthropic API. That mode hasn't run yet, because no API key is configured on this machine or in CI.

### Bugs this week's tests found

1. **A model answer could overwrite lead fields.** The validators merged the whole model answer over the lead, so an answer containing `prospect_email` replaced the real client email. That merged email is what the HubSpot upsert uses, and the intent field is free text from a public form. A crafted referral could therefore steer the model into rewriting a different HubSpot contact. **Fixed:** each validator now keeps only the keys its agent is allowed to set.
2. **Any tier or score value was accepted.** "urgent", "HOT" or a confidence of 1.5 flowed straight into Slack and the portal. **Fixed:** enum and range checks now apply, with a fallback when a value is invalid.
3. **A missing client email body went unnoticed.** If the communication agent forgot the client email body, the client got an email with no body. **Fixed:** both bodies are now required.

The four validators are generated from one schema file, [n8n/build-validators.js](n8n/build-validators.js), so they can't drift apart. **Re-import `n8n/referral-partner-program.json` into n8n to pick up these fixes.**

## How to run the tests

Locally, with Node 20 or newer and nothing to install:

```bash
npm test               # 111 unit and browser tests, about 10 seconds (browser tests need Chrome)
npm run coverage       # the same tests with coverage; writes coverage/REPORT.md
npm run mutation       # plants 15 bugs and checks each one is caught, about 3 minutes
```

The integration test needs n8n 2.43.8. It runs in a throwaway data folder and never touches your own n8n:

```bash
npm install -g n8n@2.43.8
npm run test:n8n       # or: N8N_BIN=/path/to/n8n npm run test:n8n
LLM_MODE=live ANTHROPIC_API_KEY=sk-ant-... npm run test:n8n   # real Claude, costs a few cents
```

In CI, [.github/workflows/test.yml](.github/workflows/test.yml) runs on every push and pull request. Its main job runs these steps in order:
1. The unit and browser tests.
2. n8n 2.43.8 in Docker with the workflow imported, then the integration tests against it.
3. The coverage report, posted to the run summary.
4. The mutation check.

A second job runs the live-Claude test when the repository has an `ANTHROPIC_API_KEY` secret. It never runs on pull requests, so outside contributors can't spend the API budget. The run summary shows the coverage table, and the coverage files are attached to each run.

## Reflection: what surprised me about production versus the demo

The demo and the production version run almost the same code. The first surprise was that the difference between them isn't features. It's everything around the happy path.

In the demo, I controlled every input. I typed clean names and knew the AI would answer in clean JSON. Production gets whatever a partner types, whatever a model returns and whatever an API does at 2 a.m. That's where the bugs that mattered lived. Sales would have seen blank AI scores in every Slack message, because the HubSpot step replaced the data. A phone number sent as digits crashed the run. None of this showed up when I read the workflow, only when it ran.

The second surprise was that thinking like production found a design flaw, not just mistakes. In the demo, the model is a helpful teammate. In production, it's a stranger whose answers I must check. Asking "what if the model returns extra fields?" revealed that a crafted referral could make it change which HubSpot contact gets updated. Nobody had asked me to think about prompt injection. A test made me.

The third surprise was how easy it is to fake confidence. One browser run took coverage from 34% to 99%. Planting bugs on purpose was the honest check, and it showed one passing test was catching a bug by accident.

The fourth surprise was that the safety net needs testing too. My fake AI outage never reached one of the agents, and n8n reported itself healthy before its webhook was ready. Each looked like a product bug until I checked.

A demo has to work once, in front of people. Production has to keep working when nobody is watching. The demo earned applause. The tests are what let Gaya put this in front of a paying customer.
