/* Copied unchanged from Whitewaterrescue/wri-recon (branch jack/scat-recon-tab, f84d741) on 2026-10-29. Keep in sync; do not edit here. */
/* WRI Recon (offline) — IndexedDB storage, usable from the page and the service worker.
 *
 *   records  keyPath recon_id   one per point: fields, incident, status, oid
 *   photos   keyPath key        '<recon_id>/<idx>': the downscaled JPEG Blob + status.
 *                               Kept apart from records so a status change never
 *                               rewrites megabytes; the Blob is dropped once sent.
 *   kv       keyPath k          pin, device id, cached form config
 */
(function (g) {
  var DB_NAME = 'wri-recon', DB_VER = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'recon_id' });
        if (!db.objectStoreNames.contains('photos')) {
          var ps = db.createObjectStore('photos', { keyPath: 'key' });
          ps.createIndex('by_recon', 'recon_id');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), out;
        var r = fn(t.objectStore(store));
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('aborted')); };
      });
    });
  }

  var Store = {
    put: function (store, v) { return tx(store, 'readwrite', function (s) { return s.put(v); }); },
    get: function (store, k) { return tx(store, 'readonly', function (s) { return s.get(k); }); },
    del: function (store, k) { return tx(store, 'readwrite', function (s) { return s.delete(k); }); },
    all: function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); },
    photosFor: function (reconId) {
      return tx('photos', 'readonly', function (s) { return s.index('by_recon').getAll(reconId); })
        .then(function (ps) { return (ps || []).sort(function (a, b) { return a.idx - b.idx; }); });
    },
    kvGet: function (k) { return Store.get('kv', k).then(function (r) { return r ? r.v : null; }); },
    kvSet: function (k, v) { return Store.put('kv', { k: k, v: v }); },
    deviceId: function () {
      return Store.kvGet('device').then(function (d) {
        if (d) return d;
        d = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'dev-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        return Store.kvSet('device', d).then(function () { return d; });
      });
    }
  };
  g.Store = Store;
})(self);
