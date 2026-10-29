/* WRI Field Forms — SCAT tab (2026-10-28): Recon SCAT and SCAT Survey phases.
 *
 * Screens in the spirit of Esri QuickCapture: one question per screen, big colour tiles, a
 * single-choice tap answers and moves on, no dropdowns, typing only for notes, an unlisted
 * segment ID, and name / team / organisation (remembered). Every screen has Skip except the
 * ones that catalogue the record (segment or location; a zone's bank and start point).
 * Skipped screens are recorded as skipped (fields.skipped), not as empty.
 *
 * Phases: 'recon' (a triage stop) and 'survey' (the SOS survey: setup, extent, bank
 * character, operations, zones, pits, photos, summary, STR, review). The phase is a sticky
 * choice on the phone (wri_scat_phase); the chooser only shows until it is made. Zones and
 * pits are repeatable items with their own short hallways; they go to the server inside the
 * survey record and land as child rows there.
 *
 * STR step: shoreline type -> crosswalk -> NOAA habitat(s) -> matrix score per method for
 * the incident's oil category, worst letter across two habitats, then the enabled inland
 * overrides whose condition the survey satisfies. All tables come from GET ?api=config and
 * are cached on the phone (kv 'cfg_scat'). The crew sees "NOAA base B, inland C (why)".
 *
 * Same rules as Recon: saved on the phone first (Outbox.enqueue with photos), uploaded when
 * there's signal, one photo per request. Server: the SCAT Ops API (CONFIG.SCAT_API, repo
 * WRIJack/wri-scat-ops, Api.js): scat_submit then scat_photo, PIN-gated, idempotent by id.
 * Built for crews that are not WRI staff: the incident PIN is the only gate.
 */
(function () {
  var A, $, S;
  var cfg = null, F = null, advancing = null;
  var PHASE_KEY = 'wri_scat_phase', STICKY_KEY = 'wri_scat_sticky';
  var YN = [{ code: 'yes', label: 'Yes' }, { code: 'no', label: 'No' }];
  var YN_GOOD = { yes: 'green', no: 'red' }, YN_BAD = { yes: 'red', no: 'green' };
  var LETTER_TONE = { A: 'green', B: 'blue', C: 'amber', D: 'red', I: 'grey', '-': 'grey' };
  var flowing = function () { return F.water_body === 'river' || F.water_body === 'stream'; };
  var wetland = function () { return F.water_body === 'wetland' || F.bank_type_primary === 'marsh_wetland'; };

  // ---------- hallways ----------
  var RECON = [
    { key: 'where', section: 'where', required: true },
    { key: 'oil', section: 'tiles', q: 'Is there oil on the bank?', list: 'oil_present', field: 'oil', single: true, tones: { yes: 'red', no: 'green', unsure: 'amber' } },
    { key: 'extent', section: 'tiles', q: 'How much of the bank has oil on it?', list: 'oil_extent', field: 'extent', single: true,
      tones: { trace: 'green', sporadic: 'amber', patchy: 'amber', broken: 'orange', continuous: 'red' }, when: function (d) { return d.oil === 'yes' || d.oil === 'unsure'; } },
    { key: 'trend', section: 'tiles', q: 'Water level right now?', sub: 'Compared with an hour ago.', list: 'water_trend', field: 'trend', single: true, tones: { rising: 'amber', steady: 'blue', falling: 'blue' } },
    { key: 'access', section: 'tiles', q: 'Can a team get here?', list: 'access', field: 'access', single: true, tones: { foot: 'green', boat: 'blue', atv: 'blue', none: 'red' } },
    { key: 'hazards', section: 'tiles', q: 'Any hazards?', sub: 'Tap all that apply, then Next.', list: 'hazard', field: 'hazards', multi: true, selTone: 'amber', note: { field: 'hazardNote', label: 'Anything else a team should know (optional)' } },
    { key: 'photos', section: 'photos' },
    { key: 'priority', section: 'tiles', q: 'How urgent is it?', list: 'priority', field: 'priority', single: true, tones: { high: 'red', medium: 'amber', low: 'blue', none: 'grey' } },
    { key: 'notes', section: 'notes' },
    { key: 'review', section: 'review' }
  ];
  var SURVEY = [
    { key: 'where', section: 'where', required: true },
    { key: 'survey_kind', section: 'tiles', q: 'Which survey is this?', list: 'survey_kind', field: 'survey_kind', single: true, tones: { initial: 'blue', repeat: 'blue', post_treatment: 'amber' } },
    { key: 'water_body', section: 'tiles', q: 'What kind of water?', list: 'water_body', field: 'water_body', single: true, sticky: true },
    { key: 'water_level', section: 'tiles', q: 'Water level today?', list: 'water_level', field: 'water_level', single: true, sticky: true, tones: { low: 'blue', normal: 'green', high: 'amber', flood: 'red' } },
    { key: 'water_trend', section: 'tiles', q: 'Is it rising or falling?', list: 'water_trend', field: 'water_trend', single: true, sticky: true, tones: { rising: 'amber', steady: 'blue', falling: 'blue' } },
    { key: 'survey_method', section: 'tiles', q: 'How are you surveying?', sub: 'Tap all that apply.', list: 'survey_method', field: 'survey_method', multi: true, sticky: true, selTone: 'blue' },
    { key: 'weather', section: 'tiles', q: 'Weather', sub: 'Tap all that apply.', list: 'weather', field: 'weather', multi: true, sticky: true, selTone: 'blue' },
    { key: 'team', section: 'team', sticky: true },
    { key: 'extent', section: 'extent' },
    { key: 'bank_type', section: 'tiles', q: 'What is the bank mostly made of?', sub: 'One main type.', shore: true, field: 'bank_type_primary', single: true },
    { key: 'bank_oiled', section: 'tiles', q: 'Which of these have oil on them?', sub: 'Tap all that apply.', shore: true, field: 'bank_types_oiled', multi: true, selTone: 'red' },
    { key: 'overbank', section: 'tiles', q: 'What is above the bank?', list: 'overbank_type', field: 'overbank_type', single: true },
    { key: 'slope', section: 'tiles', q: 'How steep is it?', list: 'slope_class', field: 'overbank_slope', single: true, when: function (d) { return d.overbank_type === 'cliff_bluff' || d.overbank_type === 'sloped'; } },
    { key: 'wet_setting', section: 'tiles', q: 'What kind of wetland setting?', list: 'wetland_setting', field: 'wetland_setting', single: true, when: wetland },
    { key: 'wet_type', section: 'tiles', q: 'What kind of wetland?', list: 'wetland_type', field: 'wetland_type', single: true, when: wetland },
    { key: 'vegetation', section: 'tiles', q: 'Main vegetation?', list: 'vegetation', field: 'dominant_vegetation', single: true, when: wetland },
    { key: 'channel_width', section: 'tiles', q: 'How wide is the channel?', list: 'channel_width', field: 'channel_width_class', single: true, when: flowing },
    { key: 'water_depth', section: 'tiles', q: 'How deep is the water?', list: 'water_depth', field: 'water_depth_class', single: true, when: flowing },
    { key: 'channel_form', section: 'tiles', q: 'What is the channel doing here?', sub: 'Tap all that apply.', list: 'channel_form', field: 'channel_form', multi: true, selTone: 'blue', when: flowing },
    { key: 'river_form', section: 'tiles', q: 'River form', list: 'river_form', field: 'river_form', single: true, when: flowing },
    { key: 'valley_form', section: 'tiles', q: 'Valley form', list: 'valley_form', field: 'valley_form', single: true, when: flowing },
    { key: 'debris', section: 'tiles', q: 'Oiled debris on the bank?', opts: YN, tones: YN_BAD, field: 'oiled_debris', single: true },
    { key: 'debris_type', section: 'tiles', q: 'What kind of debris?', sub: 'Tap all that apply.', list: 'debris_type', field: 'debris_types', multi: true, selTone: 'amber', when: function (d) { return d.oiled_debris === 'yes'; } },
    { key: 'backshore_access', section: 'tiles', q: 'Can you reach the bank from the land side?', opts: YN, tones: YN_GOOD, field: 'backshore_access', single: true },
    { key: 'alongshore_access', section: 'tiles', q: 'Can you walk in along the bank?', list: 'alongshore_access', field: 'alongshore_access', single: true, tones: { none: 'red', both: 'green' } },
    { key: 'staging', section: 'tiles', q: 'Room to stage equipment above the bank?', opts: YN, tones: YN_GOOD, field: 'staging_suitable', single: true },
    { key: 'current', section: 'tiles', q: 'Is the current strong along this bank?', opts: YN, tones: YN_BAD, field: 'current_dominated', single: true, when: flowing },
    { key: 'surface_bearing', section: 'tiles', q: 'What will the ground carry?', sub: 'Tap all that apply.', list: 'surface_bearing', field: 'surface_bearing', multi: true, selTone: 'blue', when: wetland },
    { key: 'hazards', section: 'tiles', q: 'Any hazards?', sub: 'Tap all that apply, then Next.', list: 'hazard', field: 'hazards', multi: true, selTone: 'amber', note: { field: 'hazard_note', label: 'Anything else a team should know (optional)' } },
    { key: 'zones', section: 'items', items: 'zones', label: 'oiled zone', q: 'Oiled zones', sub: 'One zone per band or patch of oil. Add each one, then Next.' },
    { key: 'pits', section: 'items', items: 'pits', label: 'pit', q: 'Pits', sub: 'Dig where oil could have gone into the bank. Add each pit, then Next.' },
    { key: 'photos', section: 'photos' },
    { key: 'wildlife', section: 'tiles', q: 'Wildlife seen?', sub: 'Tap all that apply.', list: 'wildlife', field: 'wildlife', multi: true, selTone: 'blue' },
    { key: 'wildlife_oiled', section: 'tiles', q: 'Any of it oiled?', opts: YN, tones: YN_BAD, field: 'wildlife_oiled', single: true, when: function (d) { return d.wildlife.length > 0 && d.wildlife.indexOf('none') < 0; } },
    { key: 'issues', section: 'tiles', q: 'Anything a cleanup must respect here?', sub: 'Tap all that apply.', list: 'issues', field: 'issues', multi: true, selTone: 'amber' },
    { key: 'oil_category', section: 'tiles', q: 'What kind of oil is it?', list: 'oil_category', field: 'oil_category', single: true, sticky: true, tones: { I: 'amber', II: 'amber', III: 'orange', IV: 'red', V: 'red' } },
    { key: 'containment', section: 'tiles', q: 'Is there containment downstream of this segment?', opts: YN, tones: { yes: 'green', no: 'amber' }, field: 'containment', single: true, when: flowing },
    { key: 'str', section: 'str' },
    { key: 'notes', section: 'notes' },
    { key: 'review', section: 'review' }
  ];
  var ZONE = [
    { key: 'bank_side', section: 'tiles', q: 'Which bank?', sub: 'Facing downstream.', list: 'bank_side', field: 'bank_side', single: true, required: true, when: flowing },
    { key: 'bank_zone', section: 'tiles', q: 'Where on the bank?', list: 'bank_zone', field: 'bank_zone', single: true, required: true },
    { key: 'start', section: 'zonegps', required: true },
    { key: 'substrate', section: 'tiles', q: 'What is the oil on?', shore: true, field: 'substrate_type', single: true },
    { key: 'oil_on', section: 'tiles', q: 'Ground, plants, or both?', list: 'oil_on', field: 'oil_on', single: true },
    { key: 'length', section: 'tiles', q: 'How long is the oiled zone?', preset: [5, 10, 25, 50, 100, 250], unit: 'm', field: 'length_m' },
    { key: 'width', section: 'tiles', q: 'How wide?', preset: [0.5, 1, 2, 5, 10], unit: 'm', field: 'width_m' },
    { key: 'mode', section: 'tiles', q: 'A band or patch, or scattered tar balls?', list: 'distribution_mode', field: 'distribution_mode', single: true },
    { key: 'band', section: 'tiles', q: 'How much of the zone has oil?', list: 'distribution_band', field: 'distribution_band', single: true,
      tones: { trace: 'green', sporadic: 'amber', patchy: 'amber', broken: 'orange', continuous: 'red' }, when: function (d) { return d.distribution_mode !== 'count_per_area'; } },
    { key: 'count', section: 'tiles', q: 'How many per square metre?', preset: [1, 5, 10, 25, 50, 100], unit: 'per m²', field: 'count_per_m2', when: function (d) { return d.distribution_mode === 'count_per_area'; } },
    { key: 'size', section: 'tiles', q: 'Typical size?', preset: [1, 2, 5, 10, 20, 50], unit: 'cm', field: 'avg_size_cm', when: function (d) { return d.distribution_mode === 'count_per_area'; } },
    { key: 'thickness', section: 'tiles', q: 'How thick is the oil?', list: 'thickness', field: 'thickness', single: true, tones: { thick: 'red', cover: 'orange', coat: 'amber', stain: 'blue', film: 'green' } },
    { key: 'character', section: 'tiles', q: 'What does the oil look like?', sub: 'Tap all that apply.', list: 'oil_character', field: 'oil_character', multi: true, selTone: 'red' },
    { key: 'plant_height', section: 'tiles', q: 'How high up the plants?', preset: [5, 10, 20, 50, 100], unit: 'cm', field: 'oil_height_on_plants_cm', when: function (d) { return d.oil_on === 'vegetation' || d.oil_on === 'both'; } },
    { key: 'plant_part', section: 'tiles', q: 'Which part of the plants?', sub: 'Tap all that apply.', list: 'plant_part', field: 'plant_part', multi: true, selTone: 'amber', when: function (d) { return d.oil_on === 'vegetation' || d.oil_on === 'both'; } },
    { key: 'mobile', section: 'tiles', q: 'Is the oil loose or stuck on?', list: 'mobile', field: 'mobile', single: true, tones: { free_mobile: 'red', fixed_adhering: 'blue' } },
    { key: 'sticky', section: 'tiles', q: 'Sticky to the touch?', opts: YN, tones: YN_BAD, field: 'sticky', single: true },
    { key: 'notes', section: 'itemnotes' }
  ];
  var PIT = [
    { key: 'zone_ref', section: 'tiles', q: 'Which zone is this pit in?', dyn: function () { return [{ code: 'none', label: 'Not in a zone' }].concat(F.zones.map(function (z, i) { return { code: zoneId(i), label: 'Zone ' + zoneId(i) + (z.bank_zone ? ': ' + label('bank_zone', z.bank_zone) : '') }; })); }, field: 'zone_ref', single: true },
    { key: 'bank_zone', section: 'tiles', q: 'Where on the bank?', list: 'bank_zone', field: 'bank_zone', single: true, required: true },
    { key: 'loc', section: 'zonegps', required: true },
    { key: 'substrate', section: 'tiles', q: 'What is the surface made of?', shore: true, field: 'substrate_surface', single: true },
    { key: 'depth', section: 'tiles', q: 'How deep did you dig?', preset: [10, 20, 30, 50, 80], unit: 'cm', field: 'pit_depth_cm' },
    { key: 'top', section: 'tiles', q: 'Oil starts how far down?', preset: [0, 5, 10, 20, 30], unit: 'cm', field: 'oiled_top_cm' },
    { key: 'bottom', section: 'tiles', q: 'Oil ends how far down?', preset: [5, 10, 20, 30, 50], unit: 'cm', field: 'oiled_bottom_cm' },
    { key: 'subsurface', section: 'tiles', q: 'What does the oiled layer look like?', list: 'subsurface_character', field: 'subsurface_character', single: true,
      tones: { oil_filled_pores: 'red', partially_filled_pores: 'orange', oil_residue: 'amber', oil_film: 'blue', trace: 'green', no_oil: 'green' } },
    { key: 'sheen', section: 'tiles', q: 'Sheen on water in the pit?', list: 'sheen_color', field: 'sheen_color', single: true, tones: { none: 'green', brown: 'red', rainbow: 'amber', silver: 'blue' } },
    { key: 'clean_below', section: 'tiles', q: 'Clean below the oiled layer?', opts: YN, tones: YN_GOOD, field: 'clean_below', single: true },
    { key: 'notes', section: 'itemnotes' }
  ];
  var ITEM_HALLWAY = { zones: ZONE, pits: PIT };

  // ---------- state ----------
  function sticky() { try { return JSON.parse(A.lsGet(STICKY_KEY) || '{}'); } catch (e) { return {}; } }
  function fresh() {
    var st = sticky();
    var f = { i: 0, sub: null, segment: '', segmentLabel: '', bank: '', lat: null, lon: null, acc: null, captured: Date.now(), photos: [], skipped: {},
              team: A.lsGet('wri_scat_team') || '', name: A.lsGet('wri_scat_name') || '', org: A.lsGet('wri_scat_org') || '', notes: '' };
    var p = F ? F.phase : phase();   // '' until the phone has chosen: the chooser screen shows
    if (p === 'recon') {
      Object.assign(f, { phase: 'recon', oil: '', extent: '', trend: '', access: '', hazards: [], hazardNote: '', priority: '' });
    } else {
      Object.assign(f, { phase: p === 'survey' ? 'survey' : '', survey_kind: '', water_body: '', water_level: '', water_trend: '', survey_method: [], weather: [], team_id: '', team_members: '',
        length_surveyed_m: null, whole_segment: '', end_lat: null, end_lon: null,
        bank_type_primary: '', bank_types_oiled: [], overbank_type: '', overbank_slope: '', wetland_setting: '', wetland_type: '', dominant_vegetation: '',
        channel_width_class: '', water_depth_class: '', channel_form: [], river_form: '', valley_form: '',
        oiled_debris: '', debris_types: [], backshore_access: '', alongshore_access: '', staging_suitable: '', current_dominated: '', surface_bearing: [],
        hazards: [], hazard_note: '', zones: [], pits: [], wildlife: [], wildlife_oiled: '', issues: [], oil_category: '', containment: '',
        str: { recommended: [], rationale: '' } });
      Object.keys(st).forEach(function (k) { if (k in f) f[k] = st[k]; });
    }
    return f;
  }
  function phase() { return A.lsGet(PHASE_KEY) || ''; }
  function screens() { return F.sub ? ITEM_HALLWAY[F.sub.items] : (F.phase === 'recon' ? RECON : SURVEY); }
  function data() { return F.sub ? F.sub.data : F; }
  function cur() { return screens()[F.sub ? F.sub.i : F.i]; }
  function idx() { return F.sub ? F.sub.i : F.i; }
  function setIdx(i) { if (F.sub) F.sub.i = i; else F.i = i; }
  function list(name) { return (cfg && cfg.lists && cfg.lists[name]) || []; }
  function label(name, code) { var hit = list(name).filter(function (o) { return o.code === code; })[0]; return hit ? hit.label : code; }
  function shoreTypes() { return ((cfg && cfg.shore_types) || []).filter(function (t) { return t.kind === 'type'; }); }
  function shoreLabel(code) { var t = shoreTypes().filter(function (x) { return x.code === code; })[0]; return t ? t.label : code; }
  function zoneId(i) { return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''); }
  function optsFor(s) {
    if (s.opts) return s.opts;
    if (s.dyn) return s.dyn();
    if (s.shore) return shoreTypes().map(function (t) { return { code: t.code, label: t.label }; });
    if (s.preset) return s.preset.map(function (v) { return { code: String(v), label: v + ' ' + s.unit }; }).concat([{ code: '__other', label: 'Other…' }]);
    return list(s.list);
  }
  function labelFor(s, code) {
    var o = optsFor(s).filter(function (x) { return x.code === String(code); })[0];
    return o ? o.label : (s.preset ? code + ' ' + s.unit : code);
  }

  // ---------- tiles ----------
  function tiles(el, items, picked, multi, tones, selTone) {
    el.innerHTML = items.length ? items.map(function (o) {
      var on = multi ? (picked || []).indexOf(o.code) >= 0 : String(picked) === o.code && picked !== '' && picked != null;
      var tone = (tones && tones[o.code]) || (on && selTone) || '';
      var parts = String(o.label).split(/:\s*/);
      var text = parts.length > 1 ? A.esc(parts[0]) + '<small>' + A.esc(parts.slice(1).join(': ')) + '</small>' : A.esc(o.label);
      return '<button type="button" class="tile' + (tone ? ' t-' + tone : '') + (on ? ' sel' : '') + '" data-code="' + A.esc(o.code) + '">' +
        '<span>' + text + '</span>' + (on ? '<span class="ck">✓</span>' : '') + '</button>';
    }).join('') : '<div class="hint">Lists not loaded yet: open this tab once with signal.</div>';
  }
  function renderTileScreen(s) {
    var d = data(), v = d[s.field];
    $('scTileQ').innerHTML = A.esc(s.q) + (s.sub ? '<small>' + A.esc(s.sub) + '</small>' : '');
    var picked = s.preset ? (v == null || v === '' ? '' : (s.preset.indexOf(Number(v)) >= 0 ? String(v) : '__other')) : v;
    tiles($('scTiles'), optsFor(s), picked, !!s.multi, s.tones, s.selTone);
    var other = !!s.preset && picked === '__other';
    $('scTileNumBox').classList.toggle('hidden', !other);
    if (other) { $('scTileNum').value = v == null ? '' : v; $('scTileUnit').textContent = s.unit; }
    $('scTileNoteBox').classList.toggle('hidden', !s.note);
    if (s.note) { $('scTileNoteLabel').textContent = s.note.label; $('scTileNote').value = d[s.note.field] || ''; }
  }
  var lastGo = 0;   // taps in the first 300 ms after a screen change are ignored (gloved double-taps)
  function onTile(code) {
    var s = cur(), d = data(); if (!s.field) return;
    if (Date.now() - lastGo < 300) return;
    if (s.multi) {
      var arr = d[s.field] = d[s.field] || [];
      var i = arr.indexOf(code); if (i >= 0) arr.splice(i, 1); else arr.push(code);
      renderTileScreen(s); return;
    }
    if (s.preset) {
      if (code === '__other') { d[s.field] = d[s.field] != null && s.preset.indexOf(Number(d[s.field])) < 0 ? d[s.field] : ''; renderTileScreen(s); $('scTileNum').focus(); return; }
      d[s.field] = Number(code);
    } else d[s.field] = code;
    if (s.key === 'oil' && code === 'no') d.extent = '';
    delete (F.sub ? F.sub.skipped : F.skipped)[s.key];
    renderTileScreen(s);
    clearTimeout(advancing);
    advancing = setTimeout(function () { go(idx() + 1); }, 180);
  }

  // ---------- where ----------
  function segments() { return (cfg && cfg.segments) || []; }
  function distM(a1, o1, a2, o2) {   // great-circle metres, good enough for sorting
    var R = 6371000, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
    var h = Math.sin(dA / 2) * Math.sin(dA / 2) + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) * Math.sin(dO / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function renderSegments() {
    var q = $('scSegSearch').value.trim().toLowerCase();
    var inc = S.incident && S.incident.incident_id;
    var all = segments().filter(function (s) { return !s.incident_id || !inc || String(s.incident_id) === String(inc); });
    var hits = q ? all.filter(function (s) { return (s.segment_id + ' ' + (s.label || '')).toLowerCase().indexOf(q) >= 0; }) : all.slice();
    // nearest first when the phone has a fix and the segments carry a point (Caleb's layer, or lat/lon in the tab)
    if (F.lat != null) {
      hits.forEach(function (s) { s._d = s.lat != null ? distM(F.lat, F.lon, s.lat, s.lon) : null; });
      hits.sort(function (a, b) { return (a._d == null) - (b._d == null) || (a._d || 0) - (b._d || 0); });
    }
    hits = hits.slice(0, 8);
    $('scSegList').innerHTML = hits.map(function (s) {
      var on = s.segment_id === F.segment;
      var far = s._d != null && F.lat != null ? (s._d < 950 ? Math.round(s._d / 10) * 10 + ' m away' : (s._d / 1000).toFixed(1) + ' km away') : '';
      return '<button type="button" class="tile seg' + (on ? ' sel' : '') + '" data-id="' + A.esc(s.segment_id) + '"><span>' + A.esc(s.segment_id) +
        '<small>' + A.esc([s.label || '', far].filter(Boolean).join(' · ')) + '</small></span>' + (on ? '<span class="ck">✓</span>' : '') + '</button>';
    }).join('') || (all.length ? '<div class="hint">No segment matches. Keep typing, or use what you typed.</div>'
                                : '<div class="hint">No segment list yet: open this tab once with signal, or type the segment ID.</div>');
    $('scSegTyped').classList.toggle('hidden', !q || hits.some(function (s) { return s.segment_id.toLowerCase() === q; }));
    $('scSegPicked').classList.toggle('hidden', !F.segment || hits.some(function (s) { return s.segment_id === F.segment; }));
    $('scSegPicked').innerHTML = F.segment ? 'Segment <b>' + A.esc(F.segment) + '</b>' + (F.segmentLabel ? ' · ' + A.esc(F.segmentLabel) : '') +
      ' <button class="link" type="button" id="scSegClear">change</button>' : '';
  }
  function pickSegment(id) {
    var s = segments().filter(function (x) { return x.segment_id === id; })[0];
    F.segment = F.segment === id ? '' : id;
    F.segmentLabel = F.segment && s ? (s.label || '') : '';
    if (F.segment && s && s.bank && !F.bank) F.bank = s.bank;
    $('scSegSearch').value = '';
    renderWhere();
  }
  function renderWhere() {
    renderSegments();
    $('scBankBox').classList.toggle('hidden', F.phase !== 'recon');
    tiles($('scBank'), list('bank_side'), F.bank, false, null, 'blue');
    renderMine();
    setTimeout(function () { initMap(); if (map) map.invalidateSize(); }, 50);
  }
  // ---------- map (tap to drop or move the point; same tiles as the Recon map) ----------
  var map = null, marker = null;
  function initMap() {
    if (map || typeof L === 'undefined' || !navigator.onLine || !$('scMap')) return;
    try {
      var inc = S.cfg && S.cfg.incidents && S.cfg.incidents.filter(function (r) { return S.incident && r.incident_id === S.incident.incident_id; })[0];
      var c = F.lat != null ? [F.lat, F.lon] : (inc && inc.lat != null) ? [inc.lat, inc.lon] : [46.87, -113.99];
      map = L.map('scMap', { zoomControl: true, attributionControl: true }).setView(c, F.lat != null ? 15 : 12);
      L.tileLayer(CONFIG.TILE_URL, { maxZoom: 19, attribution: 'Esri, Maxar' }).addTo(map);
      map.on('click', function (e) { setLoc(F, e.latlng.lat, e.latlng.lng, null, 'map', 'scCoords', 'scLat', 'scLon'); });
      $('scMapMsg').classList.add('hidden');
      if (F.lat != null) placeMarker();
    } catch (e) { map = null; }
  }
  function placeMarker() {
    if (!map || F.lat == null) { if (marker && map) { map.removeLayer(marker); marker = null; } return; }
    var ll = [F.lat, F.lon];
    if (!marker) marker = L.circleMarker(ll, { radius: 9, color: '#fff', weight: 2, fillColor: '#f0a500', fillOpacity: 1 }).addTo(map);
    else marker.setLatLng(ll);
  }
  function setLoc(target, lat, lon, acc, from, coordsId, latId, lonId) {
    target.lat = Number(lat); target.lon = Number(lon); target.acc = acc == null ? null : Math.round(acc);
    $(coordsId).textContent = target.lat.toFixed(6) + ', ' + target.lon.toFixed(6) + (target.acc != null ? '  ± ' + target.acc + ' m' : '') + (from === 'map' ? '  (from the map)' : '');
    if (from !== 'typed' && latId) {   // inputs hold magnitudes; the hemisphere toggles hold the sign
      $(latId).value = Math.abs(target.lat).toFixed(6); $(lonId).value = Math.abs(target.lon).toFixed(6);
      [].forEach.call($('scLatHemi').children, function (b) { b.classList.toggle('active', b.dataset.val === (target.lat < 0 ? 'S' : 'N')); });
      [].forEach.call($('scLonHemi').children, function (b) { b.classList.toggle('active', b.dataset.val === (target.lon < 0 ? 'W' : 'E')); });
    }
    if (target === F && map) { placeMarker(); if (from !== 'map') map.setView([F.lat, F.lon], Math.max(map.getZoom(), 15)); }
    if (target === F && F.phase && !F.sub && cur().section === 'where') renderSegments();   // re-sort nearest-first
  }
  function gps(btnId, onFix) {
    var b = $(btnId);
    if (!navigator.geolocation) { A.toast('This phone has no GPS access. Type the coordinates.'); return; }
    A.busy(b, true, 'Getting location…');
    navigator.geolocation.getCurrentPosition(function (p) {
      A.busy(b, false); b.classList.add('ok'); b.textContent = '📍 Location captured ✓ (tap to refresh)';
      onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    }, function (e) {
      A.busy(b, false); A.toast('No GPS fix (' + e.message + '). Step outside, try again, or type the coordinates.', 6000);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  }
  function hemi(id) { return (document.querySelector('#' + id + ' .active') || {}).dataset.val; }
  function typed() {
    var la = Math.abs(parseFloat($('scLat').value)), lo = Math.abs(parseFloat($('scLon').value));
    if (hemi('scLatHemi') === 'S') la = -la;
    if (hemi('scLonHemi') === 'W') lo = -lo;
    if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) setLoc(F, la, lo, null, 'typed', 'scCoords');
  }
  /** Zone / pit location screen: GPS for the start, optional end. */
  function renderZoneGps() {
    var d = data(), isPit = F.sub.items === 'pits';
    $('scZq').innerHTML = isPit ? 'Where is the pit?' : 'Where does the oiled zone start?<small>Stand at the upstream end and tap.</small>';
    $('scZCoords').textContent = d.start_lat != null ? d.start_lat.toFixed(6) + ', ' + d.start_lon.toFixed(6) + (d.start_acc != null ? '  ± ' + d.start_acc + ' m' : '') : 'No location yet';
    $('scZGps').textContent = d.start_lat != null ? '📍 Start captured ✓ (tap to refresh)' : '📍 Use My Location';
    $('scZGps').classList.toggle('ok', d.start_lat != null);
    $('scZEndBox').classList.toggle('hidden', isPit);
    $('scZEndCoords').textContent = d.end_lat != null ? d.end_lat.toFixed(6) + ', ' + d.end_lon.toFixed(6) : 'Not marked (uses the start)';
  }

  // ---------- extent / team ----------
  function renderExtent() {
    var opts = [50, 100, 250, 500, 800].map(function (v) { return { code: String(v), label: v + ' m' }; }).concat([{ code: 'whole', label: 'The whole segment' }, { code: '__other', label: 'Other…' }]);
    var v = F.length_surveyed_m, picked = F.whole_segment === 'yes' ? 'whole' : (v == null ? '' : ([50, 100, 250, 500, 800].indexOf(Number(v)) >= 0 ? String(v) : '__other'));
    tiles($('scExtentTiles'), opts, picked, false, { whole: 'green' }, 'blue');
    $('scExtentNumBox').classList.toggle('hidden', picked !== '__other');
    if (picked === '__other') $('scExtentNum').value = v == null ? '' : v;
    $('scEndCoords').textContent = F.end_lat != null ? F.end_lat.toFixed(6) + ', ' + F.end_lon.toFixed(6) : 'Not marked yet';
  }
  function onExtentTile(code) {
    if (code === 'whole') { F.whole_segment = 'yes'; F.length_surveyed_m = null; }
    else if (code === '__other') { F.whole_segment = ''; F.length_surveyed_m = ''; renderExtent(); $('scExtentNum').focus(); return; }
    else { F.whole_segment = ''; F.length_surveyed_m = Number(code); }
    renderExtent();
  }
  function renderTeam() { $('scTeamId').value = F.team_id; $('scTeamMembers').value = F.team_members; }

  // ---------- items (zones, pits) ----------
  function itemTitle(items, it, i) {
    if (items === 'zones') return 'Zone ' + zoneId(i) + (it.bank_zone ? ' · ' + label('bank_zone', it.bank_zone) : '') +
      (it.distribution_band ? ' · ' + label('distribution_band', it.distribution_band).split(':')[0] : it.count_per_m2 != null ? ' · ' + it.count_per_m2 + '/m²' : '') +
      (it.thickness ? ' · ' + label('thickness', it.thickness).split(':')[0] : '');
    return 'Pit ' + (i + 1) + (it.zone_ref && it.zone_ref !== 'none' ? ' in zone ' + it.zone_ref : '') + (it.pit_depth_cm != null ? ' · ' + it.pit_depth_cm + ' cm deep' : '') +
      (it.subsurface_character ? ' · ' + label('subsurface_character', it.subsurface_character).split(':')[0] : '');
  }
  function renderItems(s) {
    var arr = F[s.items];
    $('scItemsQ').innerHTML = A.esc(s.q) + '<small>' + A.esc(s.sub) + '</small>';
    $('scItemsList').innerHTML = arr.map(function (it, i) {
      return '<button type="button" class="tile seg t-blue" data-i="' + i + '"><span>' + A.esc(itemTitle(s.items, it, i)) + '<small>Tap to edit</small></span></button>';
    }).join('') || '<div class="hint">None yet.</div>';
    $('scItemsAdd').textContent = '+ Add ' + (arr.length ? 'another ' : 'an ') + s.label;
  }
  function openItem(items, i) {
    var arr = F[items];
    if (i == null) { arr.push(items === 'zones' ? { bank_side: '', bank_zone: '', start_lat: null, start_lon: null, oil_character: [], plant_part: [], notes: '' }
                                                : { zone_ref: '', bank_zone: '', start_lat: null, start_lon: null, notes: '' }); i = arr.length - 1; }
    F.sub = { items: items, index: i, data: arr[i], i: 0, skipped: arr[i].skipped_map || {} };
    go(0);
  }
  function closeItem(keep) {
    var sub = F.sub; if (!sub) return;
    if (!keep) F[sub.items].splice(sub.index, 1);
    else { sub.data.skipped = Object.keys(sub.skipped); sub.data.skipped_map = sub.skipped; }
    F.sub = null;
    go(F.i);
  }

  // ---------- STR ----------
  function worse(a, b) { var o = ['A', 'B', 'C', 'D']; if (o.indexOf(a) < 0) return b; if (o.indexOf(b) < 0) return a; return o[Math.max(o.indexOf(a), o.indexOf(b))]; }
  function shift(letter, n) { var o = ['A', 'B', 'C', 'D'], i = o.indexOf(letter); if (i < 0) return letter; return o[Math.max(0, Math.min(3, i + n))]; }
  var CONDITIONS = {
    '': function () { return true; },
    flowing_water: function () { return flowing(); },
    flowing_no_containment: function () { return flowing() && F.containment !== 'yes'; },
    sheltered_bank: function () { return F.current_dominated !== 'yes'; },
    riparian_bank: function () { return ['vegetated_bank', 'wooded_bank', 'marsh_wetland'].indexOf(F.bank_type_primary) >= 0; }
  };
  /** Per-method scores for a shoreline type code and oil category. */
  function strScores(code, cat) {
    var xw = ((cfg && cfg.crosswalk) || []).filter(function (r) { return r.code === code; })[0];
    if (!xw || !cfg.matrix) return null;
    var habs = [xw.primary].concat(xw.rule === 'worst_of' && xw.secondary ? [xw.secondary] : []).filter(function (h) { return cfg.matrix[h]; });
    if (!habs.length) return null;
    var methods = {};
    habs.forEach(function (h) { Object.keys(cfg.matrix[h]).forEach(function (m) { methods[m] = 1; }); });
    return Object.keys(methods).map(function (m) {
      var base = habs.reduce(function (acc, h) { var v = (cfg.matrix[h][m] || {})[cat] || '-'; return acc == null ? v : worse(acc, v); }, null);
      var adj = base, why = [];
      ((cfg && cfg.overrides) || []).forEach(function (o) {
        if (o.method !== m) return;
        if (o.habitat !== '*' && habs.indexOf(o.habitat) < 0) return;
        if (o.oil_category !== '*' && o.oil_category !== cat) return;
        var test = CONDITIONS[o.condition]; if (!test || !test()) return;
        if (o.adjust === 'na') adj = '-'; else if (o.adjust === '+1') adj = shift(adj, 1); else if (o.adjust === '-1') adj = shift(adj, -1);
        else if (o.adjust.indexOf('set:') === 0) adj = o.adjust.slice(4);
        why.push(o.rationale);
      });
      var absence = ((cfg.absence || {})[habs[0]] || {})[m] || '';
      return { method: m, base: base, adjusted: adj, why: why, habitats: habs, absence: absence };
    }).sort(function (a, b) {
      var o = { A: 0, B: 1, C: 2, D: 3, I: 4, '-': 5 };
      return (o[a.adjusted] - o[b.adjusted]) || (o[a.base] - o[b.base]) || a.method.localeCompare(b.method);
    });
  }
  function renderStr() {
    var code = F.bank_type_primary || (F.zones[0] && F.zones[0].substrate_type) || '', cat = F.oil_category;
    var rows = code && cat ? strScores(code, cat) : null;
    $('scStrHead').innerHTML = !code ? '<div class="hint">Pick the bank type (or a zone substrate) and the oil type first, then this screen ranks the treatment options.</div>'
      : !cat ? '<div class="hint">Pick the oil type first.</div>'
      : !rows ? '<div class="hint">No NOAA habitat is mapped for ' + A.esc(shoreLabel(code)) + ' yet.</div>'
      : '<div class="hint">For <b>' + A.esc(shoreLabel(code)) + '</b>, scored by NOAA as <b>' + A.esc(rows[0].habitats.join(' / ')) + '</b>, with ' + A.esc(label('oil_category', cat).toLowerCase()) +
        '. A = least harm to the bank, D = most. Tap the methods you recommend.</div>';
    F.str.scores = rows || [];
    F.str.shore_code = code; F.str.habitats = rows ? rows[0].habitats : [];
    var MEANING = { A: 'Least harm to the bank', B: 'Some harm to the bank', C: 'Significant harm to the bank', D: 'Most harm to the bank', I: 'No guidance for this oil here' };
    var ABSENCE = { C: 'Doing this damages a clean bank', D: 'Doing this badly damages a clean bank' };
    $('scStrList').innerHTML = (rows || []).filter(function (r) { return r.adjusted !== '-'; }).map(function (r) {
      var on = F.str.recommended.indexOf(r.method) >= 0;
      var badge = '<span class="badge t-' + LETTER_TONE[r.adjusted] + '">' + A.esc(r.adjusted) + '</span>';
      var lines = [MEANING[r.adjusted] || ''];
      if (r.adjusted !== r.base) lines.push('NOAA says ' + r.base + '; here ' + r.adjusted + ' because ' + r.why.join('; '));
      var ab = String(r.absence || '').replace('*', '');
      if (ABSENCE[ab]) lines.push(ABSENCE[ab] + (r.absence.indexOf('*') >= 0 ? ' (worse when birds are nesting)' : ''));
      return '<button type="button" class="tile seg' + (on ? ' sel t-green' : '') + '" data-m="' + A.esc(r.method) + '">' + badge + '<span>' + A.esc(r.method) +
        '<small>' + A.esc(lines.filter(Boolean).join(' · ')) + '</small></span>' + (on ? '<span class="ck">✓</span>' : '') + '</button>';
    }).join('');
    $('scStrNA').textContent = rows ? (rows.filter(function (r) { return r.adjusted === '-'; }).length + ' methods not applicable here are hidden.') : '';
    $('scStrNotes').value = F.str.rationale || '';
  }

  // ---------- hallway ----------
  function check1() {
    if (!S.incident) return 'Pick the incident at the top first.';
    if (!F.segment && F.lat == null) return 'Tap a segment or use your location. Either is enough.';
    return '';
  }
  function hasData(s, d) {
    if (s.section === 'where') return true;
    if (s.section === 'team') return !!(d.team_id || d.team_members);
    if (s.section === 'extent') return d.whole_segment === 'yes' || (d.length_surveyed_m != null && d.length_surveyed_m !== '') || d.end_lat != null;
    if (s.section === 'zonegps') return d.start_lat != null;
    if (s.section === 'items') return d[s.items].length > 0;
    if (s.section === 'photos') return d.photos.length > 0;
    if (s.section === 'str') return d.str.recommended.length > 0 || !!d.str.rationale;
    if (s.section === 'notes' || s.section === 'itemnotes') return !!d.notes;
    if (s.key === 'hazards') return !!((d.hazards || []).length || d.hazard_note || d.hazardNote);
    var v = d[s.field];
    return Array.isArray(v) ? v.length > 0 : (v != null && v !== '');
  }
  function go(i) {
    clearTimeout(advancing);
    var scr = screens(), d = data(), last = scr.length - 1;
    i = Math.max(0, Math.min(last, i));
    while (i < last && scr[i].when && !scr[i].when(d)) i++;
    if (i === last && scr[i].when && !scr[i].when(d)) { if (F.sub) { closeItem(true); return; } i = last; }
    setIdx(i); lastGo = Date.now();
    var s = scr[i], vis = scr.filter(function (x) { return !x.when || x.when(d); });
    $('scPhaseBar').classList.toggle('hidden', !F.phase);
    [].forEach.call(document.querySelectorAll('.sstep'), function (el) { el.classList.toggle('active', el.dataset.skey === s.section); });
    $('scProg').style.width = ((vis.indexOf(s) + 1) / vis.length * 100) + '%';
    var isReview = s.key === 'review', subLast = !!F.sub && i === last;
    $('scBack').classList.toggle('hidden', !F.sub && i === 0);
    $('scBack').textContent = F.sub && i === 0 ? 'Cancel' : 'Back';
    $('scSkip').classList.toggle('hidden', !!s.required || isReview);
    $('scNext').classList.toggle('hidden', isReview);
    $('scSave').classList.toggle('hidden', !isReview);
    $('scNext').textContent = subLast ? 'Done' : (s.single && !s.preset && !hasData(s, d) ? 'Tap an answer' : 'Next');
    render();
    window.scrollTo(0, 0);
  }
  function prev() {
    var i = idx(), scr = screens(), d = data();
    if (F.sub && i === 0) { closeItem(hasData(scr[1] || scr[0], d)); return; }
    i--; while (i > 0 && scr[i].when && !scr[i].when(d)) i--;
    go(i);
  }
  function next() {
    var s = cur(), d = data(), skipped = F.sub ? F.sub.skipped : F.skipped;
    if (s.section === 'where') { var m = check1(); if (m) { A.toast(m); return; } }
    if (s.required && !hasData(s, d)) { A.toast(s.section === 'zonegps' ? 'Tap Use My Location: a ' + (F.sub.items === 'pits' ? 'pit' : 'zone') + ' needs a point.' : 'Tap an answer.'); return; }
    if (s.single && !s.preset && !hasData(s, d)) { A.toast('Tap an answer, or Skip.'); return; }
    // Next on an empty optional screen counts as a skip: "skipped, not empty" holds either way
    if (hasData(s, d)) delete skipped[s.key]; else if (!s.required && s.key !== 'review' && s.section !== 'where') skipped[s.key] = true;
    if (F.sub && idx() === screens().length - 1) { closeItem(true); return; }
    go(idx() + 1);
  }
  function skip() {
    var s = cur(), d = data(), skipped = F.sub ? F.sub.skipped : F.skipped;
    if (s.required || s.key === 'review') return;
    if (!hasData(s, d)) skipped[s.key] = true;
    if (F.sub && idx() === screens().length - 1) { closeItem(true); return; }
    go(idx() + 1);
  }
  function render() {
    if (!F) return;
    var s = cur();
    if (!F.phase) { showPhase(); return; }
    $('scPhaseName').textContent = F.phase === 'recon' ? 'Recon SCAT' : 'SCAT Survey';
    if (s.section === 'where') renderWhere();
    if (s.section === 'tiles') renderTileScreen(s);
    if (s.section === 'team') renderTeam();
    if (s.section === 'extent') renderExtent();
    if (s.section === 'items') renderItems(s);
    if (s.section === 'zonegps') renderZoneGps();
    if (s.section === 'itemnotes') { $('scItemNotes').value = data().notes || ''; $('scItemNotesQ').textContent = F.sub.items === 'pits' ? 'Anything else about this pit?' : 'Anything else about this zone?'; }
    if (s.section === 'photos') renderPhotos();
    if (s.section === 'str') renderStr();
    if (s.section === 'notes') { $('scNotes').value = F.notes; $('scTeam').value = F.team; $('scName').value = F.name; $('scOrg').value = F.org; }
    if (s.section === 'review') renderReview();
  }
  function showPhase() {
    [].forEach.call(document.querySelectorAll('.sstep'), function (el) { el.classList.toggle('active', el.dataset.skey === 'phase'); });
    $('scPhaseBar').classList.add('hidden');
    ['scBack', 'scSkip', 'scNext', 'scSave'].forEach(function (id) { $(id).classList.add('hidden'); });
  }
  function setPhase(p) { A.lsSet(PHASE_KEY, p); F = null; reset(); }
  function screensFor(d) { return screens(); }
  /** Test hook (also handy in the console): tap a tile on the current screen by code, or press a nav button. */
  window.__scatTap = function (code) { var b = document.querySelector('.sstep.active .tile[data-code="' + code + '"]'); if (b) b.click(); return !!b; };

  // ---------- photos ----------
  function addPhotos(input) {
    var files = [].slice.call(input.files || []); input.value = '';
    var room = CONFIG.MAX_PHOTOS - F.photos.length;
    if (files.length > room) A.toast('Up to ' + CONFIG.MAX_PHOTOS + ' photos per record. Save another record for more.');
    files.slice(0, Math.max(0, room)).reduce(function (p, f) {
      return p.then(function () { return A.downscale(f); }).then(function (blob) {
        // where and when the photo was taken rides along as the attachment's description
        var meta = JSON.stringify({ t: f.lastModified || Date.now(), lat: F.lat, lon: F.lon, segment: F.segment, phase: F.phase });
        F.photos.push({ blob: blob, name: f.name || 'photo.jpg', url: URL.createObjectURL(blob), meta: meta }); renderPhotos();
      }).catch(function (e) { A.toast(e.message); });
    }, Promise.resolve());
  }
  function renderPhotos() {
    $('scPhotoCount').textContent = F.photos.length ? F.photos.length + ' of ' + CONFIG.MAX_PHOTOS + ' photos' : 'No photos yet';
    $('scPhotoGrid').innerHTML = F.photos.map(function (p, i) {
      return '<div class="ph"><img src="' + p.url + '" alt=""><button type="button" class="rm" data-i="' + i + '">×</button></div>';
    }).join('');
  }

  // ---------- review + save ----------
  function row(k, v, skipped) {
    return '<div class="r"><div class="k">' + A.esc(k) + '</div><div>' + (skipped ? '<span class="skipped">skipped</span>' : A.esc(v || '—')) + '</div></div>';
  }
  function renderReview() {
    var sk = F.skipped, html = row('Incident', S.incident ? S.incident.project_key + ' · ' + S.incident.client_name : '') +
      row('Segment', (F.segment || 'none') + (F.bank ? ' · ' + label('bank_side', F.bank) : '')) +
      row('Location', F.lat != null ? F.lat.toFixed(6) + ', ' + F.lon.toFixed(6) + (F.acc != null ? ' ± ' + F.acc + ' m' : '') : '');
    if (F.phase === 'recon') {
      html += row('Oil', F.oil ? label('oil_present', F.oil) : '', sk.oil) +
        (F.oil === 'yes' || F.oil === 'unsure' ? row('How much', F.extent ? label('oil_extent', F.extent) : '', sk.extent) : '') +
        row('Water', F.trend ? label('water_trend', F.trend) : '', sk.trend) +
        row('Access', F.access ? label('access', F.access) : '', sk.access) +
        row('Hazards', F.hazards.map(function (h) { return label('hazard', h); }).concat(F.hazardNote ? [F.hazardNote] : []).join(' · '), sk.hazards) +
        row('Photos', String(F.photos.length), sk.photos) +
        row('Priority', F.priority ? label('priority', F.priority) : '', sk.priority);
    } else {
      html += row('Survey', [F.survey_kind && label('survey_kind', F.survey_kind), F.water_body && label('water_body', F.water_body)].filter(Boolean).join(' · '), sk.survey_kind && sk.water_body) +
        row('Water', [F.water_level && label('water_level', F.water_level), F.water_trend && label('water_trend', F.water_trend)].filter(Boolean).join(' · '), sk.water_level && sk.water_trend) +
        row('Surveyed', F.whole_segment === 'yes' ? 'Whole segment' : (F.length_surveyed_m ? F.length_surveyed_m + ' m' : ''), sk.extent) +
        row('Bank', [F.bank_type_primary && shoreLabel(F.bank_type_primary), F.overbank_type && ('above: ' + label('overbank_type', F.overbank_type))].filter(Boolean).join(' · '), sk.bank_type) +
        row('Oiled types', F.bank_types_oiled.map(shoreLabel).join(' · '), sk.bank_oiled) +
        row('Access', [F.backshore_access && ('land side ' + F.backshore_access), F.alongshore_access && label('alongshore_access', F.alongshore_access), F.staging_suitable && ('staging ' + F.staging_suitable), F.current_dominated === 'yes' && 'strong current'].filter(Boolean).join(' · ')) +
        row('Hazards', F.hazards.map(function (h) { return label('hazard', h); }).concat(F.hazard_note ? [F.hazard_note] : []).join(' · '), sk.hazards) +
        row('Zones', F.zones.length ? F.zones.map(function (z, i) { return itemTitle('zones', z, i); }).join(' | ') : '', sk.zones) +
        row('Pits', F.pits.length ? F.pits.map(function (p, i) { return itemTitle('pits', p, i); }).join(' | ') : '', sk.pits) +
        row('Photos', String(F.photos.length), sk.photos) +
        row('Wildlife', F.wildlife.map(function (w) { return label('wildlife', w); }).join(' · ') + (F.wildlife_oiled === 'yes' ? ' · OILED' : ''), sk.wildlife) +
        row('Issues', F.issues.map(function (w) { return label('issues', w); }).join(' · '), sk.issues) +
        row('Oil type', F.oil_category ? label('oil_category', F.oil_category) : '', sk.oil_category) +
        row('Recommend', F.str.recommended.join(' · ') + (F.str.rationale ? ' · ' + F.str.rationale : ''), sk.str);
    }
    html += row('Notes', F.notes, sk.notes) + row('Who', [F.name, F.team, F.org].filter(Boolean).join(' · '));
    $('scReview').innerHTML = html;
  }
  function save() {
    try { saveInner(); } catch (e) { A.busy($('scSave'), false); A.toast('Could not save: ' + (e && e.message ? e.message : e), 8000); }
  }
  function saveInner() {
    var m = check1(); if (m) { A.toast(m); F.sub = null; go(0); return; }
    var b = $('scSave'); A.busy(b, true, 'Saving…');
    if (F.team) A.lsSet('wri_scat_team', F.team);
    if (F.name) A.lsSet('wri_scat_name', F.name);
    if (F.org) A.lsSet('wri_scat_org', F.org);
    var fields = { record_type: F.phase === 'recon' ? 'recon' : 'scat_survey', schema_version: '1',
      segment_id: F.segment, bank_side: F.bank, lat: F.lat, lon: F.lon, gps_acc_m: F.acc, captured_at: F.captured,
      team: F.team, user: F.name, organization: F.org, notes: F.notes, skipped: Object.keys(F.skipped) };
    if (F.phase === 'recon') {
      Object.assign(fields, { oil_present: F.oil, oil_extent: F.extent, water_trend: F.trend, access: F.access, hazards: F.hazards.slice(), hazard_note: F.hazardNote, priority: F.priority });
    } else {
      var st = sticky();
      SURVEY.forEach(function (s) { if (s.sticky && s.field) st[s.field] = F[s.field]; });
      st.team_id = F.team_id; st.team_members = F.team_members; A.lsSet(STICKY_KEY, JSON.stringify(st));
      var skipKeys = ['i', 'sub', 'segment', 'segmentLabel', 'bank', 'lat', 'lon', 'acc', 'captured', 'photos', 'skipped', 'team', 'name', 'org', 'notes', 'phase', 'zones', 'pits', 'str'];
      Object.keys(F).forEach(function (k) { if (skipKeys.indexOf(k) < 0) fields[k] = F[k]; });
      fields.zones = F.zones.map(function (z, i) { var o = Object.assign({ zone_id: zoneId(i) }, z); delete o.skipped_map; return o; });
      fields.pits = F.pits.map(function (p, i) { var o = Object.assign({ pit_id: 'P' + (i + 1) }, p); delete o.skipped_map; return o; });
      fields.str = { oil_category: F.oil_category, containment: F.containment, shore_code: F.str.shore_code, habitats: F.str.habitats,
        recommended: F.str.recommended.slice(), rationale: F.str.rationale,
        scores: (F.str.scores || []).map(function (r) { return { method: r.method, base: r.base, adjusted: r.adjusted, why: r.why }; }),
        matrix_source: cfg && cfg.matrix_source };
    }
    var rec = { recon_id: A.uuid(), kind: 'scat', incident: S.incident, fields: fields };
    Outbox.enqueue(rec, F.photos.map(function (p) { return { blob: p.blob, name: p.name, meta: p.meta || '' }; })).then(function () {
      A.busy(b, false);
      try { navigator.serviceWorker && navigator.serviceWorker.ready.then(function (r) { return r.sync && r.sync.register('wri-scat-outbox'); }).catch(function () {}); } catch (e) {}
      showDone(rec.recon_id, { segment: F.segment, segmentLabel: F.segmentLabel, bank: F.bank, lat: F.lat, lon: F.lon, acc: F.acc });
    }, function (e) { A.busy(b, false); A.toast('Could not save on this phone: ' + e.message + '. Free up storage and try again.', 8000); });
  }
  // ---------- saved screen ----------
  var done = null;   // { id, keep } while the Saved screen is up
  function showDone(id, keep) {
    done = { id: id, keep: keep };
    [].forEach.call(document.querySelectorAll('.sstep'), function (el) { el.classList.toggle('active', el.dataset.skey === 'done'); });
    ['scBack', 'scSkip', 'scNext', 'scSave'].forEach(function (k) { $(k).classList.add('hidden'); });
    $('scProg').style.width = '100%';
    renderDone();
    window.scrollTo(0, 0);
  }
  function renderDone() {
    if (!done) return;
    Outbox.list().then(function (rs) {
      var r = rs.filter(function (x) { return x.recon_id === done.id; })[0];
      var st = !r ? '' : r.status === 'sent' ? 'Uploaded' + (r.photos_failed ? ', ' + r.photos_failed + ' photo(s) failed' : '') + '.'
        : r.status === 'needs_pin' ? 'Waiting for the SCAT PIN (enter it at the top of this tab).'
        : r.status === 'failed' ? 'Could not upload: ' + (r.last_error || '') + ' See "Saved" at the top.'
        : navigator.onLine ? 'Uploading now…' + (r.submitted ? ' record is up, photos sending.' : '') : 'No signal: it uploads by itself when you are back in coverage.';
      $('scDoneSub').textContent = st;
    });
  }
  function reset(keep) {
    if (F) F.photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
    done = null;
    F = fresh();
    if (keep) { F.segment = keep.segment; F.segmentLabel = keep.segmentLabel; F.bank = keep.bank; F.lat = keep.lat; F.lon = keep.lon; F.acc = keep.acc; }
    ['scSegSearch', 'scLat', 'scLon', 'scNotes', 'scTileNote', 'scTileNum', 'scItemNotes', 'scStrNotes', 'scExtentNum'].forEach(function (id) { $(id).value = ''; });
    if (F.lat != null) setLoc(F, F.lat, F.lon, F.acc, 'restore', 'scCoords', 'scLat', 'scLon');
    else { $('scCoords').textContent = 'No location yet'; $('scGps').textContent = '📍 Use My Location'; $('scGps').classList.remove('ok'); placeMarker(); }
    $('scEndGps').textContent = '📍 Mark the end'; $('scEndGps').classList.remove('ok');
    $('scLocBox').classList.add('hidden');
    go(keep ? 1 : 0);   // same segment: straight to the first question
  }

  // ---------- my records ----------
  function renderMine() {
    Outbox.list().then(function (rs) {
      var mine = rs.filter(function (r) { return r.kind === 'scat'; }).slice(0, 10);
      $('scList').innerHTML = mine.length ? mine.map(function (r) {
        var st = r.status === 'sent' ? '<span class="s green">Uploaded' + (r.photos_failed ? ' · ' + r.photos_failed + ' photo(s) failed' : '') + '</span>'
          : r.status === 'needs_pin' ? '<span class="s red">Waiting for the incident PIN</span>'
          : r.status === 'failed' ? '<span class="s red">' + A.esc(r.last_error || 'Could not upload') + '</span>'
          : '<span class="s amber">' + (r.submitted ? 'Record uploaded · photos sending' : 'Waiting to upload') + (r.last_error ? ' (' + A.esc(r.last_error) + ')' : '') + '</span>';
        return '<div class="item"><div class="t">' + A.esc(A.recordTitle(r)) + '</div><div>' + new Date(r.created_at).toLocaleString() +
          ' · ' + A.esc(r.incident ? r.incident.project_key : '') + (r.photo_count ? ' · ' + r.photo_count + ' photo(s)' : '') + '</div><div>' + st + '</div></div>';
      }).join('') : '<div class="hint">Nothing yet.</div>';
    });
  }

  // ---------- SCAT's own PIN (FORM_KINDS.scat.pin_scope) ----------
  // The incident Gateway PIN never goes to the SCAT API. While the API is a sandbox it has its own
  // PIN, asked for here; records wait (needs_pin, SCAT only) until it is right.
  var SCOPE = (window.FORM_KINDS && FORM_KINDS.scat && FORM_KINDS.scat.pin_scope) || '';
  function checkPin() {
    if (!SCOPE || !CONFIG.SCAT_API) { $('scPinBox').classList.add('hidden'); return; }
    Promise.all([Outbox.scopedPinFor(SCOPE), Outbox.needsScopedPin(SCOPE)]).then(function (a) {
      var show = !a[0] || a[1] > 0;
      $('scPinBox').classList.toggle('hidden', !show);
      if (show) $('scPinMsg').textContent = a[1] > 0 ? 'The SCAT PIN is wrong or has changed: ' + a[1] + ' record(s) are waiting. Enter the current SCAT PIN.' : 'Enter the SCAT PIN.';
    });
  }
  function submitScatPin() {
    var pin = $('scPinInput').value.trim(), b = $('scPinBtn'); if (!pin) return;
    var done = function () { $('scPinInput').value = ''; return Outbox.setScopedPin(SCOPE, pin).then(checkPin); };
    if (!navigator.onLine) { done(); A.toast('PIN saved. It is checked when you are back in signal.'); return; }
    A.busy(b, true, 'Checking…');
    Store.deviceId().then(function (device) { return Api.post('pin', { pin: pin, device: device }, 20000, CONFIG.SCAT_API); }).then(function () {
      A.busy(b, false); A.toast('SCAT PIN accepted.'); return done();
    }, function (e) {
      A.busy(b, false);
      if (e.code === 'pin_invalid' || e.code === 'pin_locked') { $('scPinMsg').textContent = e.message; return; }
      // the API did not answer as itself: say so and keep the box, rather than saving a PIN that was never checked
      $('scPinMsg').textContent = 'Could not reach the SCAT API (' + (e.message || e.code) + '). Check the signal, or the link that switched the tab on, and try again.';
    });
  }

  // ---------- API status line (what the phone sees) ----------
  var apiState = { ok: null, msg: '', at: 0 };
  function renderApiStatus() {
    var el = $('scApiStatus'); if (!el) return;
    if (!CONFIG.SCAT_API) { el.textContent = ''; return; }
    var n = (cfg && cfg.segments) ? cfg.segments.length : 0, lists = cfg && cfg.lists ? Object.keys(cfg.lists).length : 0;
    var tail = String(CONFIG.SCAT_API).replace(/^.*\/s\//, '…/').slice(0, 14) + '…' + String(CONFIG.SCAT_API).slice(-5);
    if (apiState.ok === true) el.innerHTML = 'Lists loaded: ' + n + ' segments, ' + lists + ' lists. API ' + A.esc(tail);
    else if (apiState.ok === false) el.innerHTML = '<span style="color:#ff9a9d">Could not load the SCAT lists from ' + A.esc(tail) + ': ' + A.esc(apiState.msg) + '</span> <button class="link" id="scApiRetry" type="button">Retry</button>';
    else el.innerHTML = cfg ? 'Lists from the last visit.' : 'Loading the SCAT lists…';
  }

  // ---------- cached config ----------
  function loadCfg() {
    return Store.kvGet('cfg_scat').then(function (c) {
      if (c) { cfg = c; render(); }
      if (!navigator.onLine || !CONFIG.SCAT_API) { renderApiStatus(); return; }
      apiState.at = Date.now();
      return fetch(String(CONFIG.SCAT_API).trim() + '?api=config', { redirect: 'follow' }).then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = JSON.parse(t.replace(/^﻿/, '')); } catch (e) {}
          if (!j) throw new Error('HTTP ' + r.status + ', not JSON (' + t.slice(0, 40).replace(/\s+/g, ' ') + '…)');
          if (!j.ok) throw new Error(j.message || j.error || 'API error');
          return j;
        });
      }).then(function (j) {
        apiState.ok = true; apiState.msg = '';
        if (!c || j.data.version !== c.version) { cfg = j.data; render(); return Store.kvSet('cfg_scat', j.data).then(renderApiStatus); }
        renderApiStatus();
      }).catch(function (e) { apiState.ok = false; apiState.msg = e && e.message ? e.message : String(e); renderApiStatus(); });
    }).catch(function () {});
  }

  // ---------- boot ----------
  function boot() {
    A = window.WRIApp; $ = A.$; S = A.S;
    if (!$('scSegSearch')) return;
    F = fresh();
    $('scPhaseTiles').addEventListener('click', function (e) { var b = e.target.closest('.tile'); if (b) setPhase(b.dataset.code); });
    $('scPhaseChange').addEventListener('click', function () { A.lsSet(PHASE_KEY, ''); F.phase = ''; showPhase(); });
    $('scSegSearch').addEventListener('input', renderSegments);
    $('scSegList').addEventListener('click', function (e) { var b = e.target.closest('button[data-id]'); if (b) pickSegment(b.dataset.id); });
    $('scSegTyped').addEventListener('click', function () {
      var v = $('scSegSearch').value.trim().toUpperCase(), b = this; if (!v) return;
      // Caleb's segment ID shape: RIVER-mile-bank-letter, e.g. YEL-7.5-RB-A. Anything else needs a second tap.
      if (!/^[A-Z]{3}-\d+(\.\d)?-(LB|RB|MC)-[A-Z]$/.test(v) && b.dataset.armed !== v) {
        b.dataset.armed = v; b.textContent = '"' + v + '" is not a segment ID like YEL-7.5-RB-A. Tap again to use it anyway';
        setTimeout(function () { b.dataset.armed = ''; b.textContent = 'Not in the list: use what I typed as the segment ID'; }, 5000); return;
      }
      b.dataset.armed = ''; b.textContent = 'Not in the list: use what I typed as the segment ID'; pickSegment(v);
    });
    $('scSegPicked').addEventListener('click', function (e) { if (e.target.id === 'scSegClear') { F.segment = ''; F.segmentLabel = ''; renderWhere(); } });
    $('scBank').addEventListener('click', function (e) { var b = e.target.closest('.tile'); if (b) { F.bank = F.bank === b.dataset.code ? '' : b.dataset.code; renderWhere(); } });
    $('scGps').addEventListener('click', function () { gps('scGps', function (la, lo, acc) { setLoc(F, la, lo, acc, 'gps', 'scCoords', 'scLat', 'scLon'); }); });
    $('scTypeLoc').addEventListener('click', function () { $('scLocBox').classList.toggle('hidden'); });
    $('scLat').addEventListener('input', typed); $('scLon').addEventListener('input', typed);
    ['scLatHemi', 'scLonHemi'].forEach(function (id) {
      $(id).addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; [].forEach.call($(id).children, function (x) { x.classList.toggle('active', x === b); }); typed(); });
    });
    $('scTiles').addEventListener('click', function (e) { var b = e.target.closest('.tile'); if (b) onTile(b.dataset.code); });
    $('scTileNum').addEventListener('input', function () { var s = cur(); if (s.preset) data()[s.field] = this.value === '' ? '' : Number(this.value); });
    $('scTileNote').addEventListener('input', function () { var s = cur(); if (s.note) data()[s.note.field] = this.value; });
    $('scTeamId').addEventListener('input', function () { F.team_id = this.value.trim(); });
    $('scTeamMembers').addEventListener('input', function () { F.team_members = this.value; });
    $('scExtentTiles').addEventListener('click', function (e) { var b = e.target.closest('.tile'); if (b) onExtentTile(b.dataset.code); });
    $('scExtentNum').addEventListener('input', function () { F.length_surveyed_m = this.value === '' ? '' : Number(this.value); });
    $('scEndGps').addEventListener('click', function () { gps('scEndGps', function (la, lo) { F.end_lat = la; F.end_lon = lo; $('scEndGps').textContent = '📍 End marked ✓'; renderExtent(); }); });
    $('scItemsAdd').addEventListener('click', function () { openItem(cur().items, null); });
    $('scItemsList').addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (b) openItem(cur().items, Number(b.dataset.i)); });
    $('scZGps').addEventListener('click', function () { gps('scZGps', function (la, lo, acc) { var d = data(); d.start_lat = la; d.start_lon = lo; d.start_acc = Math.round(acc); renderZoneGps(); }); });
    $('scZEndGps').addEventListener('click', function () { gps('scZEndGps', function (la, lo) { var d = data(); d.end_lat = la; d.end_lon = lo; renderZoneGps(); }); });
    $('scItemNotes').addEventListener('input', function () { data().notes = this.value; });
    $('scItemRemove').addEventListener('click', function () { if (F.sub) closeItem(false); });
    $('scStrList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-m]'); if (!b) return;
      var i = F.str.recommended.indexOf(b.dataset.m); if (i >= 0) F.str.recommended.splice(i, 1); else F.str.recommended.push(b.dataset.m);
      renderStr();
    });
    $('scStrNotes').addEventListener('input', function () { F.str.rationale = this.value; });
    $('scCam').addEventListener('click', function () { $('scCamInput').click(); });
    $('scGal').addEventListener('click', function () { $('scGalInput').click(); });
    $('scCamInput').addEventListener('change', function () { addPhotos(this); });
    $('scGalInput').addEventListener('change', function () { addPhotos(this); });
    $('scPhotoGrid').addEventListener('click', function (e) {
      var b = e.target.closest('.rm'); if (!b) return;
      var p = F.photos.splice(Number(b.dataset.i), 1)[0]; if (p) URL.revokeObjectURL(p.url); renderPhotos();
    });
    $('scNotes').addEventListener('input', function () { F.notes = this.value; });
    $('scTeam').addEventListener('input', function () { F.team = this.value.trim(); });
    $('scName').addEventListener('input', function () { F.name = this.value.trim(); });
    $('scOrg').addEventListener('input', function () { F.org = this.value.trim(); });
    $('scNext').addEventListener('click', next);
    $('scSkip').addEventListener('click', skip);
    $('scBack').addEventListener('click', prev);
    $('scSave').addEventListener('click', save);
    $('scDoneSame').addEventListener('click', function () { reset(done && done.keep); });
    $('scDoneNew').addEventListener('click', function () { reset(); });
    var onOutbox = function () { if (F && F.phase && !F.sub && cur().section === 'where') renderMine(); if (done) renderDone(); checkPin(); };
    window.addEventListener('outbox:changed', onOutbox);
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'outbox:changed') onOutbox(); });
    $('scPinBtn').addEventListener('click', submitScatPin);
    $('scPinInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitScatPin(); });
    checkPin();
    window.addEventListener('incident:changed', function () { if (F && F.phase && !F.sub && cur().section === 'where') renderSegments(); });
    window.addEventListener('online', loadCfg);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && apiState.ok !== true && Date.now() - apiState.at > 15000) loadCfg(); });
    $('scApiStatus').addEventListener('click', function (e) { if (e.target.id === 'scApiRetry') { apiState.ok = null; renderApiStatus(); loadCfg(); } });
    loadCfg();
    go(0);
  }
  window.ScatUI = { render: function () { render(); } };
  document.addEventListener('DOMContentLoaded', boot);
})();
