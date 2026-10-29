# WRI SCAT (offline)

The SCAT app for WRI incidents: a phone-first page that works with no signal. Recon SCAT stops, SCAT
surveys (bank character, oiled zones, pits, photos, treatment recommendation) and, later, endpoint
reviews and field-proposed segment changes. Records are saved on the phone (IndexedDB) and upload by
themselves when there's coverage, one photo per request.

- Server: the SCAT Ops API (`WRIJack/wri-scat-ops`, `Api.js`): `?api=config` for code lists, segments
  and the NOAA treatment tables; `scat_submit` / `scat_photo` to the SCAT staging sheet, idempotent by
  record id. The incident list comes read-only from the Recon Apps Script config until the SCAT API
  serves it through WRIServiceLib.
- Gate: the SCAT PIN only (`FORM_KINDS.scat.pin_scope`). The incident Gateway PIN is never sent from
  this app. Built for crews who are not WRI staff.
- Standalone on purpose: `js/store.js`, `js/api.js` and `js/outbox.js` are copies of the WRI Field Forms
  files (header says which commit); keep them identical, never edit them here. `js/shell.js` is this
  app's own incident picker, saved list and upload triggers; `js/scat-ui.js` is the SCAT hallways. The
  service worker caches under `wri-scat-*` only, so nothing is shared with Field Forms at runtime.
- UI rules: one question per screen, big colour tiles, tap to advance, no dropdowns, typing only where
  a tile cannot answer; every screen has Skip except where cataloguing needs an answer.
- Deploy: push to `main` (GitHub Pages). Bump `APP_VERSION` in `sw.js` and the `?v=` stamps in
  `index.html` together.

Test copy: https://wrijack.github.io/wri-scat-app/ (sandbox API). The portal copy comes through Cody.
