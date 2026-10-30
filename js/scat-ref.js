/* WRI SCAT (offline) — reference photos for the tile screens.
 *
 * ref/index.json (built by scripts/build-ref-index.js) lists the NOAA job-aid images and which hallway
 * screens each one illustrates, as targets "<key>:<code>" (key = a list name such as thickness, "shore"
 * for the shoreline-type screens, "methods" for the treatment recommendation; code "*" = shown for
 * reference only). The service worker precaches the whole pack (cache wri-scat-ref-<version>), so the
 * sheet works with no signal once the app has been opened online once.
 *
 * The sheet is one scrolling list: photo, label, NOAA caption. Tapping a photo that maps to a tile on
 * the current screen picks that tile (the caller's onPick) and closes the sheet. The credit line is
 * shown on every open; the photos are not ours.
 */
(function (g) {
  var idx = null, loading = null, onPick = null, openKey = '';

  function load() {
    if (idx) return Promise.resolve(idx);
    if (loading) return loading;
    loading = fetch('ref/index.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { idx = j; loading = null; try { g.dispatchEvent(new Event('ref:ready')); } catch (e) {} return idx; })
      .catch(function () { loading = null; return null; });
    return loading;
  }

  /** Items for a screen key ("thickness", "shore", "methods"...), each with .code for this key ('' = reference only). */
  function forKey(key) {
    if (!idx || !key) return [];
    var out = [];
    idx.items.forEach(function (it) {
      var hit = null;
      it.targets.forEach(function (t) {
        var i = t.indexOf(':'), k = t.slice(0, i), c = t.slice(i + 1);
        if (k === key && (hit === null || hit === '')) hit = c === '*' ? '' : c;
      });
      if (hit !== null) out.push({ item: it, code: hit });
    });
    // charts first, then items with a tile, then reference-only, keeping the job aid's order inside each group
    return out.sort(function (a, b) { return rank(a) - rank(b); });
  }
  function rank(x) { return x.item.chart ? 0 : x.code ? 1 : 2; }
  function has(key) { return forKey(key).length > 0; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /** Open the sheet for a screen. labelOf(code) names the tile a photo maps to; pick(code) is called on tap. */
  function open(key, title, labelOf, pick) {
    var sheet = document.getElementById('scRefSheet'); if (!sheet) return;
    onPick = pick || null; openKey = key;
    var rows = forKey(key);
    document.getElementById('scRefTitle').textContent = title || 'What does this look like?';
    document.getElementById('scRefList').innerHTML = rows.map(function (x) {
      var it = x.item, can = !!pick && !!x.code, tile = can && labelOf ? labelOf(x.code) : '';
      var tag = it.marine ? '<span class="pk-tag grey">marine example</span>' : it.chart ? '<span class="pk-tag">chart</span>' : '';
      return '<div class="ref-card' + (can ? ' pick' : '') + '" data-code="' + esc(x.code) + '">' +
        '<img class="ref-img' + (it.chart ? ' chart' : '') + '" loading="lazy" src="ref/img/' + esc(it.file) + '" width="' + it.w + '" height="' + it.h + '" alt="">' +
        '<div class="ref-body"><div class="ref-label">' + esc(it.label) + ' ' + tag + '</div>' +
        (it.caption ? '<div class="ref-cap">' + esc(it.caption) + '</div>' : '') +
        (can ? '<div class="ref-pick">Tap to pick <b>' + esc((tile || x.code).split(/:\s*/)[0]) + '</b></div>' : '') +
        '</div></div>';
    }).join('') || '<div class="hint">No reference photos for this screen.</div>';
    document.getElementById('scRefCredit').textContent = (idx && idx.credit) || '';
    sheet.classList.remove('hidden');
    document.body.classList.add('noscroll');
    document.getElementById('scRefList').scrollTop = 0;
  }
  function close() {
    var sheet = document.getElementById('scRefSheet'); if (!sheet) return;
    sheet.classList.add('hidden'); document.body.classList.remove('noscroll'); onPick = null;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var sheet = document.getElementById('scRefSheet'); if (!sheet) return;
    document.getElementById('scRefClose').addEventListener('click', close);
    document.getElementById('scRefList').addEventListener('click', function (e) {
      var card = e.target.closest('.ref-card.pick'); if (!card || !onPick) return;
      var code = card.dataset.code, fn = onPick; close(); fn(code);
    });
    sheet.addEventListener('click', function (e) { if (e.target === sheet) close(); });
    load();
  });

  g.ScatRef = { load: load, forKey: forKey, has: has, open: open, close: close, index: function () { return idx; } };
})(self);
