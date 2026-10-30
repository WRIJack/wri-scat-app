/* WRI SCAT (offline) — the shell around scat-ui.js: incident picker, saved list, upload triggers,
 * small helpers. This is the SCAT app's own page; nothing here is shared with WRI Field Forms at
 * runtime (store.js / api.js / outbox.js are copies of that app's files, kept identical).
 *
 * Records are saved on the phone first (IndexedDB) and the outbox uploads them whenever there's
 * signal: on open, when the phone comes back online, when the app is brought to the front, and every
 * 30 s while it's open (iOS has no background upload; Android also uploads in the background via
 * Background Sync).
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var S = { cfg: null, incident: null };

  // ---------- helpers scat-ui.js expects on WRIApp ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, ms) { var t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 3500); }
  function busy(btn, on, label) {   // WRI rule: every button shows it's working until the work answers
    if (on) { btn._label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>' + esc(label || 'Working…'); }
    else { btn.disabled = false; if (btn._label != null) btn.innerHTML = btn._label; }
  }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 's-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }
  function localNow() { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function downscale(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, CONFIG.PHOTO_EDGE / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? res(b) : rej(new Error('Could not read the photo')); }, 'image/jpeg', CONFIG.PHOTO_QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read the photo')); };
      img.src = url;
    });
  }
  function recordTitle(r) {
    var f = r.fields || {};
    if (f.record_type === 'scat_survey') return 'SCAT survey: ' + (f.segment_id || 'no segment') + (f.zones ? ' · ' + f.zones.length + ' zone(s)' : '');
    if (f.record_type === 'endpoint_review') return 'Endpoint review: ' + (f.segment_id || 'no segment') + ' · ' + ({ met: 'meets endpoint', not_met: 'does not meet', another_look: 'needs another look' }[f.decision] || f.decision || '');
    return 'SCAT recon: ' + (f.segment_id || 'no segment') + (f.priority ? ' · ' + f.priority + ' priority' : '');
  }

  // ---------- incidents (from the Recon config, cached on the phone) ----------
  function loadConfig() {
    return Store.kvGet('config').then(function (cached) {
      if (cached) applyConfig(cached);
      return Api.getConfig().then(function (fresh) {
        if (!cached || fresh.version !== cached.version || JSON.stringify(fresh.incidents) !== JSON.stringify(cached.incidents)) {
          return Store.kvSet('config', fresh).then(function () { applyConfig(fresh); });
        }
      }).catch(function () {
        if (!cached) $('incidentHint').textContent = 'Open once with signal to load the incident list.';
      });
    });
  }
  function applyConfig(cfg) { S.cfg = cfg; buildIncidents(); }
  function wantedIncident() {
    var m = /[?&]incident=([^&#]+)/.exec(location.search);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
    try {   // the phone's choice from the Field App incident gate (same origin on the portal)
      var c = JSON.parse(lsGet('wri_incident_choice') || 'null');
      if (c && c.id && c.expires > Date.now()) return String(c.id);
    } catch (e) {}
    return lsGet('wri_scat_incident') || '';
  }
  function buildIncidents() {
    var list = (S.cfg && S.cfg.incidents) || [], sel = $('incidentSel');
    var want = String(wantedIncident()).toLowerCase(), cur = S.incident && S.incident.incident_id;
    sel.innerHTML = '';
    if (!list.length) {
      sel.innerHTML = '<option value="">No open incident</option>';
      $('incidentHint').textContent = 'No incident is open. Records can only be saved to an open incident.';
      S.incident = null; return;
    }
    list.forEach(function (r) {
      var o = document.createElement('option'); o.value = r.incident_id;
      o.textContent = r.project_key + ' · ' + r.client_name + (r.is_primary && list.length > 1 ? ' (primary)' : '');
      sel.appendChild(o);
    });
    var pick = list.filter(function (r) { return cur && r.incident_id === cur; })[0]
      || list.filter(function (r) { return want && (r.incident_id.toLowerCase() === want || r.project_key.toLowerCase() === want); })[0]
      || list.filter(function (r) { return r.is_primary; })[0] || list[0];
    sel.value = pick.incident_id; setIncident(pick);
  }
  function setIncident(r) {
    S.incident = r ? { incident_id: r.incident_id, project_key: r.project_key, client_name: r.client_name, incident_name: r.incident_name || r.project_key } : null;
    window.dispatchEvent(new Event('incident:changed'));
    if (r) lsSet('wri_scat_incident', r.incident_id);
    $('incidentHint').textContent = r ? 'Files to ' + r.project_key + ' (' + r.client_name + ').' : '';
  }

  // ---------- saved list + banner ----------
  function refreshStatus() {
    return Outbox.summary().then(function (s) {
      var waiting = s.queued, bn = $('banner');
      $('savedCount').textContent = (waiting + s.needs_pin_scoped + s.failed) ? '(' + (waiting + s.needs_pin_scoped + s.failed) + ')' : '';
      bn.className = 'banner';
      if (s.needs_pin_scoped) { bn.classList.add('red'); bn.textContent = s.needs_pin_scoped + ' saved record(s) waiting for the SCAT PIN — enter it below'; bn.dataset.act = 'pin'; }
      else if (s.failed) { bn.classList.add('red'); bn.textContent = s.failed + ' saved record(s) need attention — tap to see'; bn.dataset.act = 'list'; }
      else if (waiting) {
        bn.classList.add('amber');
        bn.textContent = waiting + ' saved record(s)' + (s.photos_waiting ? ', ' + s.photos_waiting + ' photo(s)' : '') + ' waiting to upload' + (navigator.onLine ? ' — uploading…' : ' — no signal. Open this app when you’re back in coverage.');
        bn.dataset.act = 'list';
      } else { bn.classList.add('hidden'); }
      if (!$('savedOverlay').classList.contains('hidden')) renderSaved();
    });
  }
  function renderSaved() {
    Outbox.list().then(function (rs) {
      $('savedHint').textContent = rs.length ? 'Records stay here for a day after they upload.' : 'Nothing saved on this phone.';
      $('savedList').innerHTML = rs.map(function (r) {
        var sent = r.photos.filter(function (p) { return p.status === 'sent'; }).length, st, cls;
        if (r.status === 'sent') { cls = 'green'; st = 'Uploaded' + (r.photos_failed ? ' — ' + r.photos_failed + ' photo(s) could not upload' : ''); }
        else if (r.status === 'needs_pin') { cls = 'red'; st = 'Waiting for the SCAT PIN'; }
        else if (r.status === 'failed') { cls = 'red'; st = r.last_error || 'Could not upload'; }
        else {
          cls = 'amber';
          var wait = (r.next_try || 0) - Date.now();
          st = (r.submitted ? 'Record uploaded · ' + sent + ' of ' + r.photo_count + ' photo' + (r.photo_count === 1 ? '' : 's') + ' sent' : 'Waiting to upload') +
            (r.last_error ? ' · last try: ' + r.last_error : '') +
            (wait > 5000 ? ' · next try in ' + (wait > 90000 ? Math.round(wait / 60000) + ' min' : Math.round(wait / 1000) + ' s') + ' (or tap Retry now)' : '');
        }
        var acts = '';
        if (r.status !== 'sent') acts += '<button class="link" data-act="retry" data-id="' + r.recon_id + '">Retry now</button>';
        if (r.status === 'failed' && r.error_code === 'incident_unknown') acts += '<button class="link" data-act="reinc" data-id="' + r.recon_id + '">File to the selected incident</button>';
        if (r.status === 'sent' && r.photos_failed) acts += '<button class="link" data-act="retry" data-id="' + r.recon_id + '">Retry photos</button>';
        acts += '<button class="link" data-act="discard" data-id="' + r.recon_id + '">Discard</button>';
        return '<div class="item"><div class="t">' + esc(recordTitle(r)) + ' · ' + esc(r.incident ? r.incident.project_key : '') + '</div>' +
          '<div>' + new Date(r.created_at).toLocaleString() + (r.photo_count ? ' · ' + r.photo_count + ' photo(s)' : '') + '</div>' +
          '<div class="s ' + cls + '">' + esc(st) + '</div><div class="acts">' + acts + '</div></div>';
      }).join('');
    });
  }
  function savedAction(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var id = b.dataset.id, act = b.dataset.act;
    if (act === 'discard') {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to discard — it is NOT uploaded'; setTimeout(function () { b.dataset.armed = ''; b.textContent = 'Discard'; }, 4000); return; }
      Outbox.discard(id).then(renderSaved);
    } else if (act === 'retry') { busy(b, true, 'Sending…'); Outbox.retry(id).then(function () { renderSaved(); }); }
    else if (act === 'reinc') {
      if (!S.incident) { toast('Pick an incident at the top first.'); return; }
      busy(b, true, 'Sending…'); Outbox.retry(id, S.incident).then(renderSaved);
    }
  }

  // ---------- upload triggers ----------
  function kick() { if (navigator.onLine) Outbox.drain().then(refreshStatus); else refreshStatus(); }
  function wakeKick() { if (navigator.onLine) Outbox.wake().then(kick); else refreshStatus(); }
  var hiddenAt = 0;

  // ---------- boot ----------
  function boot() {
    $('incidentSel').addEventListener('change', function () {
      var r = ((S.cfg && S.cfg.incidents) || []).filter(function (x) { return x.incident_id === $('incidentSel').value; })[0]; setIncident(r);
    });
    $('savedBtn').addEventListener('click', function () { $('savedOverlay').classList.remove('hidden'); renderSaved(); });
    $('savedClose').addEventListener('click', function () { $('savedOverlay').classList.add('hidden'); });
    $('savedList').addEventListener('click', savedAction);
    $('sendNowBtn').addEventListener('click', function () {
      var b = this; busy(b, true, 'Uploading…');
      Store.all('records').then(function (rs) {
        return Promise.all(rs.filter(function (r) { return r.status === 'queued'; }).map(function (r) { r.next_try = 0; return Store.put('records', r); }));
      }).then(function () { return Outbox.drain(); }).then(function () { busy(b, false); renderSaved(); refreshStatus(); });
    });
    $('banner').addEventListener('click', function () {
      if (this.dataset.act === 'pin') { var p = $('scPinInput'); if (p) { window.scrollTo(0, 0); p.focus(); } }
      else { $('savedOverlay').classList.remove('hidden'); renderSaved(); }
    });

    // iOS: storage is only protected once the app is on the Home Screen
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (ios && !standalone && !lsGet('wri_scat_a2hs')) $('a2hsCard').classList.remove('hidden');
    $('a2hsDismiss').addEventListener('click', function () { lsSet('wri_scat_a2hs', '1'); $('a2hsCard').classList.add('hidden'); });
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

    window.addEventListener('outbox:changed', refreshStatus);
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'outbox:changed') refreshStatus(); });
    window.addEventListener('online', wakeKick);
    window.addEventListener('offline', refreshStatus);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 60000) wakeKick(); else kick();
    });
    window.addEventListener('focus', kick);
    setInterval(function () { if (document.visibilityState === 'visible') kick(); }, 30000);

    loadConfig().then(function () { setTimeout(wakeKick, 800); });
    refreshStatus();
  }

  window.WRIApp = { S: S, $: $, esc: esc, toast: toast, busy: busy, uuid: uuid, localNow: localNow, lsGet: lsGet, lsSet: lsSet, downscale: downscale,
    refreshStatus: function () { return refreshStatus(); }, kick: function () { kick(); }, recordTitle: recordTitle };
  document.addEventListener('DOMContentLoaded', boot);
})();
