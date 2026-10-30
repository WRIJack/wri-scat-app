/* WRI SCAT (offline) — service worker.
 *
 * - Shell: precached, network-first with an 8 s race, cache fallback, so the app opens with no
 *   signal and updates when there is.
 * - Leaflet (cdnjs): cache-first. Map tiles and the APIs are never cached.
 * - Cache Storage is shared by every app on the origin, so activate deletes ONLY this app's old
 *   caches (prefix wri-scat-). Nothing is shared with WRI Field Forms.
 * - Background Sync (Android) drains the outbox with the app closed. iOS has none: the page drains
 *   whenever it's opened.
 *
 * APP_VERSION must equal the ?v= stamps in index.html; bump both together.
 */
var APP_VERSION = '2026-10-30-2';
var CACHE = 'wri-scat-' + APP_VERSION;
var LIB_CACHE = 'wri-scat-lib-leaflet-1.9.4';
var REF_VERSION = '2026-10-30-a';                 // the reference-photo pack (ref/index.json "version"); bump when the pack changes
var REF_CACHE = 'wri-scat-ref-' + REF_VERSION;
var SCOPE_PATH = new URL(self.registration.scope).pathname;   // e.g. /wri-scat-app/ or /wri-scat/

importScripts('js/config.js?v=' + APP_VERSION, 'js/store.js?v=' + APP_VERSION, 'js/api.js?v=' + APP_VERSION,
  'js/forms.js?v=' + APP_VERSION, 'js/outbox.js?v=' + APP_VERSION);

var SHELL = [
  './', './index.html', './manifest.json', './assets/wri-logo.png',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
  './css/app.css?v=' + APP_VERSION,
  './js/config.js?v=' + APP_VERSION, './js/store.js?v=' + APP_VERSION, './js/api.js?v=' + APP_VERSION,
  './js/outbox.js?v=' + APP_VERSION, './js/forms.js?v=' + APP_VERSION, './js/shell.js?v=' + APP_VERSION,
  './js/scat-ref.js?v=' + APP_VERSION, './js/scat-packet.js?v=' + APP_VERSION, './js/scat-ui.js?v=' + APP_VERSION
];
var LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
];

/** The reference photos (about 3 MB): fetched once per pack version into their own cache, so the
 *  shell installs even if the pack does not finish; the fetch handler fills in anything missed. */
function precacheRef() {
  return caches.open(REF_CACHE).then(function (c) {
    return c.match('./ref/index.json').then(function (hit) {
      if (hit) return;
      return fetch('./ref/index.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) return;
        return r.clone().json().then(function (j) {
          return c.put('./ref/index.json', r).then(function () {
            return c.addAll((j.items || []).map(function (it) { return './ref/img/' + it.file; }));
          });
        });
      });
    });
  }).catch(function () {});
}

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }),
    caches.open(LIB_CACHE).then(function (c) { return c.addAll(LIBS).catch(function () {}); }),
    precacheRef()
  ]));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) {
      return n.indexOf('wri-scat-') === 0 && n !== CACHE && n !== LIB_CACHE && n !== REF_CACHE;
    }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(LIB_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(req, r.clone()); return r; });
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.indexOf(SCOPE_PATH) !== 0) return;
  if (url.pathname.indexOf(SCOPE_PATH + 'ref/') === 0) {   // reference pack: cache-first, filled on demand
    e.respondWith(caches.open(REF_CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(req, r.clone()); return r; });
      });
    }));
    return;
  }
  e.respondWith(new Promise(function (resolve) {
    var settled = false;
    var fromCache = function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('./index.html') : null);
      });
    };
    var timer = setTimeout(function () {
      fromCache().then(function (hit) { if (hit && !settled) { settled = true; resolve(hit); } });
    }, 8000);
    fetch(req).then(function (r) {
      clearTimeout(timer);
      if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      if (!settled) { settled = true; resolve(r); }
    }, function () {
      clearTimeout(timer);
      fromCache().then(function (hit) { if (!settled) { settled = true; resolve(hit || Response.error()); } });
    });
  }));
});

self.addEventListener('sync', function (e) {
  if (e.tag === 'wri-scat-outbox') e.waitUntil(Outbox.drain());
});
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'drain') e.waitUntil(Outbox.drain());
});
