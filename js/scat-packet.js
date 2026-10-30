/* WRI SCAT (offline) — the Endpoint Review packet: what a reviewer needs to know about each segment
 * of the incident, pulled down from the SCAT Ops API (scat_packet) and kept on the phone.
 *
 * Per segment: the active treatment recommendation (STR), the survey it was written from, the latest
 * survey if different, recent endpoint reviews, the latest recon stop; each with its child rows and
 * photo file ids. Plus the segment statuses and the endpoint criteria (with their version).
 *
 * The packet is small (text only), so the whole incident is cached in IndexedDB (kv packet_<incident>).
 * A sync sends `since` = the last fetched_at: the API answers with only the segments that changed, whole,
 * plus tombstones for rows that left `active`. Thumbnails are fetched one at a time, only when a screen
 * shows them (scat_thumb), and kept per file id (kv thumb_<id>) so a segment opened once works offline.
 *
 * Needs the SCAT PIN (the same scoped PIN the outbox uses) and signal. Nothing here writes to the server.
 */
(function (g) {
  var SCOPE = 'scat', STALE_MS = 2 * 60000;
  var cur = null, curInc = '', syncing = null, lastSync = 0, lastErr = null;

  function key(inc) { return 'packet_' + inc; }
  function emit() { try { g.dispatchEvent(new Event('packet:changed')); } catch (e) {} }
  function pin() { return Outbox.scopedPinFor(SCOPE); }

  function load(inc) {
    inc = String(inc || '');
    if (cur && curInc === inc) return Promise.resolve(cur);
    return Store.kvGet(key(inc)).then(function (p) { cur = p || null; curInc = inc; return cur; });
  }

  function sync(inc, full) {
    inc = String(inc || '');
    if (!inc) return Promise.reject(Object.assign(new Error('Pick the incident first.'), { code: 'incident_unknown' }));
    if (!CONFIG.SCAT_API) return Promise.reject(Object.assign(new Error('The SCAT API is switched off here.'), { code: 'no_api' }));
    if (syncing) return syncing;
    lastErr = null;
    syncing = Promise.all([load(inc), pin(), Store.deviceId()]).then(function (a) {
      var prev = a[0], p = a[1], device = a[2];
      if (!p) throw Object.assign(new Error('Enter the SCAT PIN to pull the segment packet.'), { code: 'pin_missing' });
      var payload = { pin: p, device: device, incident_id: inc };
      if (prev && prev.fetched_at && !full) payload.since = prev.fetched_at;
      return Api.post('scat_packet', payload, 60000, CONFIG.SCAT_API).then(function (d) { return merge(inc, prev, d); });
    }).then(function (p) { lastSync = Date.now(); syncing = null; emit(); return p; },
            function (e) { syncing = null; lastErr = e; emit(); throw e; });
    return syncing;
  }

  function merge(inc, prev, d) {
    var whole = !!d.full || !prev;
    var p = whole ? { incident_id: inc, segments: {}, status: {} } : prev;
    p.fetched_at = d.fetched_at || p.fetched_at;
    p.criteria = d.criteria || []; p.criteria_version = d.criteria_version || ''; p.criteria_warnings = d.criteria_warnings || [];
    (d.segments || []).forEach(function (s) { p.segments[s.segment_id] = s; });   // a changed segment comes back whole
    p.status = {}; (d.segment_status || []).forEach(function (s) { p.status[s.segment_id] = s; });   // statuses always come whole
    (d.tombstones || []).forEach(function (t) { dropUuid(p, t.uuid); });
    p.synced_at = Date.now();
    cur = p; curInc = inc;
    return Store.kvSet(key(inc), p).then(function () { return p; });
  }

  /** A row that left `active`: belt and braces, since its segment is re-sent whole anyway. */
  function dropUuid(p, uuid) {
    Object.keys(p.segments).forEach(function (id) {
      var s = p.segments[id];
      if (s.str && s.str.uuid === uuid) s.str = null;
      s.reviews = (s.reviews || []).filter(function (r) { return r.uuid !== uuid; });
      ['basis_survey', 'latest_survey'].forEach(function (k) {
        var r = s[k]; if (!r) return;
        if (r.uuid === uuid) { s[k] = null; return; }
        if (r.children) Object.keys(r.children).forEach(function (t) { r.children[t] = r.children[t].filter(function (c) { return c.uuid !== uuid; }); });
      });
    });
  }

  /** {mime, base64} for one photo, from the phone's cache or the API. */
  function thumb(fileId) {
    var k = 'thumb_' + fileId;
    return Store.kvGet(k).then(function (t) {
      if (t) return t;
      if (!navigator.onLine) throw Object.assign(new Error('No signal'), { offline: true });
      return Promise.all([pin(), Store.deviceId()]).then(function (a) {
        if (!a[0]) throw Object.assign(new Error('No SCAT PIN'), { code: 'pin_missing' });
        return Api.post('scat_thumb', { pin: a[0], device: a[1], file_id: fileId }, 45000, CONFIG.SCAT_API);
      }).then(function (t2) {
        var small = { mime: t2.mime || 'image/jpeg', base64: t2.base64 };
        return Store.kvSet(k, small).then(function () { return small; });
      });
    });
  }

  g.ScatPacket = {
    load: load, sync: sync, thumb: thumb,
    current: function () { return cur; },
    segment: function (id) { return (cur && cur.segments && cur.segments[id]) || null; },
    segmentIds: function () { return cur && cur.segments ? Object.keys(cur.segments) : []; },
    /** Segments a reviewer can be sent to: those with a survey or a treatment recommendation (a recon stop alone is not enough). */
    reviewableIds: function () { return (cur && cur.segments ? Object.keys(cur.segments) : []).filter(function (id) { var s = cur.segments[id]; return !!(s.str || s.basis_survey || s.latest_survey); }); },
    status: function (id) { return (cur && cur.status && cur.status[id]) || null; },
    isSyncing: function () { return !!syncing; },
    lastError: function () { return lastErr; },
    /** Load the cached packet; refresh it when online, PIN present and the copy is older than two minutes. */
    ensure: function (inc) {
      return load(inc).then(function (p) {
        var stale = !p || Date.now() - (p.synced_at || 0) > STALE_MS;
        if (navigator.onLine && stale && Date.now() - lastSync > STALE_MS) return sync(inc).catch(function () { return p; });
        return p;
      });
    }
  };
})(self);
