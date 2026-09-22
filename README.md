# Referral Partner Portal (Production Prototype)

A single-page app for insurance referral partners to submit a client referral
that flows straight into the n8n multi-agent workflow from Modules 1–3.

## How to run locally
No build step, no dependencies. Just open `index.html` in a browser, or serve
it with any static server, e.g.:
```
npx serve .
```
Then visit the printed localhost URL.

## Configuration
Open `index.html` and find this line near the top of the `<script>` block:
```js
const WEBHOOK_URL = "https://stef667.app.n8n.cloud/webhook/referral";
```
This must be your n8n **Production** webhook URL, not the `/webhook-test/`
one — production URLs work continuously once the workflow is Activated
(toggle in the top-right of the n8n editor); test URLs only fire once per
"Listen for Test Event" click, which is why a real deployed app can't use one.

**CORS:** your browser will block the request unless the n8n webhook node
allows it. In the Webhook node's settings, set "Allowed Origins (CORS)" to
`*` for testing, or to your deployed app's exact origin for production.
Without this, submissions will fail with a network-style error in the app
even though the workflow itself is fine.

## What each flow does
- **Referral form** — collects partner code, client name, email, phone, and
  what they're looking for (a fixed set of common options, or a free-text
  "Other"). Client-side validation runs before anything is sent — this is
  the visible validation-error state.
- **Submit** — POSTs the form as JSON to the n8n webhook. While in flight,
  the submit button disables and a "Sending referral…" indicator shows.
- **Success** — reads the workflow's response (`success`, `prospect`,
  `routing_tier`) and shows a confirmation panel with a tier badge
  (Priority / Standard / Nurture, from the Referral Decision Agent).
- **Error handling** — two distinct failure paths are handled visibly:
  - *Network failure*: `fetch` itself throws (offline, DNS failure, CORS
    block) → "We couldn't reach the server" panel with a Try Again button
    that returns to the form with nothing lost.
  - *Server/workflow failure*: the response comes back but isn't a success
    (non-200 status, malformed JSON, or `success` not `true`) → "Something
    went wrong sending this" panel, with the raw error detail shown in
    monospace for debugging.

## Known limitations
- No authentication — anyone with the link can submit a referral. Acceptable
  for a partner-facing intake form at this stage, but there's no
  rate-limiting or spam protection yet.
- The `partner_code` field isn't validated client-side against a real partner
  list — an unknown code is only caught inside the n8n workflow, so the form
  will show a generic server-error panel rather than a specific "unknown
  partner code" message. A future version should have the workflow return a
  distinct error payload for this case so the app can message it more
  precisely.
- No retry/backoff on network failure beyond the manual "Try Again" button.
- No persistence — if the tab is closed after a network failure, the typed
  data is lost. Acceptable for a first prototype; a future version could
  save a draft to localStorage.
- Tested against the n8n workflow's current field names and response shape
  (`success`, `prospect`, `routing_tier`) — if those change in a future
  module, this app's success/error rendering will need matching updates.
