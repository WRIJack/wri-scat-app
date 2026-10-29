/* Copied unchanged from Whitewaterrescue/wri-recon (branch jack/scat-recon-tab, f84d741) on 2026-10-29. Keep in sync; do not edit here. */
/* WRI Recon (offline) — the outbox. Runs in the page and in the service worker.
 *
 * A saved point is a `records` row plus one `photos` row per photo. The drain
 * sends the point (submit), then each photo on its own request (photo), so a
 * weak signal only has to carry one ~0.5 MB photo at a time and a failure only
 * costs that photo. Both calls are idempotent on the server (recon_id,
 * recon_id+idx), so a replay after a lost reply never duplicates anything.
 *
 * Record status:  queued -> sent            (all photos sent or given up)
 *                 queued -> needs_pin       (PIN wrong/changed; new PIN re-queues)
 *                 queued -> failed          (permanent: e.g. incident closed; user fixes or discards)
 * A transient failure (no signal, timeout, server busy) leaves the record queued
 * with a backoff, and the drain moves on to the next record: one stuck point
 * never blocks the others.
 */
(function (g) {
  var BACKOFF_MIN = 20000, BACKOFF_MAX = 10 * 60000, KEEP_SENT_MS = 24 * 3600000;
  var running = false, lastCreated = 0;

  function emit() {
    try {
      if (g.document) g.dispatchEvent(new Event('outbox:changed'));
      else if (g.clients) g.clients.matchAll().then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'outbox:changed' }); }); });
    } catch (e) {}
  }

  function backoff(n) { return Math.min(BACKOFF_MAX, BACKOFF_MIN * Math.pow(2, Math.max(0, n - 1))); }

  function blobToBase64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), bin = '', CH = 0x8000;
      for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(bin);
    });
  }

  // ~8 KB/s floor (one bar of cell signal), 90 s minimum, 5 min cap -- a photo that times out
  // on a weak signal is re-sent whole, so a too-short timeout never finishes
  function uploadTimeout(bytes) { return Math.min(300000, Math.max(90000, Math.round(bytes / 8))); }

  var Outbox = {
    /** Save a point + its photo Blobs. record: {recon_id, incident, fields}; photos: [{blob, name}] */
    enqueue: function (record, photos) {
      // strictly increasing, so steps saved in the same millisecond still upload in order
      record.created_at = lastCreated = Math.max(Date.now(), lastCreated + 1);
      record.status = 'queued';
      record.attempts = 0; record.next_try = 0;
      record.photo_count = photos.length;
      var puts = photos.map(function (p, i) {
        return Store.put('photos', { key: record.recon_id + '/' + i, recon_id: record.recon_id, idx: i, name: p.name || '',
                                     blob: p.blob, size: p.blob.size, status: 'queued', meta: p.meta || '' });
      });
      return Promise.all(puts).then(function () { return Store.put('records', record); })
        .then(function () { emit(); setTimeout(Outbox.drain, 50); });
    },

    /** Send everything that's due. Safe to call often; only one drain runs at a time. */
    drain: function () {
      if (g.navigator && g.navigator.locks) {
        return g.navigator.locks.request('wri-recon-drain', { ifAvailable: true }, function (lock) {
          return lock ? drainOnce() : null;
        });
      }
      return drainOnce();
    },

    summary: function () {
      return Promise.all([Store.all('records'), Store.all('photos')]).then(function (a) {
        var recs = a[0] || [], photos = a[1] || [];
        var s = { queued: 0, needs_pin: 0, needs_pin_scoped: 0, failed: 0, sent: 0, photos_waiting: 0, photos_failed: 0 };
        // a kind with its own PIN (pin_scope) is counted apart: its tab asks for that PIN, not the incident banner
        recs.forEach(function (r) { var k = r.status === 'needs_pin' && scopeOf(r) ? 'needs_pin_scoped' : r.status; s[k] = (s[k] || 0) + 1; });
        var open = {}; recs.forEach(function (r) { if (r.status !== 'sent') open[r.recon_id] = 1; });
        photos.forEach(function (p) {
          if (p.status === 'queued' && open[p.recon_id]) s.photos_waiting++;
          if (p.status === 'failed') s.photos_failed++;
        });
        return s;
      });
    },

    list: function () {
      return Promise.all([Store.all('records'), Store.all('photos')]).then(function (a) {
        var by = {};
        (a[1] || []).forEach(function (p) { (by[p.recon_id] = by[p.recon_id] || []).push(p); });
        return (a[0] || []).sort(function (x, y) { return y.created_at - x.created_at; }).map(function (r) {
          var ps = (by[r.recon_id] || []).sort(function (x, y) { return x.idx - y.idx; });
          r.photos = ps.map(function (p) { return { idx: p.idx, status: p.status, error: p.last_error || '', blob: p.blob || null }; });
          return r;
        });
      });
    },

    /** Signal is back / the app was reopened: everything still queued tries again now instead of
     *  waiting out its backoff (a weak-signal timeout must not park a photo for 10 min). */
    wake: function () {
      return Store.all('records').then(function (rs) {
        return Promise.all((rs || []).filter(function (r) { return r.status === 'queued' && (r.next_try || 0) > Date.now(); })
          .map(function (r) { r.next_try = 0; return Store.put('records', r); }));
      });
    },

    /** Re-queue a record (and its failed photos) now. Optional new incident for an incident_unknown failure. */
    retry: function (reconId, newIncident) {
      return Store.get('records', reconId).then(function (r) {
        if (!r) return;
        if (newIncident) r.incident = newIncident;
        r.status = 'queued'; r.attempts = 0; r.next_try = 0; r.last_error = ''; r.error_code = '';
        return Store.photosFor(reconId).then(function (ps) {
          return Promise.all(ps.filter(function (p) { return p.status === 'failed' && p.blob; }).map(function (p) {
            p.status = 'queued'; p.last_error = ''; p.attempts = 0; return Store.put('photos', p);
          }));
        }).then(function () { return Store.put('records', r); });
      }).then(function () { emit(); return Outbox.drain(); });
    },

    discard: function (reconId) {
      return Store.photosFor(reconId).then(function (ps) {
        return Promise.all(ps.map(function (p) { return Store.del('photos', p.key); }));
      }).then(function () { return Store.del('records', reconId); }).then(emit);
    },

    /** New PIN for an incident (each open incident has its own Gateway PIN): that
     *  incident's needs_pin records go back in the queue. No incident = the old
     *  single PIN, used for any incident without its own. */
    setPin: function (pin, incidentId) {
      pin = String(pin || '').trim();
      var save = incidentId
        ? Store.kvGet('pins').then(function (m) { m = m || {}; m[String(incidentId)] = pin; return Store.kvSet('pins', m); })
        : Store.kvSet('pin', pin);
      return save.then(function () { return Store.all('records'); }).then(function (rs) {
        return Promise.all((rs || []).filter(function (r) {
          return r.status === 'needs_pin' && !scopeOf(r) && (!incidentId || recInc(r) === String(incidentId));
        }).map(function (r) {
          r.status = 'queued'; r.next_try = 0; return Store.put('records', r);
        }));
      }).then(function () { emit(); return Outbox.drain(); });
    },

    /** The PIN saved for an incident ('' = none yet). */
    pinFor: function (incidentId) {
      return Promise.all([Store.kvGet('pins'), Store.kvGet('pin')]).then(function (a) {
        return String(((a[0] || {})[String(incidentId || '')]) || a[1] || '');
      });
    },

    /** A kind's own PIN (FORM_KINDS[kind].pin_scope): save it and re-queue that scope's parked records. */
    setScopedPin: function (scope, pin) {
      pin = String(pin || '').trim();
      return Store.kvGet('pins_scoped').then(function (m) { m = m || {}; m[scope] = pin; return Store.kvSet('pins_scoped', m); })
        .then(function () { return Store.all('records'); }).then(function (rs) {
          return Promise.all((rs || []).filter(function (r) { return r.status === 'needs_pin' && scopeOf(r) === scope; })
            .map(function (r) { r.status = 'queued'; r.next_try = 0; r.last_error = ''; return Store.put('records', r); }));
        }).then(function () { emit(); return Outbox.drain(); });
    },
    scopedPinFor: function (scope) { return Store.kvGet('pins_scoped').then(function (m) { return String((m || {})[scope] || ''); }); },
    /** Records of a scoped kind waiting for that kind's PIN. */
    needsScopedPin: function (scope) {
      return Store.all('records').then(function (rs) { return (rs || []).filter(function (r) { return r.status === 'needs_pin' && scopeOf(r) === scope; }).length; });
    },

    /** The incident of the first record waiting for a PIN (the banner asks for that one). */
    needsPinIncident: function () {
      return Store.all('records').then(function (rs) {
        var r = (rs || []).filter(function (x) { return x.status === 'needs_pin' && !scopeOf(x); })[0];
        return r ? (r.incident || null) : null;
      });
    },

    prune: function () {
      var cut = Date.now() - KEEP_SENT_MS;
      return Store.all('records').then(function (rs) {
        return Promise.all((rs || []).filter(function (r) { return r.status === 'sent' && (r.sent_at || 0) < cut; })
          .map(function (r) { return Outbox.discard(r.recon_id); }));
      });
    }
  };

  function recInc(r) { return String((r && r.incident && r.incident.incident_id) || ''); }
  /** FORM_KINDS[kind].pin_scope, or '' for kinds that use the incident Gateway PIN. */
  function scopeOf(r) { var k = r && r.kind && g.FORM_KINDS && g.FORM_KINDS[r.kind]; return (k && k.pin_scope) || ''; }

  function drainOnce() {
    if (running) return Promise.resolve();
    running = true;
    var pins, legacyPin, scoped, device, stop = false, badInc = {}, badScope = {};
    var pinOf = function (r) { var sc = scopeOf(r); return sc ? String(scoped[sc] || '') : String(pins[recInc(r)] || legacyPin || ''); };
    return Promise.all([Store.kvGet('pins'), Store.kvGet('pin'), Store.deviceId(), Store.all('records'), Store.kvGet('pins_scoped')]).then(function (a) {
      pins = a[0] || {}; legacyPin = a[1] || ''; device = a[2]; scoped = a[4] || {};
      var due = (a[3] || []).filter(function (r) { return r.status === 'queued'; })
        .sort(function (x, y) { return x.created_at - y.created_at; });
      if (!due.length) return;
      // nothing can go without its incident's PIN: park those where the UI asks for it
      var parked = due.filter(function (r) { return !pinOf(r); });
      due = due.filter(function (r) { return !!pinOf(r); });
      var park = Promise.all(parked.map(function (r) { r.status = 'needs_pin'; return Store.put('records', r); }));
      if (!due.length) return park;
      // A vessel trip's steps must land in order (board before disembark before return):
      // once one step of a trip fails, the rest of that trip waits for the next drain.
      var blockedTrip = {};
      var tripOf = function (r) { return r.kind === 'vessel' && r.fields ? r.fields.trip_key : ''; };
      return due.reduce(function (p, r) {
        return p.then(function () {
          if (stop || badInc[recInc(r)] || badScope[scopeOf(r)] || (r.next_try || 0) > Date.now()) { if (tripOf(r)) blockedTrip[tripOf(r)] = 1; return; }
          if (tripOf(r) && blockedTrip[tripOf(r)]) return;
          return sendRecord(r, pinOf(r), device).catch(function (e) {
            if (tripOf(r)) blockedTrip[tripOf(r)] = 1;
            if (e.code === 'pin_invalid' && scopeOf(r)) {   // wrong PIN for this KIND's own API: only that kind's records wait
              var sc = scopeOf(r); badScope[sc] = 1;
              return Store.all('records').then(function (rs) {
                return Promise.all(rs.filter(function (x) { return x.status === 'queued' && scopeOf(x) === sc; }).map(function (x) {
                  x.status = 'needs_pin'; x.last_error = e.message; return Store.put('records', x);
                }));
              });
            }
            if (e.code === 'pin_invalid') {   // wrong PIN for THIS incident: its records wait; others still go
              var inc = recInc(r); badInc[inc] = 1;
              return Store.all('records').then(function (rs) {
                return Promise.all(rs.filter(function (x) { return x.status === 'queued' && recInc(x) === inc && !scopeOf(x); }).map(function (x) {
                  x.status = 'needs_pin'; x.last_error = e.message; return Store.put('records', x);
                }));
              });
            }
            if (e.offline) {   // no signal: not this record's fault -- no backoff, stop and wait for signal
              stop = true; r.last_error = 'No signal';
            } else if (e.permanent) { r.status = 'failed'; r.error_code = e.code; r.last_error = e.message; }
            else { r.attempts = (r.attempts || 0) + 1; r.next_try = Date.now() + backoff(r.attempts); r.last_error = e.message; }
            return Store.put('records', r);
          }).then(emit);
        });
      }, park);
    }).then(function () { return Outbox.prune(); })
      .catch(function (e) { try { console.warn('drain', e); } catch (x) {} })
      .then(function () { running = false; emit(); });
  }

  /**
   * Form kinds other than recon: one POST to the API of the app that owns the data
   * ({action:'submit', payload:{pin, device, id, incident_id, ...fields}}), idempotent by id.
   * Registered by the page and the worker from js/forms.js (FORM_KINDS).
   */
  function sendSimple(r, pin, device, kind) {
    return Api.post(kind.action || 'submit', Object.assign({}, r.fields, {
      pin: pin, device: device, id: r.recon_id, incident_id: r.incident && r.incident.incident_id, queued_at: r.created_at
    }), kind.timeout || 45000, kind.url()).then(function (d) {
      r.result = d || {}; r.status = 'sent'; r.sent_at = Date.now(); r.last_error = ''; r.photos_failed = 0;
      return Store.put('records', r);
    });
  }

  /**
   * Drone photos filed onto an EXISTING recon point (Drone tab): one 'attach' per photo,
   * idempotent by file name on the server. fields: {target_recon_id, target_oid, target_label, reporter_name}
   */
  function sendAttach(r, pin, device) {
    var f = r.fields || {};
    return Store.photosFor(r.recon_id).then(function (ps) {
      return ps.reduce(function (p, ph) {
        return p.then(function () {
          if (ph.status !== 'queued' || !ph.blob) return;
          return blobToBase64(ph.blob).then(function (b64) {
            return Api.post('attach', { pin: pin, device: device, incident_id: recInc(r), target_recon_id: f.target_recon_id || '', target_oid: f.target_oid,
                                        name: ph.name, base64: b64, meta: ph.meta || '', reporter_name: f.reporter_name || '' },
                            uploadTimeout(ph.size || b64.length));
          }).then(function () {
            ph.status = 'sent'; ph.blob = null; ph.last_error = '';
            return Store.put('photos', ph).then(emit);
          }, function (e) {
            if (!e.permanent) throw e;
            ph.status = 'failed'; ph.last_error = e.message;
            return Store.put('photos', ph).then(emit);
          });
        });
      }, Promise.resolve());
    }).then(function () { return Store.photosFor(r.recon_id); }).then(function (ps) {
      r.photos_failed = ps.filter(function (p) { return p.status === 'failed'; }).length;
      r.status = 'sent'; r.sent_at = Date.now(); r.last_error = '';
      return Store.put('records', r);
    });
  }

  /**
   * Form kinds that carry photos (FORM_KINDS[kind].photo_action, e.g. SCAT): the record goes
   * first ({action, payload:{pin, device, id, incident_id, queued_at, photo_count, ...fields}}),
   * then one photo_action request per photo ({pin, device, incident_id, id, idx, name, base64,
   * meta}), both to the kind's API. Idempotent by id and id + idx, so replays are safe.
   * A photo the server refuses for good is marked failed; the record still counts as sent.
   */
  function sendKindWithPhotos(r, pin, device, kind) {
    var first = r.submitted ? Promise.resolve() : Api.post(kind.action, Object.assign({}, r.fields, {
      pin: pin, device: device, id: r.recon_id, incident_id: recInc(r), queued_at: r.created_at, photo_count: r.photo_count
    }), kind.timeout || 45000, kind.url()).then(function (d) {
      r.result = d || {}; r.submitted = true; r.last_error = '';
      return Store.put('records', r).then(emit);
    });
    return first.then(function () { return Store.photosFor(r.recon_id); }).then(function (ps) {
      return ps.reduce(function (p, ph) {
        return p.then(function () {
          if (ph.status !== 'queued' || !ph.blob) return;
          return blobToBase64(ph.blob).then(function (b64) {
            return Api.post(kind.photo_action, { pin: pin, device: device, incident_id: recInc(r), id: r.recon_id, idx: ph.idx, name: ph.name, base64: b64, meta: ph.meta || '' },
                            uploadTimeout(ph.size || b64.length), kind.url());
          }).then(function () {
            ph.status = 'sent'; ph.blob = null; ph.last_error = '';
            return Store.put('photos', ph).then(emit);
          }, function (e) {
            if (!e.permanent) throw e;   // transient / PIN: the record's handler decides
            ph.status = 'failed'; ph.last_error = e.message;
            return Store.put('photos', ph).then(emit);
          });
        });
      }, Promise.resolve());
    }).then(function () { return Store.photosFor(r.recon_id); }).then(function (ps) {
      r.photos_failed = ps.filter(function (p) { return p.status === 'failed'; }).length;
      r.status = 'sent'; r.sent_at = Date.now(); r.last_error = '';
      return Store.put('records', r);
    });
  }

  function sendRecord(r, pin, device) {
    if (r.kind === 'dattach') return sendAttach(r, pin, device);
    var kind = r.kind && r.kind !== 'recon' && g.FORM_KINDS && g.FORM_KINDS[r.kind];
    if (r.kind && r.kind !== 'recon') {
      if (!kind) return Promise.reject(Object.assign(new Error('This app version can’t send ' + r.kind + ' records — reload'), { permanent: true, code: 'bad_request' }));
      if (!kind.url()) return Promise.resolve();   // the kind's API is switched off here (e.g. SCAT dark on main, or the service worker): leave it queued, no attempt
      return kind.photo_action ? sendKindWithPhotos(r, pin, device, kind) : sendSimple(r, pin, device, kind);
    }
    var first = r.oid ? Promise.resolve() : Api.post('submit', Object.assign({}, r.fields, {
      pin: pin, device: device, recon_id: r.recon_id, incident_id: r.incident.incident_id, photo_count: r.photo_count
    })).then(function (d) {
      r.oid = d.arcgis_oid; r.project_name = d.project_name; r.last_error = '';
      return Store.put('records', r).then(emit);
    });
    return first.then(function () { return Store.photosFor(r.recon_id); }).then(function (ps) {
      return ps.reduce(function (p, ph) {
        return p.then(function () {
          if (ph.status !== 'queued' || !ph.blob) return;
          return blobToBase64(ph.blob).then(function (b64) {
            return Api.post('photo', { pin: pin, device: device, incident_id: recInc(r), recon_id: r.recon_id, idx: ph.idx, name: ph.name, base64: b64, meta: ph.meta || '' },
                            uploadTimeout(ph.size || b64.length));
          }).then(function () {
            ph.status = 'sent'; ph.blob = null; ph.last_error = '';
            return Store.put('photos', ph).then(emit);
          }, function (e) {
            if (!e.permanent) throw e;   // transient / PIN: the record's handler decides
            ph.status = 'failed'; ph.last_error = e.message;
            return Store.put('photos', ph).then(emit);
          });
        });
      }, Promise.resolve());
    }).then(function () { return Store.photosFor(r.recon_id); }).then(function (ps) {
      r.photos_failed = ps.filter(function (p) { return p.status === 'failed'; }).length;
      r.status = 'sent'; r.sent_at = Date.now(); r.last_error = '';
      return Store.put('records', r);
    });
  }

  g.Outbox = Outbox;
})(self);
