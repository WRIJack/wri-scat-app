/* Copied unchanged from Whitewaterrescue/wri-recon (branch jack/scat-recon-tab, f84d741) on 2026-10-29. Keep in sync; do not edit here. */
/* WRI Recon (offline) — transport to the Recon Apps Script JSON API (Api.gs).
 *
 * POST is text/plain JSON (a CORS "simple request": GAS can't answer OPTIONS);
 * GAS 302s to googleusercontent, which the browser follows. Every reply is HTTP
 * 200 {ok,data} or {ok:false,error,message,permanent}. Anything that isn't JSON
 * (the GAS overload page, a captive portal) is treated as transient.
 *
 * Errors thrown: Error with .code, .permanent (never retry as is) and .offline.
 */
(function (g) {
  function fail(code, message, permanent, offline) {
    var e = new Error(message || code);
    e.code = code; e.permanent = !!permanent; e.offline = !!offline;
    return e;
  }

  function call(url, opts, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl) { opts.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000); }
    return fetch(url, opts).then(function (r) { return r.text(); }, function (e) {
      if (timer) clearTimeout(timer);
      var timedOut = e && e.name === 'AbortError';
      throw fail(timedOut ? 'timeout' : 'network', timedOut ? 'Upload timed out' : 'No connection', false, !timedOut);
    }).then(function (text) {
      if (timer) clearTimeout(timer);
      var t = String(text || '').replace(/^﻿/, '').trim();
      var j = null;
      if (t.charAt(0) === '{') { try { j = JSON.parse(t); } catch (e) {} }
      if (!j) throw fail('server_error', 'Server busy — will retry');
      if (j.ok) return j.data;
      throw fail(j.error || 'server_error', j.message, j.permanent);
    });
  }

  g.Api = {
    getConfig: function () {
      return call(CONFIG.API_URL + '?api=config', { method: 'GET', redirect: 'follow' }, 30000);
    },
    // url: another app's API (each form posts to the Apps Script that owns its data); default = Recon
    post: function (action, payload, timeoutMs, url) {
      return call(url || CONFIG.API_URL, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, payload: payload })
      }, timeoutMs || 45000);
    }
  };
})(self);
