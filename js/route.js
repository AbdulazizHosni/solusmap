// SOLUS — route assessment.
// Samples the pre-computed NASA-derived grids along a route and reports what the data supports.
// It never declares a route safe: it reports caution / no-go stretches, data gaps, areas outside
// every elevation model, crater-rim crossings and the walk-back distance rule.

import { densify, distance, pathLength, fmtDist, M_PER_DEG } from './geo.js';
import { prefetch, sampleAt, levelFor, severityFor, thresholds, suspectNear } from './data.js';
import { ROUTE, SPEEDS_KMH } from './config.js';

const RANK = { ok: 0, caution: 1, nogo: 2 };

/** Catalogue circles are best fits to the rim; for large, eroded craters they can miss the visible rim
 *  (Jezero's entry 13-000115 sits several km east of the rim seen in the CTX imagery). */
export const LARGE_CRATER_KM = 10;
export const LARGE_CRATER_NOTE = 'For a large, eroded crater the catalogue circle is a best fit and can lie kilometres from the rim visible in the imagery, and the rim slope is measured along that circle: compare with the imagery.';

/** Rim slope fields of a crater feature (craters.geojson keeps them in `rim_best`; hazards.geojson flat). */
export function rimOf(p) {
  const b = p.rim_best || {};
  return {
    p95: b.rim_slope_p95_deg ?? p.rim_slope_p95_deg ?? null,
    max: b.rim_slope_max_deg ?? p.rim_slope_max_deg ?? null,
    coverage: b.rim_coverage_pct ?? p.rim_coverage_pct ?? null,
    dem: b.dem_id ?? p.dem_id ?? null,
    camera: b.camera ?? p.camera ?? null,
    baseline_m: b.baseline_m ?? p.baseline_m ?? null,
    set_id: b.set_id ?? p.set_id ?? null,
    max_on_suspect: b.max_on_suspect ?? null,
  };
}

/**
 * Assess a route.
 * @param R       region bundle
 * @param input   one polyline [[lon,lat],...] or several parts [[[lon,lat],...], ...] (e.g. a rover traverse)
 * @param mode    'rover' | 'marswalk'
 * @param opts    walkback: true (false for a robotic rover traverse, where the rule does not apply);
 *                flagLevels: ['caution', 'nogo'] (levels that get a numbered flag; every level is always in the totals)
 */
export async function analyzeRoute(R, input, mode, onProgress = () => {}, opts = {}) {
  const parts = (Array.isArray(input[0]?.[0]) ? input : [input]).filter((p) => p.length > 1);
  const length = parts.reduce((s, p) => s + pathLength(p), 0);
  const step = Math.max(ROUTE.minStep, length / ROUTE.maxSamples);
  const samples = [];
  let offset = 0;
  parts.forEach((p, k) => {
    for (const s of densify(p, step)) { s.d += offset; s.part = k; samples.push(s); }
    offset += pathLength(p);
  });

  onProgress('Loading terrain tiles…');
  await prefetch(R, samples, (d, n) => onProgress(`Loading terrain tiles… ${d}/${n}`));

  onProgress('Assessing route…');
  const T = thresholds().modes[mode];
  const start = parts[0][0];
  for (const s of samples) {
    Object.assign(s, sampleAt(R, s.lon, s.lat));
    if (s.status === 'loading') Object.assign(s, { status: 'unknown', loadFailed: true }); // tile failed to load: never guess
    s.level = s.status === 'ok' ? levelFor(s.slope, mode) : s.status; // ok|caution|nogo|unknown|outside
    s.fromStart = distance(start, [s.lon, s.lat]);
  }

  // length per class: each sample stands for the half-steps around it (within its own part)
  const totals = { ok: 0, caution: 0, nogo: 0, unknown: 0, outside: 0 };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = samples[i - 1], next = samples[i + 1];
    const a = prev && prev.part === s.part ? (s.d - prev.d) / 2 : 0;
    const b = next && next.part === s.part ? (next.d - s.d) / 2 : 0;
    totals[s.level] += a + b;
  }

  const flags = [];

  // 1) steep stretches (caution or no-go), merged across short gaps, never across parts
  const flagLevels = new Set(opts.flagLevels || ['caution', 'nogo']);
  let run = null;
  const closeRun = () => {
    if (!run) return;
    const peak = run.peak;
    flags.push({
      type: 'steep_slope', level: run.level, value: peak.slope, d: peak.d, lon: peak.lon, lat: peak.lat,
      length_m: Math.max(step, run.end - run.start), start_d: run.start, end_d: run.end,
      dem: peak.dem, camera: peak.camera, baseline_m: peak.baseline_m, set_id: peak.set_id,
      severity: severityFor(peak.slope), nogo_m: run.nogo_m,
    });
    run = null;
  };
  for (const s of samples) {
    const steep = flagLevels.has(s.level);
    if (run && (s.part !== run.part)) closeRun();
    if (steep) {
      if (run && s.d - run.end > ROUTE.mergeGap) closeRun();
      if (!run) run = { start: s.d, end: s.d, level: s.level, peak: s, part: s.part, nogo_m: 0 };
      if (s.level === 'nogo') run.nogo_m += step; // approximate: one sample spacing per no-go sample
      run.end = s.d;
      if (RANK[s.level] > RANK[run.level]) run.level = s.level;
      if (s.slope > run.peak.slope) run.peak = s;
    }
  }
  closeRun();

  // 2) data gaps and stretches without any elevation model
  for (const kind of ['unknown', 'outside']) {
    let g = null;
    const close = () => {
      if (g && g.end - g.start >= (kind === 'unknown' ? ROUTE.minUnknownRun : step)) {
        const mid = samples[Math.floor((g.i0 + g.i1) / 2)];
        const dems = [...g.dems];
        flags.push({ type: kind === 'unknown' ? 'data_gap' : 'no_coverage', level: kind, d: mid.d, lon: mid.lon, lat: mid.lat,
          length_m: g.end - g.start, start_d: g.start, end_d: g.end, dem: dems[0] || null, dems, loadFailed: g.loadFailed });
      }
      g = null;
    };
    samples.forEach((s, i) => {
      if (g && s.part !== samples[g.i1].part) close();
      if (s.level === kind) {
        if (g && s.d - g.end > ROUTE.mergeGap) close();
        if (!g) g = { start: s.d, end: s.d, i0: i, i1: i, dems: new Set(), loadFailed: false };
        if (s.dem) g.dems.add(s.dem);
        if (s.loadFailed) g.loadFailed = true;
        g.end = s.d; g.i1 = i;
      }
    });
    close();
  }

  // 3) crater rims crossed (Robbins & Hynek 2012 catalogue, craters >= 1 km): within 0.9–1.1 R of the centre
  const bb = samples.reduce((b, s) => [Math.min(b[0], s.lon), Math.min(b[1], s.lat), Math.max(b[2], s.lon), Math.max(b[3], s.lat)],
    [Infinity, Infinity, -Infinity, -Infinity]);
  for (const f of R.craters?.features || []) {
    const p = f.properties || {};
    const diam = p.diam_km ?? p.value;
    if (!diam) continue;
    const c = f.geometry.coordinates, Rm = diam * 500;
    // cheap reject: the route's bounding box is entirely outside the crater's outer circle (1.1 R)
    const rLat = (1.1 * Rm) / M_PER_DEG, rLon = rLat / Math.cos(c[1] * Math.PI / 180);
    if (c[0] + rLon < bb[0] || c[0] - rLon > bb[2] || c[1] + rLat < bb[1] || c[1] - rLat > bb[3]) continue;
    let best = null;
    for (const s of samples) {
      const dd = distance(c, [s.lon, s.lat]);
      if (dd > 0.9 * Rm && dd < 1.1 * Rm) { const e = Math.abs(dd - Rm); if (!best || e < best.e) best = { e, s }; }
    }
    if (best) {
      const rim = rimOf(p);
      flags.push({ type: 'crater_rim', level: 'crater', d: best.s.d, lon: best.s.lon, lat: best.s.lat, diam_km: diam,
        crater_id: p.robbins_id ?? p.id, rim, rim_measured: p.rim_measured === true,
        severity: rim.p95 != null ? severityFor(rim.p95) : null });
    }
  }

  // suspect-data tag: does the flag's peak rest on a pixel the pipeline flagged as suspect?
  await Promise.all(flags.filter((f) => f.type === 'steep_slope').map(async (f) => {
    f.suspect = await suspectNear(R, f.dem, f.lon, f.lat).catch(() => false);
  }));

  flags.sort((a, b) => a.d - b.d);
  flags.forEach((f, i) => { f.n = i + 1; f.evidence = evidenceFor(f, mode, T); });

  // elevation change — only between neighbouring samples from the SAME elevation model,
  // because different models disagree by tens of metres (a switch between models is not terrain)
  let gain = 0, loss = 0, eMin = Infinity, eMax = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.elev == null || b.elev == null || a.dem !== b.dem || a.part !== b.part) continue;
    const dz = b.elev - a.elev;
    if (dz > 0) gain += dz; else loss -= dz;
  }
  for (const s of samples) if (s.elev != null) { eMin = Math.min(eMin, s.elev); eMax = Math.max(eMax, s.elev); }
  const maxSample = samples.reduce((m, s) => (s.slope != null && (!m || s.slope > m.slope) ? s : m), null);
  const maxFromStart = samples.reduce((m, s) => Math.max(m, s.fromStart), 0);
  const walkLimit = T.walkback_km * 1000;
  const walkbackApplies = opts.walkback !== false;
  const walkbackExceeded = walkbackApplies ? samples.find((s) => s.fromStart > walkLimit) || null : null;
  const sources = [...new Set(samples.filter((s) => s.status === 'ok').map((s) => s.dem))];

  return {
    mode, length, step, samples, totals, flags, gain, loss, parts: parts.length,
    maxSlope: maxSample ? maxSample.slope : null, maxSample,
    elevRange: isFinite(eMin) ? [eMin, eMax] : null,
    hours: length / 1000 / SPEEDS_KMH[mode],
    walkback: { applies: walkbackApplies, limit_m: walkLimit, max_m: maxFromStart, exceeded: walkbackExceeded },
    sources, thresholds: T, flagLevels: [...flagLevels],
  };
}

export function demLabel(dem, set_id, camera) {
  if (!dem) return 'elevation model';
  const cam = camera || (dem.startsWith('hirise') ? 'HiRISE' : 'CTX');
  return `MRO ${cam} DEM set ${set_id ?? dem.split('_')[1]}`;
}

export function evidenceFor(f, mode, T) {
  const modeName = mode === 'rover' ? 'Rover' : 'Marswalk';
  switch (f.type) {
    case 'steep_slope': {
      const nogo = f.level === 'nogo' && f.nogo_m > 0 ? ` About ${fmtDist(f.nogo_m)} of it is at or above the no-go limit.` : '';
      return `Slope up to ${f.value.toFixed(1)}° over a ${fmtDist(f.length_m)} stretch of the route, ` +
        `measured on ${demLabel(f.dem, f.set_id, f.camera)} at a ${f.baseline_m ?? '?'} m baseline (Day et al. 2023, Horn method).${nogo} ` +
        `${modeName} limits: caution ≥ ${T.caution_deg}°, no-go ≥ ${T.nogo_deg}°.` +
        (f.suspect ? ' The peak sits on or next to pixels the processing flagged as suspect (possible elevation-model artifact): flagged, not removed.' : '');
    }
    case 'data_gap':
      return f.loadFailed
        ? `No slope value for ${fmtDist(f.length_m)} of route because a terrain tile failed to load. Not checked, not assumed safe.`
        : `No slope value for ${fmtDist(f.length_m)} of route: a stereo-matching gap (or the edge of one) in ${f.dems?.length ? f.dems.map((d) => demLabel(d)).join(', ') : 'the elevation model'}. ` +
          'Nothing was filled in. The terrain here is unknown: not checked, not assumed safe.';
    case 'no_coverage':
      return `${fmtDist(f.length_m)} of route lies outside every processed elevation model. ` +
        'Only imagery is available here; slope was not assessed.';
    case 'crater_rim': {
      const r = f.rim;
      const rim = f.rim_measured && r.p95 != null
        ? ` Rim slope measured on ${demLabel(r.dem, r.set_id, r.camera)} (${r.baseline_m} m baseline, ${r.coverage}% of the rim covered): 95th percentile ${r.p95.toFixed(1)}°, steepest ${r.max?.toFixed(1)}°${r.max_on_suspect ? ' (on suspect pixels)' : ''}.`
        : ' Its rim slope is not measured (no elevation model covers at least 10% of the rim); check the slope along the route itself.';
      return `Route passes within 10% of the rim radius of a ${f.diam_km.toFixed(1)} km impact crater (Robbins & Hynek 2012 catalogue, ID ${f.crater_id}).${rim}${f.diam_km >= LARGE_CRATER_KM ? ` ${LARGE_CRATER_NOTE}` : ''}`;
    }
    default: return '';
  }
}

export const FLAG_TITLES = {
  steep_slope: (f) => `${f.level === 'nogo' ? 'No-go slope' : 'Steep slope'} — ${f.value.toFixed(1)}°`,
  data_gap: (f) => `Data gap — ${fmtDist(f.length_m)}`,
  no_coverage: (f) => `No elevation model — ${fmtDist(f.length_m)}`,
  crater_rim: (f) => `Crater rim — ${f.diam_km.toFixed(1)} km crater`,
};
