# Technical handoff

This is for whoever takes over the Referral Partner Portal. After reading it you should be able to run it, change it, deploy it and fix it without asking anyone. Start with the [README](README.md) for what the product does. This page covers how it works and how to extend it.

Status: the portal is deployed on Vercel and posts to the n8n Cloud instance `stef667`. Every test passes in CI.

## 1. The pieces and who owns them

Every account below currently belongs to Stéphane Laine. Moving each one to Gaya's team is the first handoff step.

| Piece | Where | What it does | Notes |
|---|---|---|---|
| Portal | GitHub `StephLaine/referral-partner-portal`, a public repo | Static form: `index.html`, `app.js`, `config.js` | No build step |
| Hosting | Vercel, https://referral-partner-portal-smoky.vercel.app | Deploys every push to `main` to production | `.vercelignore` limits the site to the three app files |
| Workflow | n8n Cloud, instance `stef667` | Receives the form, runs the agents, does the actions | The export is `n8n/referral-partner-program.json`. |
| AI | Anthropic API | Four Claude calls per referral | Needs an API key credential in n8n |
| Partner list and lead log | Google Sheet "Week 1 Referral Program extended" | Tabs `Partners`, `Leads`, `CRM_Sync_Errors` | Two Google credentials are used. See section 4. |
| CRM | HubSpot | Contact upsert by email | Needs four custom contact properties |
| Sales alert | Slack channel `#referral-leads` | One message per referral | Slack OAuth credential |
| Email | Gmail | Partner confirmation and client welcome | Gmail OAuth credential |

## 2. The contract between the portal and the workflow

This is the part most likely to break when someone changes one side only. The workflow tests check it.

**Request.** The portal sends `POST` with `Content-Type: application/json` to the production webhook, path `/webhook/referral`.

```json
{
  "partner_code": "PARTNER001",
  "prospect_name": "Maria Sanchez",
  "prospect_email": "maria.sanchez@example.com",
  "prospect_phone": "+1 415 555 0192",
  "intent": "Ready to buy term life for my family this month",
  "consent": true
}
```

The portal trims every field. It uppercases the partner code and strips its spaces, and it lowercases the email. The workflow requires the first five fields to be non-empty. It currently ignores `consent`.

**Responses.** All of them are JSON.

| Situation | HTTP | Body | Portal shows |
|---|---|---|---|
| Success | 200 | `{"success":true,"message":"Referral received successfully","partner_code":"…","prospect":"…","routing_tier":"immediate"\|"standard"\|"nurture"}` | Confirmation with a tier badge |
| A field is missing | 200 | `{"success":false,"error":"Missing required field"}` | "Some details were missing" |
| Unknown partner code | 200 | `{"success":false,"error":"Unknown partner code"}` | An error next to the partner code field |
| The workflow crashed | 500 | `{"message":"Error in workflow"}` | "Something went wrong on our side" |
| No answer within 45 seconds | n/a | n/a | "This is taking longer than usual", with a warning not to resend |

Rejections come back with HTTP 200 and `success:false`. The portal matches on the `error` text, in `interpretResponse` in `app.js`. **If you change a rejection message in n8n, change the matching rule in `app.js` too.**

## 3. The portal

| File | What's in it |
|---|---|
| `index.html` | Markup and all the CSS. The `[hidden] { display: none !important }` rule matters: without it, elements styled `display:flex` ignore `hidden`. |
| `config.js` | `webhookUrl` and `timeoutMs`. It is the only file to edit when the n8n URL changes. |
| `app.js` | The top half holds pure functions: `normalize`, `validate`, `interpretResponse` and `tierInfo`. They're exported for Node, which is how the tests run them. The bottom half wires them to the page and only runs in a browser. |

Browser storage keys. Both are wrapped in try/catch, so the form works without storage.

- `rpp.partnerCode.v1` holds the partner's code. It is saved after a successful referral.
- `rpp.draft.v1` holds the unsent form, excluding consent. It expires after 24 hours and is cleared on success.

A hidden field named `website` is a honeypot. If it's filled, the portal shows a success screen and sends nothing.

## 4. The workflow, node by node

n8n expressions refer to other nodes **by name**, for example `$('Prepare Lead Data1')` or `$node["Webhook1"]`. **Renaming a node silently breaks every expression that names it.** Search the JSON before you rename anything.

| Node | Type | What it does | Watch out for |
|---|---|---|---|
| Webhook1 | Webhook | `POST /referral`, answered by a Respond node | Use the production URL, not `/webhook-test/` |
| Validate Required Fields1 | IF | The five fields are non-empty | Type conversion is on, so numbers don't crash it. Keep `typeValidation: "loose"`. |
| Missing required Field1 | Respond | The rejection | Its text is matched by `app.js` |
| Find Partner1 | Google Sheets | Looks up `partner_code` in `Partners` and returns the first match | Uses the credential "Google Sheets account 2". The others use "Google Sheets account". Always outputs data, even with no match. |
| Partner Valid?1 | IF | The lookup returned a `partner_code` | Loose types, like above |
| Unknown Partner1 | Respond | The rejection | Its text is matched by `app.js` |
| Prepare Lead Data1 | Set | Builds the lead: partner fields from the sheet, client fields from the webhook, `status: New`, `timestamp` | Its name appears 39 times in the workflow JSON |
| Save Lead1 | Google Sheets | Appends to `Leads` | Runs before any AI, so the lead is saved even if everything after fails |
| Lead Qualification Agent | HTTP to Anthropic | `lead_score`, `confidence`, `reasoning` | Set to retry 3 times, then continue on error |
| CRM Enrichment Agent | HTTP to Anthropic | `lifecyclestage`, `recommended_product`, `internal_note` | Same settings |
| Partner Communication Agent | HTTP to Anthropic | `partner_email_body`, `prospect_email_body` | Same settings |
| Validate … (4 nodes) | Code | Strip code fences, `JSON.parse`, check the required keys, keep only the keys the agent may set, check enums and ranges, else use a fallback. Add `<node>_valid` and `<node>_error`. | **Generated** by `n8n/build-validators.js`. Edit the schema there and rerun it, never the node by hand. The fallback values are listed in section 6. |
| Merge AB, Merge ABC | Merge, combine by position | Join the three validated outputs into one item | Each agent returns one item. Combining by position assumes that. |
| Referral Decision Agent | HTTP to Anthropic | `routing_tier`, `final_summary` from the merged item | Tiers must stay `immediate`, `standard` or `nurture` |
| HubSpot: Upsert Contact | HubSpot | Creates or updates the contact by email | Its output **replaces** the item. That's why downstream nodes read from `Validate Referral Decision` and `Prepare Lead Data1`, not from `$json`. On error it takes the second output. |
| CRM Success / CRM Error | Set | Adds `crm_synced`, `crm_contact_id` (from `id` or `vid`) and `crm_error` | |
| Log CRM Sync Error | Google Sheets | Appends to `CRM_Sync_Errors` | |
| Notify Sales1 | Slack | One message with the AI score, tier and summary | Reads AI fields from `Validate Referral Decision`. A test enforces this. |
| Partner Confirmation1, Prospect Welcome1 | Gmail | The two emails, with AI-written bodies | n8n adds a "sent automatically with n8n" footer unless you turn it off in Options |
| Success Response1 | Respond | The success JSON | Its fields are read by `app.js` |

**Model.** The four agent nodes call `claude-sonnet-4-5` through an HTTP Header Auth credential, sending the API key in the `x-api-key` header. The export carries a placeholder credential ID, so attach a real credential after import. Notes from September 11 describe a live version that used n8n's built-in Anthropic credits and `claude-sonnet-4-6`. **Check which version is really live before editing.**

**Execution order.** n8n runs the three specialist agents one after another, not at the same time. Expect several seconds per referral.

## 5. Setting it up from scratch

1. **Google Sheet.** Create three tabs:
   - `Partners`: at least `partner_code`, `partner_name` and `partner_email`.
   - `Leads`: `timestamp`, `partner_code`, `partner_name`, `partner_email`, `prospect_name`, `prospect_email`, `prospect_phone`, `intent` and `status`.
   - `CRM_Sync_Errors`: `timestamp`, `failed_node`, `partner_code`, `prospect_email`, `status_code` and `error_message`.
2. **HubSpot.** Create the contact properties `referral_partner_code`, `referral_partner_name`, `referral_partner_email` and `referral_intent`.
3. **Import into n8n.** Import `n8n/referral-partner-program.json`, then connect the Google Sheets, HubSpot, Slack and Gmail credentials. Point the three Sheets nodes at your sheet and the Slack node at your channel.
4. **Anthropic credential.** Create a Header Auth credential with the name `x-api-key` and your API key as the value. Select it on all four agent nodes.
5. **Activate.** Activate the workflow and copy the production webhook URL into `config.js`.
6. **Push.** Push to `main`, and Vercel deploys within about a minute.
7. **Test.** Send one referral with your own email address, then check the Slack message, both emails, the HubSpot contact and the Leads row.

## 6. Failure behavior

| What fails | What happens | Where to look |
|---|---|---|
| An agent errors, times out or returns bad JSON | Its validator uses the fallback and the run continues | Look in n8n Executions, then check that validator's `_valid` and `_error` fields |
| Fallback values | Qualification gives `warm` and confidence 0. Enrichment gives `lead` and "General inquiry". Communication gives standard polite emails. Decision gives `standard` with "Automated summary unavailable … review referral manually". | |
| HubSpot rejects the contact | The error is logged to `CRM_Sync_Errors`, and Slack says "CRM Synced: No" | The `CRM_Sync_Errors` tab |
| Slack or Gmail fails | **The run stops and the portal shows a server error.** The lead is already in the Leads sheet. | n8n Executions, filtered by Error |
| n8n is down | The portal shows "We couldn't reach the server", and nothing is saved | n8n Cloud console |

Slack and Gmail have no error branch yet. If you add one, give each node `onError: continueRegularOutput` and add a test to `tests/workflow.test.js`.

## 7. How to extend it

**Add a form field**, for example "best time to call":
1. In `index.html`, add the input and an `err-<id>` element.
2. In `app.js`, add it to `normalize`. Also add it to `validate` if it's required, to `FIELDS` so drafts keep it, and to `LIMITS`.
3. In n8n, add an assignment to `Prepare Lead Data1`: `={{$node["Webhook1"].json.body.<field>}}`. Add a column to `Save Lead1` and to the Leads tab.
4. If the field is required, also add it to `Validate Required Fields1` and to `REQUIRED` in `demo/server.js`. The workflow test that compares the required fields to the portal's payload will remind you.

**Add a fifth agent:**
1. Duplicate an agent node and its validator. Change the prompt, the required key and the fallback.
2. Wire it from `Save Lead1`, then add a Merge node after `Merge ABC`.
3. Keep `onError: continueRegularOutput` and the retry settings.
4. Add its schema to `n8n/build-validators.js` and rerun it.
5. Add the agent's name to `AGENTS` in `tests/workflow.test.js` and `tests/integration/build-workflow.js`, and teach the fake Claude in `tests/integration/mock-services.js` to answer it.

**Change the tiers.** Change all of these together:
- The Decision agent's prompt, and its schema and fallback in `n8n/build-validators.js`.
- `TIERS` in `app.js`.
- `TIER` in `demo/feed.html`.
- `referralDecision` in `demo/server.js`.
- The tier test in `tests/workflow.test.js`.

**Change the model.** Edit the `model` value in the `jsonBody` of the four agent nodes.

**Add a partner.** Add a row to the Partners tab. For the demo server, also add it to `PARTNERS` in `demo/server.js`.

**Change the email wording.** The fixed parts are in the two Gmail nodes. The body paragraph comes from the Partner Communication Agent's prompt.

## 8. Development loop

```bash
npm run demo          # portal and simulated workflow on http://localhost:8787, sales feed on /feed
npm test              # 111 unit and browser tests, about 10 seconds, no dependencies
npm run test:n8n      # 10 integration tests: the real workflow on a throwaway n8n 2.43.8
npm run coverage      # coverage/REPORT.md; fails below 85% critical-path line coverage
npm run mutation      # plants 15 known bugs; fails if any goes uncaught
npm run screenshots   # re-capture demo/screenshots/*.png
npm run rehearse      # timed dry run of the 5-minute live demo
node n8n/build-validators.js   # regenerate the four validator nodes after editing their schema
```

`tests/helpers/browser.js` drives the installed Chrome over the DevTools protocol, so there's no Puppeteer to install. Set `CHROME_PATH` to use another Chromium-based browser, or `SKIP_BROWSER=1` to skip it. `tests/helpers/n8n-sandbox.js` runs Code-node scripts and `{{ }}` expressions taken straight from the workflow JSON.

| Test file | What it protects |
|---|---|
| `tests/app.test.js` | Input cleaning, validation messages, reading every workflow response |
| `tests/validators.test.js` | The four validator scripts from the workflow JSON, executed: fences, prose, missing keys, bad enum values, out-of-range confidence, API errors, injected lead fields |
| `tests/expressions.test.js` | The workflow's expressions, evaluated: Claude request bodies (including quotes and newlines), the Slack message on both CRM paths, the HubSpot fields, the success response, email recipients |
| `tests/workflow.test.js` | The workflow export: wiring, every branch answers the webhook, the field contract, loose type checks, agents continuing on error, Slack reading from the right node, the HubSpot error branch |
| `tests/demo-server.test.js` | The demo server answers exactly like the workflow, outages included |
| `tests/e2e.test.js` | The real page in Chrome: hidden states, validation, success, drafts, unknown code, crash, network failure, timeout, AI outage, no JS errors |
| `tests/integration/workflow.itest.js` | The real workflow on n8n, with Sheets, HubSpot, Slack and Gmail recorded and Claude faked (or real with `LLM_MODE=live`) |

CI runs all of this on every push and pull request (`.github/workflows/test.yml`). When you change the workflow in n8n, export it over `n8n/referral-partner-program.json` and push. The integration test will tell you whether the change broke a critical path.

The demo server mirrors the workflow's contract on purpose. If you change a response in n8n, change `demo/server.js` too, or the tests will stop meaning anything.

## 9. Decisions and why

- **n8n instead of custom code.** A non-developer can open the workflow, see each step and change a prompt.
- **A validator after every agent.** Model output is treated like untrusted user input. A bad answer becomes a safe default, never a lost referral.
- **The lead is saved before any AI runs.** If everything downstream fails, the referral still exists in the Leads sheet.
- **The portal never retries a POST automatically.** A retry could create a duplicate referral if the first request did arrive. After a timeout, the partner is told to check for a confirmation email first.
- **No dependencies or build step.** Anyone can open the folder and run it, which also lowers the cost of handing it over.

## 10. Security and privacy

- **Credentials live only in n8n.** The repo holds no API keys or passwords.
- **Some IDs are public.** The public repo's workflow export contains the Google Sheet ID, the Slack channel ID and internal n8n credential IDs. They're not secrets, but they are visible to anyone. Make the repo private if that matters to you.
- **The webhook has no authentication.** Anyone who finds the URL can post to it. CORS only restricts browsers. Consider a shared-secret header checked in n8n, or a rate-limiting proxy.
- **Client details go to several places.** Name, email, phone and need go to Google Sheets, HubSpot, Slack, Gmail and the Anthropic API. The partner confirms consent in the form, but the workflow doesn't store it yet. That's the second item in the README's next steps.
