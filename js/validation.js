// SOLUS — Validation window. Every number here is read from regions/<id>/validation.json, written by
// the offline pipeline (code/03_validation.py); the figures are the pipeline's own PNGs.

import { DATA_ROOT, REGION_ORDER } from './config.js';
import { fetchDataJSON } from './data.js';

const cache = {};
export async function loadAllValidation() {
  await Promise.all(REGION_ORDER.map(async (id) => {
    if (cache[id] !== undefined) return;
    cache[id] = await fetchDataJSON(`${DATA_ROOT}/regions/${id}/validation.json`);
  }));
  return cache;
}

const num = (v, d = 1) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
const deg = (v, d = 1) => (v == null ? '—' : `${num(v, d)}°`);
const pc = (v) => (v == null ? '—' : `${+v < 1 && +v > 0 ? num(v, 2) : num(v, 1)}%`);
const sgn = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}°`);
const minus = (s) => s.replace(/^-/, '−');
const range = (arr, f = (x) => x.toFixed(1)) => {
  const a = arr.filter((x) => x != null && isFinite(x));
  if (!a.length) return '—';
  const lo = Math.min(...a), hi = Math.max(...a);
  if (lo === hi) return minus(f(lo));
  return lo < 0 ? `${minus(f(lo))} to ${minus(f(hi))}` : `${f(lo)}–${f(hi)}`;
};
const demName = (d) => `${d.camera || (d.dem_id.startsWith('hirise') ? 'HiRISE' : 'CTX')} set ${d.dem_id.split('_')[1]}`;
/** The baseline the app uses for a DEM: 5 m for HiRISE, 18 m for CTX. */
const primaryKey = (d) => (d.dem_id.startsWith('hirise') ? '5m' : '18m');
const cls = (c) => (c ? `${num(c.ok, 1)} / ${num(c.caution, 1)} / <b>${num(c.nogo, c.nogo < 1 && c.nogo > 0 ? 2 : 1)}</b>` : '—');

function summary(V) {
  const out = [];
  const rows = (id) => (V[id]?.rover_path?.per_dem || []).filter((d) => d.dem_slope_vs_rover_tilt_at_waypoints?.[primaryKey(d)]);
  const diffs = (id) => rows(id).map((d) => Math.abs(d.dem_slope_vs_rover_tilt_at_waypoints[primaryKey(d)].median_diff));
  const nogo = (id) => (V[id]?.rover_path?.per_dem || []).filter((d) => d.classification_along_traverse).map((d) => d.classification_along_traverse.rover.nogo);
  const tilt = (id) => V[id]?.rover_path?.rover_measured_tilt_deg;
  if (V.jezero || V.gale) {
    out.push(`<li><b>Typical slopes agree with what the rovers felt.</b> At the rovers' own waypoints, the median difference between the elevation-model slope and the tilt the rover recorded on board is ${range(diffs('jezero'))}° in Jezero (Perseverance) and ${range(diffs('gale'))}° in Gale (Curiosity), at the baselines SOLUS uses (HiRISE 5 m, CTX 18 m).</li>`);
    out.push(`<li><b>The approved limits rarely call driven terrain no-go.</b> In Rover mode, ${range(nogo('jezero'), (x) => x.toFixed(x < 1 ? 2 : 1))}% of Perseverance's path and ${range(nogo('gale'), (x) => x.toFixed(x < 1 ? 2 : 1))}% of Curiosity's path is no-go, depending on the elevation model. By the rovers' own recorded tilt: ${pc(tilt('jezero')?.classification?.rover?.nogo)} (Perseverance, max ${deg(tilt('jezero')?.max)}, sol ${tilt('jezero')?.sol_of_max ?? '—'}) and ${pc(tilt('gale')?.classification?.rover?.nogo)} (Curiosity, max ${deg(tilt('gale')?.max)}, sol ${tilt('gale')?.sol_of_max ?? '—'}). The extra no-go is the elevation models' steep tail, which the next point shows is overstated.</li>`);
    const h = (V.jezero?.rover_path?.per_dem || []).filter((d) => d.dem_id.startsWith('hirise') && d.dem_slope_vs_rover_tilt_at_waypoints?.['1m']);
    if (h.length) {
      const bits = h.map((d) => { const w = d.dem_slope_vs_rover_tilt_at_waypoints; const s = (k, f) => w[k]?.[f]?.['20']; return `set ${d.dem_id.split('_')[1]}: ${pc(s('1m', 'pct_waypoints_dem_slope_above_deg'))} at 1 m → ${pc(s('5m', 'pct_waypoints_dem_slope_above_deg'))} at 5 m (rover recorded ${pc(s('5m', 'pct_waypoints_rover_tilt_above_deg'))})`; });
      out.push(`<li><b>Raw 1 m slope exaggerates steep ground, so HiRISE slope uses a 5 m baseline.</b> Share of Perseverance waypoints at or above 20°: ${bits.join('; ')}. Set 1159 is the best-behaved HiRISE model, so it is the featured detailed model in Jezero.</li>`);
    }
  }
  const pairs = REGION_ORDER.flatMap((id) => V[id]?.hirise_vs_ctx_slope_18m_baseline?.pairs || []);
  if (pairs.length) {
    out.push(`<li><b>The two cameras agree on average, not cell by cell.</b> HiRISE vs CTX at the same 18 m baseline, ${pairs.length} pairs: median difference ${range(pairs.map((p) => p.diff_hirise18_minus_ctx_deg.median), (x) => x.toFixed(2))}°, but single cells scatter (RMSE ${range(pairs.map((p) => p.diff_hirise18_minus_ctx_deg.rmse))}°). A single cell's slope is uncertain by several degrees.</li>`);
  }
  out.push('<li><b>Map projection error is negligible:</b> at most 0.04° on a 45° slope (worst case, CTX set 1159 at the far corner of its strip; processing report §4).</li>');
  return `<ul>${out.join('')}</ul>`;
}

function waypointTable(v) {
  const rp = v?.rover_path; if (!rp) return '';
  const rows = [];
  for (const d of rp.per_dem) {
    const w = d.dem_slope_vs_rover_tilt_at_waypoints; if (!w) continue;
    for (const k of [primaryKey(d), ...(d.dem_id.startsWith('hirise') ? ['1m'] : [])]) {
      const x = w[k]; if (!x) continue;
      const cmp = k !== primaryKey(d);
      rows.push(`<tr class="${cmp ? 'cmp' : ''}"><td>${demName(d)}</td><td>${k.replace('m', ' m')}${cmp ? ' <i>(comparison)</i>' : ''}</td><td>${x.n}</td>
        <td>${deg(x.median_dem_slope)} / ${deg(x.median_rover_tilt)}</td><td>${sgn(x.median_diff)}</td>
        <td>${pc(x.pct_waypoints_dem_slope_above_deg?.['20'])} / ${pc(x.pct_waypoints_rover_tilt_above_deg?.['20'])}</td></tr>`);
    }
  }
  if (!rows.length) return '';
  return `<table><tr><th>Elevation model</th><th>Slope baseline</th><th>Waypoints</th><th>Median slope: model / rover tilt</th><th>Median difference</th><th>≥ 20°: model / rover</th></tr>${rows.join('')}</table>`;
}

function pathTable(v) {
  const rp = v?.rover_path; if (!rp) return '';
  const rows = rp.per_dem.filter((d) => d.classification_along_traverse).map((d) =>
    `<tr><td>${demName(d)} (${d.baseline_m} m)</td><td>${num(d.valid_length_km, 2)} km</td><td>${cls(d.classification_along_traverse.rover)}</td><td>${cls(d.classification_along_traverse.marswalk)}</td></tr>`);
  const t = rp.rover_measured_tilt_deg;
  if (t?.classification) rows.push(`<tr class="truth"><td>Rover's own on-board tilt</td><td>${t.n} waypoints</td><td>${cls(t.classification.rover)}</td><td>${cls(t.classification.marswalk)}</td></tr>`);
  return `<table><tr><th>Along the real path</th><th>Path with a slope value</th><th>Rover mode: ok / caution / <b>no-go</b> (%)</th><th>Marswalk: ok / caution / <b>no-go</b> (%)</th></tr>${rows.join('')}</table>`;
}

function pairTable(V) {
  const rows = REGION_ORDER.flatMap((id) => (V[id]?.hirise_vs_ctx_slope_18m_baseline?.pairs || []).map((p) =>
    `<tr><td>${id.replace('_', ' ')}</td><td>set ${p.set_id}</td><td>${p.cells_compared.toLocaleString('en-US')}</td><td>${sgn(p.diff_hirise18_minus_ctx_deg.median)}</td><td>${deg(p.diff_hirise18_minus_ctx_deg.rmse)}</td><td>${num(p.pearson_r, 2)}</td><td>${pc(p.class_agreement_pct?.['15'])}</td></tr>`));
  if (!rows.length) return '';
  return `<table><tr><th>Region</th><th>Pair</th><th>18 m cells</th><th>Median difference</th><th>RMSE</th><th>Correlation r</th><th>Same side of 15°</th></tr>${rows.join('')}</table>`;
}

const fig = (file, caption) => `<figure><a href="${DATA_ROOT}/reports/figures/${file}" target="_blank" rel="noopener"><img src="${DATA_ROOT}/reports/figures/${file}" alt="${caption}" onerror="this.closest('figure').remove()"></a><figcaption>${caption}</figcaption></figure>`;

export function validationHTML(V, esc) {
  const nope = new Set();
  for (const id of ['jezero', 'gale']) for (const s of V[id]?.rover_path?.what_this_does_not_prove || []) nope.add(s);
  nope.add('Rover tilt is recorded only where a drive ended, not continuously, and a waypoint position can be off by a few metres relative to the elevation model.');
  nope.add('West Candor Chasma has no rover, so nothing there is validated against ground truth. In Gale, no HiRISE model covers Curiosity\'s route, so Gale is validated at 18 m only.');
  const any = REGION_ORDER.some((id) => V[id]);
  if (!any) return '<p class="muted">validation.json not found in the processed data.</p>';
  return `<h2>Validation against real rovers</h2>
    <p class="lead">Slopes computed from the orbital elevation models, compared with the tilt that Perseverance and Curiosity recorded on board at the end of each drive (NASA/JPL MMGIS waypoint files). Numbers from the processing pipeline's validation files.</p>
    ${summary(V)}
    <p><button class="btn" data-run-traverse>Run it live: assess the real rover traverse with the current limits</button></p>
    <h3>Jezero · Perseverance: model slope vs on-board tilt at the same waypoints</h3>${waypointTable(V.jezero)}
    <h3>Jezero · the approved limits along Perseverance's path</h3>${pathTable(V.jezero)}
    <h3>Gale · Curiosity: model slope vs on-board tilt</h3>${waypointTable(V.gale)}
    <h3>Gale · the approved limits along Curiosity's path</h3>${pathTable(V.gale)}
    <h3>HiRISE vs CTX at the same 18 m baseline</h3>${pairTable(V)}
    <div class="figs">
      ${fig('traverse_slope_jezero.png', 'Jezero: slope along Perseverance\'s traverse vs recorded tilt')}
      ${fig('traverse_slope_gale.png', 'Gale: slope along Curiosity\'s traverse vs recorded tilt')}
      ${fig('slope18_jezero_hirise_1159_vs_ctx_1159.png', 'Jezero set 1159: HiRISE vs CTX slope at 18 m')}
    </div>
    <h3>What this does not prove</h3><ul>${[...nope].map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <p class="muted">Source: SOLUS processing pipeline (contract ${esc(V.jezero?.contract_version || V.gale?.contract_version || '1.1')}), code/03_validation.py, computed from NASA MRO HiRISE/CTX DEMs (Day et al. 2023) and NASA/JPL MMGIS rover data.</p>`;
}
