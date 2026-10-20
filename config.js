// Where the portal sends referrals.
// Use the n8n PRODUCTION webhook URL (/webhook/...), not the /webhook-test/ URL,
// and make sure the workflow is active in n8n.
// The demo server (npm run demo) serves its own version of this file,
// so you never need to edit it to rehearse.
window.PORTAL_CONFIG = {
  webhookUrl: 'https://stef667.app.n8n.cloud/webhook/referral',
  // The workflow calls four AI agents before it answers, so allow it some time.
  timeoutMs: 45000
};
