// SOLUS — loads the processed data (data contract 1.1) produced by the offline Python pipeline.
// Nothing here computes science: it only reads the files and samples the pre-computed grids.

import { DATA_ROOT, FALLBACK_THRESHOLDS, FALLBACK_SEVERITY, REGION_FALLBACK } from './config.js';

// The published website stores large data files gzip-compressed (lossless, smaller upload and faster
// loading): tools/build_site.py writes data/solus_processed/site.json listing them. Locally there is no
// site.json and everything is read as-is.
const SITE = fetch(`${DATA_ROOT}/site.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((j) => ({ tilesGz: !!j?.tiles_gzip, tilesPack: !!j?.tiles_pack, gz: new Set(j?.gzip_files || []) }));

/**
 * Packed tiles (published site): each grid's tiles are concatenated into a few pack files, listed in
 * pack.json as key -> [file, offset, length]; one tile is fetched with an HTTP Range request.
 * A host that ignores Range sends the whole pack: the tile is then cut out of it (slower, same bytes).
 */
const packIndex = new Map(); // grid base -> Promise<index>
const packWhole = new Map(); // pack url -> Promise<Uint8Array> (only if the host ignores Range)
async function fetchPacked(base, key) {
  if (!packIndex.has(base)) packIndex.set(base, fetch(`${base}/pack.json`).then((r) => r.json()));
  const idx = await packIndex.get(base);
  const [file, off, len] = idx.tiles[key];
  const url = `${base}/${file}`;
  const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!r.ok) throw new Error(r.status);
  if (r.status === 206) return new Uint8Array(await r.arrayBuffer());
  if (!packWhole.has(url)) packWhole.set(url, r.arrayBuffer().then((b) => new Uint8Array(b)));
  return (await packWhole.get(url)).slice(off, off + len);
}

/** Response body as bytes, un-gzipped if the file was stored compressed (and the host did not already unpack it). */
async function bodyBytes(r) {
  const b = new Uint8Array(await r.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) {
    return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  return b;
}
async function getJSON(url) {
  const site = await SITE;
  const rel = url.startsWith(DATA_ROOT) ? url.slice(DATA_ROOT.length + 1) : null;
  const src = rel && site.gz.has(rel) ? `${url}.gz` : url;
  const r = await fetch(src);
  if (!r.ok) throw new Error(`${r.status} ${src}`);
  return JSON.parse(new TextDecoder().decode(await bodyBytes(r)));
}
async function tryJSON(url) { try { return await getJSON(url); } catch { return null; } }
export { tryJSON as fetchDataJSON };

export const store = {
  manifest: null,
  available: false,          // processed data found?
  regions: {},               // id -> region bundle
};

export async function loadManifest() {
  const m = await tryJSON(`${DATA_ROOT}/manifest.json`);
  store.manifest = m;
  store.available = !!m;
  return m;
}

/** Approved thresholds from manifest.json; the LOCKED fallback values only if the manifest is missing. */
export function thresholds() {
  const t = store.manifest?.thresholds;
  return t?.modes ? t : FALLBACK_THRESHOLDS;
}
export const usingFallbackThresholds = () => !store.manifest?.thresholds?.modes;
export function severityClasses() { return store.manifest?.severity_classes || FALLBACK_SEVERITY; }
export function limitations() { return store.manifest?.limitations || []; }
export function citations() { return store.manifest?.citations || []; }

/** Slope level for a mission mode: 'ok' | 'caution' | 'nogo' | null (manifest level_rule). */
export function levelFor(slopeDeg, mode) {
  if (slopeDeg == null || !isFinite(slopeDeg)) return null;
  const m = thresholds().modes[mode];
  if (slopeDeg >= m.nogo_deg) return 'nogo';
  if (slopeDeg >= m.caution_deg) return 'caution';
  return 'ok';
}
/** Severity 1–6 from the manifest's slope classes (0 below the first class). */
export function severityFor(slopeDeg) {
  if (slopeDeg == null || !isFinite(slopeDeg)) return 0;
  let s = 0;
  for (const c of severityClasses()) if (slopeDeg >= c.min_deg) s = c.severity;
  return s;
}

// ---------------------------------------------------------------------------
// Region bundle
// ---------------------------------------------------------------------------

/**
 * Order in which DEMs are sampled, most preferred first. Contract 1.1 as delivered stores it as an
 * integer `source_order` on every DEM (HiRISE first, then CTX by lowest unknown %) and repeats it as
 * `hazard_source_order`; the hazard points were computed with this order, so the app uses the same one.
 */
function sourceOrderOf(region) {
  const dems = region.dems || [];
  if (Array.isArray(region.source_order)) return region.source_order.map((x) => (typeof x === 'string' ? x : x.dem_id));
  let order;
  if (dems.length && dems.every((d) => Number.isFinite(d.source_order))) {
    order = [...dems].sort((a, b) => a.source_order - b.source_order).map((d) => d.dem_id);
  } else if (Array.isArray(region.hazard_source_order)) {
    order = [...region.hazard_source_order];
  } else {
    order = [...dems].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)
      || (a.unknown_pct_in_footprint ?? 99) - (b.unknown_pct_in_footprint ?? 99)).map((d) => d.dem_id);
  }
  const h = region.hazard_source_order;
  if (Array.isArray(h) && h.join() !== order.join()) console.warn('SOLUS: DEM source_order differs from hazard_source_order', order, h);
  return order;
}

export async function loadRegion(id, onProgress = () => {}) {
  if (store.regions[id]) return store.regions[id];
  const t0 = performance.now();
  const base = `${DATA_ROOT}/regions/${id}`;
  const region = (await tryJSON(`${base}/region.json`)) || { ...REGION_FALLBACK[id], dems: [], _fallback: true };
  const R = { id, base, region, dems: region.dems || [], grids: {}, overlays: {} };

  onProgress('Loading map layers…');
  const [hazards, craters, traverse, footprints, geology, validation] = await Promise.all([
    ...['hazards', 'craters', 'traverse', 'footprints', 'geology'].map((n) => tryJSON(`${base}/${n}.geojson`)),
    tryJSON(`${base}/validation.json`),
  ]);
  Object.assign(R, { hazards, craters, traverse, footprints, geology, validation });

  R.sourceOrder = sourceOrderOf(region);
  R.demById = Object.fromEntries(R.dems.map((d) => [d.dem_id, d]));

  // overlay sidecars (display only)
  onProgress('Loading overlays…');
  await Promise.all(R.sourceOrder.flatMap((dem) => ['slope', 'unknown', 'suspect', 'hillshade'].map(async (kind) => {
    const meta = await tryJSON(`${base}/overlays/${dem}_${kind}.json`);
    if (meta?.bounds) (R.overlays[kind] ||= []).push({ dem, kind, url: `${base}/overlays/${dem}_${kind}.png`, ...meta });
  })));

  // grid metadata
  onProgress('Loading terrain grids…');
  await Promise.all(R.sourceOrder.map(async (dem) => {
    const vars = {};
    await Promise.all(['slope', 'elev', 'unknown', 'rough'].map(async (v) => {
      const m = await tryJSON(`${base}/grids/${dem}/${v}/meta.json`);
      if (m) vars[v] = new Grid(`${base}/grids/${dem}/${v}`, m);
    }));
    if (vars.slope) R.grids[dem] = vars;
  }));

  R.loadMs = Math.round(performance.now() - t0);
  store.regions[id] = R;
  return R;
}

/** Original NASA/JPL waypoint file (with on-board tilt), loaded only when needed. */
export async function loadWaypoints(R) {
  if (R.waypoints !== undefined) return R.waypoints;
  const name = R.region.files?.traverse_waypoints_original;
  R.waypoints = name ? await tryJSON(`${R.base}/${name}`) : null;
  return R.waypoints;
}

// ---------------------------------------------------------------------------
// Tiled binary grid (contract 1.1 §6.7): little-endian, row-major from the NW corner,
// 256x256 tiles named <tx>_<ty>.bin; tx from the west, ty from the north.
// ---------------------------------------------------------------------------
const DTYPES = { int16: Int16Array, float32: Float32Array, uint8: Uint8Array };

export class Grid {
  constructor(base, meta) {
    this.base = base; this.meta = meta;
    this.ts = meta.tile_size || 256;
    this.tileSet = new Set(meta.tiles || []);
    this.cache = new Map();   // key -> TypedArray | null (failed) | Promise (loading)
    const [x0, y0, x1, y1] = meta.bounds;
    Object.assign(this, { x0, y0, x1, y1 });
    [this.dx, this.dy] = meta.res_deg || [(x1 - x0) / meta.width, (y1 - y0) / meta.height];
    this.T = DTYPES[meta.dtype] || Float32Array;
  }
  contains(lon, lat) { return lon >= this.x0 && lon < this.x1 && lat > this.y0 && lat <= this.y1; }
  cellOf(lon, lat) {
    const col = Math.floor((lon - this.x0) / this.dx), row = Math.floor((this.y1 - lat) / this.dy);
    if (col < 0 || row < 0 || col >= this.meta.width || row >= this.meta.height) return null;
    return { col, row, key: `${Math.floor(col / this.ts)}_${Math.floor(row / this.ts)}` };
  }
  /** True when the tile is loaded (or known to be missing), i.e. value() can answer synchronously. */
  ready(key) { const v = this.cache.get(key); return v !== undefined && !(v instanceof Promise); }
  /** Load a tile. Resolves to true when available. */
  async ensure(key) {
    if (!this.tileSet.has(key)) return false;
    let v = this.cache.get(key);
    if (v === undefined) {
      v = SITE.then(async (site) => {
        if (site.tilesPack) return bodyBytes(new Response(await fetchPacked(this.base, key)));
        const r = await fetch(`${this.base}/${key}.bin${site.tilesGz ? '.gz' : ''}`);
        if (!r.ok) throw new Error(r.status);
        return bodyBytes(r);
      }).then((bytes) => {
        const arr = new this.T(bytes.buffer, bytes.byteOffset, bytes.byteLength / this.T.BYTES_PER_ELEMENT); // little-endian (all target browsers are LE)
        this.cache.set(key, arr); return arr;
      }).catch(() => { this.cache.set(key, null); return null; });
      this.cache.set(key, v);
    }
    return !!(await v);
  }
  /**
   * Synchronous lookup from loaded tiles.
   * Returns undefined if the tile isn't loaded yet, null for NoData / no tile written, else the value.
   * The `unknown` grid returns its raw class: 0 valid, 1 unknown (stereo gap), 255 outside footprint.
   */
  value(lon, lat) {
    const c = this.cellOf(lon, lat);
    if (!c || !this.tileSet.has(c.key)) return null;
    const arr = this.cache.get(c.key);
    if (arr === undefined || arr instanceof Promise) return undefined;
    if (arr === null) return null;
    const raw = arr[(c.row % this.ts) * this.ts + (c.col % this.ts)];
    const m = this.meta;
    if (m.dtype === 'float32') return Number.isNaN(raw) ? null : raw;
    if (m.dtype === 'uint8') return raw;
    if (m.nodata != null && raw === m.nodata) return null;
    return raw * (m.scale ?? 1) + (m.offset ?? 0);
  }
}

/**
 * Sample the best source at a point (contract 1.1 §6.7 sampling rule):
 * walk the source order; the first DEM whose slope cell is valid wins. If none is valid but some
 * DEM's footprint covers the point (unknown ≠ 255) → unknown. Else → not covered.
 * A valid cell with NoData slope (its slope window touches a gap) counts as "no slope available".
 *
 * Returns
 *   {status:'ok', slope, elev, rough, dem, camera, set_id, res_m, baseline_m}
 *   {status:'unknown', dem}   inside a DEM footprint, no slope value (stereo gap or next to one)
 *   {status:'outside'}        no DEM covers this point
 *   {status:'loading'}        a tile needed to answer is not loaded yet (call prefetch first)
 */
export function sampleAt(R, lon, lat) {
  let unknownDem = null;
  for (const dem of R.sourceOrder) {
    const g = R.grids[dem];
    if (!g || !g.slope.contains(lon, lat)) continue;
    const s = g.slope.value(lon, lat);
    if (s === undefined) return { status: 'loading' };
    if (s !== null) {
      const d = R.demById[dem] || {};
      const elev = g.elev ? g.elev.value(lon, lat) : null, rough = g.rough ? g.rough.value(lon, lat) : null;
      return {
        status: 'ok', slope: s, dem,
        elev: elev ?? null, rough: rough ?? null,
        camera: d.camera || (dem.startsWith('hirise') ? 'HiRISE' : 'CTX'),
        res_m: g.slope.meta.nominal_res_m ?? d.res_m,
        baseline_m: g.slope.meta.baseline_m ?? d.slope_baseline_m ?? g.slope.meta.nominal_res_m,
        set_id: d.set_id ?? dem.split('_')[1],
      };
    }
    const cell = g.slope.cellOf(lon, lat);
    if (!cell || !g.slope.tileSet.has(cell.key)) continue; // no tile written: this DEM has nothing here
    const u = g.unknown ? g.unknown.value(lon, lat) : null;
    if (u === undefined) return { status: 'loading' };
    if (u === 255 || u === null) continue;                 // outside this DEM's footprint
    unknownDem ||= dem;                                    // u = 1 (gap) or 0 (valid, but no slope)
  }
  return unknownDem ? { status: 'unknown', dem: unknownDem } : { status: 'outside' };
}

/** Add to `jobs` the tiles that sampleAt(R, lon, lat) still needs. */
function neededTiles(R, lon, lat, jobs) {
  const want = (dem, grid, cell) => {
    if (!grid || !cell || !grid.tileSet.has(cell.key) || grid.ready(cell.key)) return;
    jobs.set(`${dem}/${grid.meta.var}/${cell.key}`, () => grid.ensure(cell.key));
  };
  for (const dem of R.sourceOrder) {
    const g = R.grids[dem];
    if (!g || !g.slope.contains(lon, lat)) continue;
    const c = g.slope.cellOf(lon, lat);
    if (!c || !g.slope.tileSet.has(c.key)) continue;
    const s = g.slope.value(lon, lat);
    if (s === undefined) { want(dem, g.slope, c); if (g.unknown) want(dem, g.unknown, g.unknown.cellOf(lon, lat)); return; }
    if (s !== null) {        // this DEM wins here: elevation and roughness come from it too
      if (g.elev) want(dem, g.elev, g.elev.cellOf(lon, lat));
      if (g.rough) want(dem, g.rough, g.rough.cellOf(lon, lat));
      return;
    }
    if (g.unknown && g.unknown.value(lon, lat) === undefined) { want(dem, g.unknown, g.unknown.cellOf(lon, lat)); return; }
  }
}

/**
 * Load the grid tiles needed to sample the given points. Works in rounds down the source order,
 * so a less preferred DEM is only fetched where every more preferred one has no value.
 */
export async function prefetch(R, pts, onProgress = () => {}) {
  let total = 0, done = 0;
  for (let round = 0; round < 2 * (R.sourceOrder.length + 1); round++) {
    const jobs = new Map();
    for (const p of pts) neededTiles(R, p.lon, p.lat, jobs);
    if (!jobs.size) break;
    total += jobs.size;
    const list = [...jobs.values()];
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (list.length) { await list.pop()(); onProgress(++done, total); }
    }));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Suspect overlay lookup (display PNG from the pipeline, read back for tagging only).
// A pixel is marked when any native DEM pixel inside it failed the MOLA or spike check.
// ---------------------------------------------------------------------------
const suspectMasks = new Map(); // url -> Promise<{w,h,alpha:Uint8Array,bounds}|null>

function loadMask(o) {
  if (!suspectMasks.has(o.url)) {
    suspectMasks.set(o.url, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const alpha = new Uint8Array(c.width * c.height);
          for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
          resolve({ w: c.width, h: c.height, alpha, bounds: o.bounds });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = o.url;
    }));
  }
  return suspectMasks.get(o.url);
}

/** True if the suspect overlay of `dem` marks the point (or a neighbouring overlay pixel). */
export async function suspectNear(R, dem, lon, lat, radiusPx = 1) {
  const o = (R.overlays.suspect || []).find((x) => x.dem === dem);
  if (!o) return false;
  const m = await loadMask(o);
  if (!m) return false;
  const [x0, y0, x1, y1] = m.bounds;
  const cx = Math.floor((lon - x0) / (x1 - x0) * m.w), cy = Math.floor((y1 - lat) / (y1 - y0) * m.h);
  for (let dy = -radiusPx; dy <= radiusPx; dy++) for (let dx = -radiusPx; dx <= radiusPx; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x >= 0 && y >= 0 && x < m.w && y < m.h && m.alpha[y * m.w + x] > 0) return true;
  }
  return false;
}
