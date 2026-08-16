/* ============================================================================
 * Lead Tracker · pixel de 1ª parte (Fase 5)
 * ----------------------------------------------------------------------------
 * Cole na landing:
 *   <script src="https://SEU-CRM/ah-tracker.js"
 *           data-endpoint="https://<ref>.supabase.co/functions/v1/ingest-lead"
 *           data-auto></script>
 *
 * - Captura UTMs + fbclid/gclid + short_code (utm_ref do redirecionador) no
 *   primeiro load.
 * - Persiste em cookie 1ª-parte: first-touch IMUTÁVEL + last-touch, 90 dias.
 * - `data-auto`: liga automaticamente os forms marcados com [data-ah-form].
 *   No submit, POSTa lead + contexto de tracking ao endpoint de ingestão.
 *
 * API: window.LeadTracker.{ capture, getContext, submit, bindForm }.
 * ==========================================================================*/
(function () {
  'use strict';
  var FIRST = '_ah_first';
  var LAST = '_ah_last';
  var MAX_AGE = 90 * 24 * 60 * 60; // 90 dias (segundos)
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  var scriptEl = document.currentScript;
  var ENDPOINT = (scriptEl && scriptEl.getAttribute('data-endpoint')) || '';
  var AUTO = scriptEl && scriptEl.hasAttribute('data-auto');

  function setCookie(name, value, maxAge) {
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie =
      name + '=' + encodeURIComponent(value) + '; Max-Age=' + maxAge +
      '; Path=/; SameSite=Lax' + secure;
  }
  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[2])); } catch (e) { return null; }
  }

  // Lê UTMs + clickIDs + short_code da URL atual.
  function readUrl() {
    var q = new URLSearchParams(location.search);
    var data = {};
    UTM_KEYS.forEach(function (k) { if (q.get(k)) data[k] = q.get(k); });
    if (q.get('fbclid')) data.fbclid = q.get('fbclid');
    if (q.get('gclid')) data.gclid = q.get('gclid');
    // utm_ref é o short_code que o redirecionador anexa na landing.
    var code = q.get('utm_ref') || q.get('ah_ref') || q.get('short_code');
    if (code) data.short_code = code;
    return data;
  }

  // Captura no load: grava first-touch (só se ausente) e last-touch (sempre que
  // houver sinal novo na URL).
  function capture() {
    var url = readUrl();
    var hasSignal = Object.keys(url).length > 0;
    url.landing = location.href;

    if (!getCookie(FIRST)) {
      setCookie(FIRST, JSON.stringify(url), MAX_AGE);
    }
    if (hasSignal) {
      setCookie(LAST, JSON.stringify(url), MAX_AGE);
    }
    return url;
  }

  // Contexto para o submit: last-touch (ou first se não houver last) + first
  // como fallback de campos ausentes.
  function getContext() {
    var first = getCookie(FIRST) || {};
    var last = getCookie(LAST) || {};
    var ctx = {};
    UTM_KEYS.concat(['fbclid', 'gclid', 'short_code']).forEach(function (k) {
      if (last[k] != null) ctx[k] = last[k];
      else if (first[k] != null) ctx[k] = first[k];
    });
    ctx.page_url = location.href;
    ctx.raw_query = Object.assign({}, first, last);
    return ctx;
  }

  function pick(form, names) {
    for (var i = 0; i < names.length; i++) {
      var el =
        form.querySelector('[data-ah-field="' + names[i] + '"]') ||
        form.querySelector('[name="' + names[i] + '"]');
      if (el && el.value && el.value.trim()) return el.value.trim();
    }
    return null;
  }

  // Envia lead + tracking ao endpoint de ingestão.
  function submit(lead) {
    if (!ENDPOINT) return Promise.reject(new Error('data-endpoint ausente'));
    var payload = Object.assign({}, getContext(), lead || {});
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  // Liga um form: no submit coleta name/phone/email e dispara submit().
  function bindForm(form) {
    if (!form || form.__ahBound) return;
    form.__ahBound = true;
    form.addEventListener('submit', function () {
      var lead = {
        name: pick(form, ['name', 'nome', 'full_name']),
        phone: pick(form, ['phone', 'telefone', 'whatsapp', 'tel']),
        email: pick(form, ['email', 'e-mail']),
      };
      // Fire-and-forget: não bloqueia o submit nativo do form.
      try { submit(lead); } catch (e) { /* noop */ }
    }, { capture: true });
  }

  capture();
  if (AUTO) {
    var bind = function () {
      var forms = document.querySelectorAll('form[data-ah-form]');
      for (var i = 0; i < forms.length; i++) bindForm(forms[i]);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  }

  window.LeadTracker = {
    capture: capture,
    getContext: getContext,
    submit: submit,
    bindForm: bindForm,
  };
})();
