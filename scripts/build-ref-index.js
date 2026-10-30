/* Build ref/index.json from the NOAA job-aid image index (ref/source/job_aid_image_index.csv) and the
 * resized images in ref/img (sizes from ref/sizes.csv, written by the resize step).
 *
 *   node scripts/build-ref-index.js
 *
 * Each item carries `targets`: the hallway screens it illustrates, as "<key>:<code>" where key is the
 * list name of a tile screen (oil_extent, distribution_band, thickness, oil_character,
 * subsurface_character), "shore" for the shoreline-type screens (codes from SCAT_ShoreTypes), or
 * "methods" for the treatment recommendation (code = start of the NOAA matrix method name).
 * "<key>:*" means reference only for that screen: shown, but tapping it picks nothing.
 */
'use strict';
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var csvPath = path.join(root, 'ref', 'source', 'job_aid_image_index.csv');
var sizesPath = path.join(root, 'ref', 'sizes.csv');

function csv(text) {
  var rows = [], row = [], f = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  var h = rows.shift();
  return rows.filter(function (r) { return r.length > 1; }).map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i] || ''; }); return o; });
}

/* ref_id -> targets. Distribution photos serve both the recon extent screen and the zone band screen. */
var T = {
  dist_continuous: ['oil_extent:continuous', 'distribution_band:continuous'],
  dist_broken: ['oil_extent:broken', 'distribution_band:broken'],
  dist_patchy: ['oil_extent:patchy', 'distribution_band:patchy'],
  dist_sporadic: ['oil_extent:sporadic', 'distribution_band:sporadic'],
  chart_percent_cover_bands: ['oil_extent:*', 'distribution_band:*'],
  chart_percent_cover_discrete: ['oil_extent:*', 'distribution_band:*'],
  thick_pooled: ['thickness:thick'], thick_cover: ['thickness:cover'], thick_coat: ['thickness:coat'],
  thick_stain: ['thickness:stain'], thick_film: ['thickness:film', 'sheen_color:*'],
  type_fresh: ['oil_character:fresh'], type_mousse: ['oil_character:mousse'], type_tarballs: ['oil_character:tar_balls'],
  type_patties: ['oil_character:patties'], type_tar: ['oil_character:tar'], type_surface_residue: ['oil_character:surface_residue'],
  type_asphalt: ['oil_character:asphalt'],
  sub_sap: ['subsurface_character:*'], sub_op: ['subsurface_character:oil_filled_pores'], sub_pp: ['subsurface_character:partially_filled_pores'],
  sub_or: ['subsurface_character:oil_residue'], sub_of: ['subsurface_character:oil_film'],
  sed_bedrock: ['shore:bedrock_cliff', 'shore:bedrock_ramp'], sed_boulder: ['shore:boulder'], sed_cobble: ['shore:cobble_gravel'],
  sed_pebble: ['shore:cobble_gravel'], sed_granule: ['shore:mixed_coarse'], sed_sand: ['shore:sand'], sed_mud: ['shore:silt_clay_bank', 'shore:mud_flat'],
  esi_1: ['shore:bedrock_cliff'], esi_2: ['shore:bedrock_ramp'], esi_3: ['shore:sand'], esi_4: ['shore:sand'], esi_5: ['shore:mixed_coarse'],
  esi_6a: ['shore:cobble_gravel'], esi_6b: ['shore:riprap'], esi_7: ['shore:mud_flat'], esi_8a: ['shore:*'], esi_8b: ['shore:manmade_solid'],
  esi_9: ['shore:mud_flat'], esi_10a: ['shore:marsh_wetland'], esi_10b: ['shore:marsh_wetland'], esi_10c: ['shore:wooded_bank', 'shore:marsh_wetland'], esi_10d: ['shore:*'],
  meth_barriers: ['methods:Barriers/Berms'], meth_herding: ['methods:Physical Herding'], meth_manual: ['methods:Manual Oil Removal/Cleaning'],
  meth_mechanical: ['methods:Mechanical Oil Removal'], meth_sorbents: ['methods:Sorbents'], meth_vacuum: ['methods:Vacuum'],
  meth_debris: ['methods:Debris Removal'], meth_tilling: ['methods:Sediment Reworking/Tilling'], meth_vegcut: ['methods:Vegetation Cutting/Removal'],
  meth_flooding: ['methods:Flooding (deluge)'], meth_lowflush: ['methods:Low-pressure, Ambient Water Flushing'],
  meth_highflush: ['methods:High-pressure, Ambient Water Flushing'], meth_hotflush: ['methods:High-pressure, Hot Water Flushing', 'methods:Low-pressure, Hot Water Flushing']
};

var sizes = {};
fs.readFileSync(sizesPath, 'utf8').split(/\r?\n/).forEach(function (l) { var p = l.split(','); if (p[0]) sizes[p[0]] = { w: +p[1], h: +p[2], bytes: +p[3] }; });

var items = csv(fs.readFileSync(csvPath, 'utf8')).map(function (r) {
  var file = r.file.replace(/\.png$/i, '.jpg'), sz = sizes[file];
  if (!sz) throw new Error('no resized image for ' + file);
  if (!T[r.ref_id]) throw new Error('no targets for ' + r.ref_id);
  var it = { id: r.ref_id, file: file, w: sz.w, h: sz.h, category: r.category, label: r.label, caption: r.noaa_caption, noaa: r.legacy_code, targets: T[r.ref_id] };
  if (/^esi_/.test(r.ref_id)) it.marine = true;
  if (/^chart_/.test(r.ref_id)) it.chart = true;
  return it;
});

var out = {
  version: '2026-10-30-a',
  source: 'NOAA Shoreline Assessment Job Aid, September 2014 (Office of Response and Restoration)',
  credit: 'Photos: NOAA Shoreline Assessment Job Aid (Sept 2014), contributed by M.O. Hayes and J. Michel, Research Planning Inc. Percent-cover charts: Owens and Sergy 1994, Environment Canada, as reproduced by NOAA.',
  license_note: 'Reproduced for field reference. Photo permission from Research Planning Inc. requested, not yet confirmed (2026-10-30).',
  items: items
};
fs.writeFileSync(path.join(root, 'ref', 'index.json'), JSON.stringify(out, null, 1));
var total = items.reduce(function (a, it) { return a + sizes[it.file].bytes; }, 0);
console.log(items.length + ' items, ' + (total / 1024 / 1024).toFixed(2) + ' MB of images');
