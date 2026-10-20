/*
 * Referral Partner Portal — form logic.
 *
 * The pure functions at the top (normalize, validate, interpretResponse,
 * tierInfo) have no DOM access, so the tests in /tests run them under Node.
 * The browser wiring at the bottom only runs when a document is present.
 */
(function (root) {
  'use strict';

  var LIMITS = { partner_code: 40, prospect_name: 120, prospect_email: 254, prospect_phone: 40, intent: 300 };

  // Tidy what the partner typed into the payload the n8n workflow expects.
  function normalize(raw) {
    var r = raw || {};
    var str = function (v) { return (v == null ? '' : String(v)).trim(); };
    var intent = str(r.intent) === 'other' ? str(r.intent_other) : str(r.intent);
    return {
      // The Partners sheet stores codes like PARTNER001 and the lookup is exact.
      partner_code: str(r.partner_code).replace(/\s+/g, '').toUpperCase(),
      prospect_name: str(r.prospect_name).replace(/\s+/g, ' '),
      prospect_email: str(r.prospect_email).toLowerCase(),
      prospect_phone: str(r.prospect_phone),
      intent: intent.replace(/\s+/g, ' '),
      consent: r.consent === true
    };
  }

  // Returns a map of field id -> message. An empty map means the form is valid.
  // `choseOther` tells us to attach intent errors to the free-text box.
  function validate(data, choseOther) {
    var e = {};
    if (!data.partner_code) e.partner_code = 'Enter your partner code.';
    else if (!/^[A-Z0-9_-]{3,40}$/.test(data.partner_code)) e.partner_code = 'Partner codes use letters and numbers only, like PARTNER001.';

    if (!data.prospect_name) e.prospect_name = "Enter your client's full name.";
    else if (data.prospect_name.length < 2) e.prospect_name = "That name looks too short.";

    if (!data.prospect_email) e.prospect_email = "Enter your client's email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.prospect_email)) e.prospect_email = "That email doesn't look right. Check for typos.";

    var digits = data.prospect_phone.replace(/\D/g, '');
    if (!data.prospect_phone) e.prospect_phone = "Enter your client's phone number.";
    else if (digits.length < 7 || digits.length > 15) e.prospect_phone = 'Enter a phone number with 7 to 15 digits.';

    if (!data.intent) e[choseOther ? 'intent_other' : 'intent'] = choseOther ? 'Describe what your client needs.' : 'Choose what your client needs.';

    if (!data.consent) e.consent = 'Confirm your client agreed to be contacted.';

    Object.keys(LIMITS).forEach(function (k) {
      if (!e[k] && data[k] && data[k].length > LIMITS[k]) e[k] = 'Keep this under ' + LIMITS[k] + ' characters.';
    });
    return e;
  }

  // Turn the workflow's HTTP response into one of a few outcomes the UI knows.
  // The workflow answers 200 with {success:false, error:"..."} for rejections.
  function interpretResponse(status, payload) {
    var p = payload && typeof payload === 'object' ? payload : null;
    if (p && p.success === true && status >= 200 && status < 300) {
      return { kind: 'success', prospect: p.prospect || '', tier: p.routing_tier || 'standard' };
    }
    var err = p && (p.error || p.message) ? String(p.error || p.message) : '';
    if (/unknown partner/i.test(err)) return { kind: 'unknown_partner' };
    if (/missing required/i.test(err)) return { kind: 'missing_field' };
    return { kind: 'server', detail: err ? err + ' (HTTP ' + status + ')' : 'The server responded with HTTP ' + status + '.' };
  }

  var TIERS = {
    immediate: { label: 'Priority follow-up', cls: 'tier-immediate', note: 'Flagged as a priority lead for our first callbacks.' },
    standard: { label: 'Standard follow-up', cls: 'tier-standard', note: 'Queued for a call from our team.' },
    nurture: { label: 'Added to our nurture list', cls: 'tier-nurture', note: "We'll keep in touch with helpful information until they're ready." }
  };
  function tierInfo(tier) { return TIERS[tier] || TIERS.standard; }

  var api = { normalize: normalize, validate: validate, interpretResponse: interpretResponse, tierInfo: tierInfo, LIMITS: LIMITS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ReferralPortal = api;

  if (typeof document === 'undefined') return;

  // ── Browser wiring ────────────────────────────────────────────────
  var config = Object.assign({ webhookUrl: '', timeoutMs: 45000 }, root.PORTAL_CONFIG || {});
  var DRAFT_KEY = 'rpp.draft.v1', CODE_KEY = 'rpp.partnerCode.v1', DRAFT_TTL = 24 * 3600 * 1000;
  var FIELDS = ['partner_code', 'prospect_name', 'prospect_email', 'prospect_phone', 'intent', 'intent_other'];

  function $(id) { return document.getElementById(id); }
  var form = $('referral-form'), formCard = $('form-card'), resultArea = $('result-area');
  var submitBtn = $('submit-btn'), sending = $('sending-indicator'), sendingText = $('sending-text');
  var intentSelect = $('intent'), otherWrap = $('other-intent-wrap'), otherInput = $('intent_other');

  // Storage can be unavailable (private mode, blocked site data). Never let that break the form.
  function store(key, val) { try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } }

  function readForm() {
    var raw = {};
    FIELDS.forEach(function (f) { raw[f] = $(f).value; });
    raw.consent = $('consent').checked;
    return raw;
  }

  function saveDraft() {
    var raw = readForm();
    delete raw.consent; // consent is per referral; always ask again
    store(DRAFT_KEY, { at: Date.now(), raw: raw });
  }

  function restoreDraft() {
    var d = load(DRAFT_KEY), restored = false;
    if (d && d.raw && Date.now() - d.at < DRAFT_TTL) {
      FIELDS.forEach(function (f) { if (d.raw[f]) { $(f).value = d.raw[f]; if (f !== 'partner_code') restored = true; } });
    } else if (d) store(DRAFT_KEY, null);
    var code = load(CODE_KEY);
    if (code && !$('partner_code').value) $('partner_code').value = code;
    otherWrap.hidden = intentSelect.value !== 'other';
    $('draft-note').hidden = !restored;
  }

  function clearErrors() {
    document.querySelectorAll('.field-error').forEach(function (el) { el.hidden = true; el.textContent = ''; });
    document.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
  }

  function showErrors(errors) {
    var first = null;
    Object.keys(errors).forEach(function (field) {
      var input = $(field), err = $('err-' + field);
      if (!input || !err) return;
      input.setAttribute('aria-invalid', 'true');
      err.textContent = errors[field];
      err.hidden = false;
      if (!first) first = input;
    });
    if (first) first.focus();
  }

  var STAGES = [
    [0, 'Checking your partner code…'],
    [3000, 'Our assistants are reviewing the referral…'],
    [9000, 'Notifying our team and preparing your confirmation…'],
    [20000, 'Still working. Please keep this page open…']
  ];
  var stageTimers = [];
  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'Sending…' : 'Send referral';
    sending.hidden = !busy;
    stageTimers.forEach(clearTimeout); stageTimers = [];
    if (busy) STAGES.forEach(function (s) { stageTimers.push(setTimeout(function () { sendingText.textContent = s[1]; }, s[0])); });
  }

  function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str == null ? '' : String(str); return d.innerHTML; }

  function showPanel(html, focusSelector) {
    formCard.hidden = true;
    resultArea.innerHTML = html;
    var h = resultArea.querySelector(focusSelector || 'h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderSuccess(outcome, data) {
    var t = tierInfo(outcome.tier);
    showPanel(
      '<div class="status-panel success fade-in">' +
        '<div class="status-icon" aria-hidden="true">✓</div>' +
        '<h2>Referral sent. Thank you!</h2>' +
        '<p>We received your referral for <strong>' + escapeHtml(outcome.prospect || data.prospect_name) + '</strong>.</p>' +
        '<span class="tier-badge ' + t.cls + '" data-tier="' + escapeHtml(outcome.tier) + '">' + t.label + '</span>' +
        '<p class="tier-note">' + t.note + '</p>' +
        '<ul class="next-steps">' +
          '<li>You will get a confirmation email.</li>' +
          '<li>Your client will get a welcome email from our team.</li>' +
        '</ul>' +
      '</div>' +
      '<button class="secondary" id="reset-btn" type="button">Send another referral</button>'
    );
    $('reset-btn').addEventListener('click', resetForm);
  }

  function renderError(kind, detail) {
    var copy = {
      network: ["We couldn't reach our server", 'Check your internet connection and try again. Your details are still in the form.'],
      timeout: ['This is taking longer than usual', 'Your referral may still have gone through. Wait a minute and check for a confirmation email before sending it again.'],
      missing_field: ['Some details were missing', 'Our system needs every field. Go back, check the form and send it again.'],
      server: ['Something went wrong on our side', "The referral didn't go through. Your details are still in the form, so you can try again in a moment."]
    }[kind] || ['Something went wrong', 'Please try again.'];
    showPanel(
      '<div class="status-panel error fade-in">' +
        '<div class="status-icon" aria-hidden="true">!</div>' +
        '<h2>' + copy[0] + '</h2>' +
        '<p>' + copy[1] + '</p>' +
        (detail ? '<details class="tech-detail"><summary>Technical details</summary><code>' + escapeHtml(detail) + '</code></details>' : '') +
      '</div>' +
      '<button class="secondary" id="retry-btn" type="button">Back to the form</button>'
    );
    $('retry-btn').addEventListener('click', function () { resultArea.innerHTML = ''; formCard.hidden = false; submitBtn.focus(); });
  }

  function resetForm() {
    var code = $('partner_code').value;
    form.reset();
    $('partner_code').value = code; // partners send many referrals; keep their code
    otherWrap.hidden = true;
    $('draft-note').hidden = true;
    clearErrors();
    resultArea.innerHTML = '';
    formCard.hidden = false;
    $('prospect_name').focus();
  }

  intentSelect.addEventListener('change', function () {
    otherWrap.hidden = intentSelect.value !== 'other';
    if (!otherWrap.hidden) otherInput.focus();
  });
  form.addEventListener('input', saveDraft);
  $('discard-draft').addEventListener('click', function () {
    store(DRAFT_KEY, null);
    var code = $('partner_code').value;
    form.reset(); $('partner_code').value = code;
    otherWrap.hidden = true; $('draft-note').hidden = true; clearErrors();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();
    if ($('website').value) { renderSuccess({ prospect: '', tier: 'standard' }, { prospect_name: 'your client' }); return; } // honeypot: bots fill hidden fields

    var choseOther = intentSelect.value === 'other';
    var data = normalize(readForm());
    var errors = validate(data, choseOther);
    if (Object.keys(errors).length) { showErrors(errors); return; }
    $('partner_code').value = data.partner_code;

    setBusy(true);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, config.timeoutMs);

    fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        try { payload = JSON.parse(text); } catch (_) {}
        if (payload === null) return renderError('server', 'Response was not JSON (HTTP ' + res.status + ').');
        var outcome = interpretResponse(res.status, payload);
        if (outcome.kind === 'success') {
          store(DRAFT_KEY, null);
          store(CODE_KEY, data.partner_code);
          renderSuccess(outcome, data);
        } else if (outcome.kind === 'unknown_partner') {
          showErrors({ partner_code: "We don't recognize this partner code. Check it against your welcome email, or contact us." });
        } else {
          renderError(outcome.kind, outcome.detail);
        }
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') renderError('timeout', 'No response after ' + Math.round(config.timeoutMs / 1000) + ' seconds.');
      else renderError('network', err && err.message);
    }).then(function () { clearTimeout(timer); setBusy(false); });
  });

  if (!config.webhookUrl) {
    submitBtn.disabled = true;
    $('config-warning').hidden = false;
  }
  restoreDraft();
})(typeof window !== 'undefined' ? window : globalThis);
