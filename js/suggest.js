// SOLUS — lowest-risk route through the user's own points (brief P2 #23, extended).
//
// The lowest risk the slope data can show, never a safety guarantee. For each leg it
//   • plans on ONE CTX slope grid (18 m cells); models are never stitched together;
//   • never enters a cell at or above the mode's no-go limit, or a cell without a slope value
//     (stereo gap, its edge, or outside the model): unknown ground is never treated as passable;
//   • avoids caution ground wherever a detour exists: a caution cell costs SUGGEST.cautionFactor times
//     more than level ground; below caution, cost per metre = 1 + (slope / refDeg)² (SOLUS choices);
//   • moves between the 8 neighbouring cells and never cuts the corner of a blocked cell.
// Then it CHECKS the whole route exactly like any route (preferred model at every point, HiRISE 5 m
// first, samples every few metres) and feeds the result back: cells where the check finds no-go or no
// data are blocked, cells where it finds caution are penalised, and the route is re-planned, until the
// check finds no no-go stretch or SUGGEST.maxPasses is reached. The pass with the least no-go is kept.

import { M_PER_DEG, distance } from './geo.js';
import { thresholds } from './data.js';
import { analyzeRoute } from './route.js';
import { SUGGEST } from './config.js';

const RAD = Math.PI / 180;
const fail = (msg, tryNext = false) => Object.assign(new Error(msg), { tryNext });
const yieldUI = () => new Promise((r) => setTimeout(r, 0));
const fmtKm = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * Lowest-risk route through the waypoints. Returns
 * { pts, legs:[{dem,set,lengthM,straightM,snapA,snapB}], passes, nogoLeftM, cautionLeftM, mode, nogo, caution, refDeg, cautionFactor }.
 * Throws an Error with a user-facing message when no route is possible.
 */
export async function lowestRiskRoute(R, waypoints, mode, onProgress = () => {}) {
  const T = thresholds().modes[mode];
  const n = waypoints.length - 1;
  const legs = [];
  for (let k = 1; k <= n; k++) {
    const tag = n > 1 ? `Leg ${k} of ${n}: ` : '';
    try { legs.push(await prepareLeg(R, waypoints[k - 1], waypoints[k], T, (m) => onProgress(tag + m))); } catch (e) { throw fail(tag + e.message); }
  }
  let best = null;
  for (let pass = 1; pass <= SUGGEST.maxPasses; pass++) {
    const paths = [];
    for (let k = 0; k < legs.length; k++) {
      onProgress(`Pass ${pass}: planning${n > 1 ? ` leg ${k + 1} of ${n}` : ''}…`);
      const p = pass === 1 ? legs[k].first : await planLeg(legs[k], () => {});
      if (!p) break;                       // blocking cells closed every path: keep the best pass so far
      paths.push(p);
    }
    if (paths.length < legs.length) break;
    const pts = paths.reduce((acc, p) => (acc.length ? acc.concat(p.pts.slice(1)) : p.pts.slice()), []);
    onProgress(`Pass ${pass}: checking with the most detailed data…`);
    const A = await analyzeRoute(R, pts, mode);
    const bad = A.samples.filter((s) => s.level === 'nogo' || s.level === 'unknown' || s.level === 'outside');
    const caution = A.samples.filter((s) => s.level === 'caution');
    const score = bad.length * 1e6 + caution.length * 10 + A.length / 1e4;
    if (!best || score < best.score) {
      best = { score, pts, pass, A, nogoLeftM: bad.length * A.step, cautionLeftM: caution.length * A.step,
        legs: paths.map((p, k) => ({ dem: legs[k].dem, set: legs[k].set, lengthM: p.lengthM, straightM: legs[k].L, snapA: p.snapA, snapB: p.snapB })) };
    }
    if (!bad.length) break;
    // feed the check back into every leg's planning grid
    for (const L of legs) { for (const s of bad) L.block(s.lon, s.lat); for (const s of caution) L.penalize(s.lon, s.lat); }
    await yieldUI();
  }
  return {
    pts: best.pts, legs: best.legs, passes: best.pass, nogoLeftM: best.nogoLeftM, cautionLeftM: best.cautionLeftM,
    mode, nogo: T.nogo_deg, caution: T.caution_deg, refDeg: SUGGEST.refDeg, cautionFactor: SUGGEST.cautionFactor,
  };
}

/** Pick the planning grid for a leg: the first CTX model (in source order) that covers both points and has a path. */
async function prepareLeg(R, a, b, T, progress) {
  const L = distance(a, b);
  const grids = R.sourceOrder.filter((d) => d.startsWith('ctx') && R.grids[d]).map((d) => R.grids[d].slope);
  const cands = grids.filter((g) => g.contains(a[0], a[1]) && g.contains(b[0], b[1]));
  if (!cands.length) throw fail('no single CTX elevation model covers both points. Models are never stitched together, so the planner needs one model: add a point inside the overlap or move a point.');
  let firstErr = null;
  for (const g of cands) {
    try {
      const leg = await buildWindow(g, a, b, L, T, progress);
      leg.first = await planLeg(leg, progress);
      if (!leg.first) throw fail(`no path avoids no-go (≥ ${T.nogo_deg}°) and no-data cells within ${fmtKm(leg.margin)} of the straight line in CTX set ${leg.set}.`, true);
      return leg;
    } catch (e) {
      if (!e.tryNext) throw e;
      firstErr ||= e;
    }
  }
  throw firstErr;
}

/** Load one CTX slope window around the leg and build its cost surface. */
async function buildWindow(g, a, b, L, T, progress) {
  const meta = g.meta, dem = meta.dem_id, set = dem.split('_')[1];
  progress(`loading CTX set ${set} slope…`);
  const margin = Math.max(SUGGEST.marginM, SUGGEST.marginFrac * L);
  const kx = Math.cos(((a[1] + b[1]) / 2) * RAD);
  const mLat = margin / M_PER_DEG, mLon = mLat / kx;
  const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - mLon - g.x0) / g.dx));
  const c1 = Math.min(meta.width - 1, Math.floor((Math.max(a[0], b[0]) + mLon - g.x0) / g.dx));
  const r0 = Math.max(0, Math.floor((g.y1 - (Math.max(a[1], b[1]) + mLat)) / g.dy));
  const r1 = Math.min(meta.height - 1, Math.floor((g.y1 - (Math.min(a[1], b[1]) - mLat)) / g.dy));
  const W = c1 - c0 + 1, H = r1 - r0 + 1, N = W * H;
  if (N > SUGGEST.maxCells) throw fail(`this leg (${fmtKm(L)}) is too long to plan (${(N / 1e6).toFixed(1)} million cells to search). Add a point in between to split it.`);

  const ts = g.ts, keys = [];
  for (let ty = Math.floor(r0 / ts); ty <= Math.floor(r1 / ts); ty++) for (let tx = Math.floor(c0 / ts); tx <= Math.floor(c1 / ts); tx++) {
    const k = `${tx}_${ty}`; if (g.tileSet.has(k)) keys.push([k, tx, ty]);
  }
  await Promise.all(keys.map(([k]) => g.ensure(k)));
  const S = new Float32Array(N).fill(NaN);
  const scale = meta.scale ?? 1, offset = meta.offset ?? 0, nod = meta.nodata;
  for (const [k, tx, ty] of keys) {
    const arr = g.cache.get(k); if (!arr || arr instanceof Promise) continue;
    const gx0 = tx * ts, gy0 = ty * ts;
    const xa = Math.max(c0, gx0), xb = Math.min(c1, gx0 + ts - 1), ya = Math.max(r0, gy0), yb = Math.min(r1, gy0 + ts - 1);
    for (let y = ya; y <= yb; y++) {
      const src = (y - gy0) * ts, dst = (y - r0) * W;
      for (let x = xa; x <= xb; x++) { const raw = arr[src + x - gx0]; if (raw !== nod) S[dst + x - c0] = raw * scale + offset; }
    }
  }
  const base = (s) => 1 + (s / SUGGEST.refDeg) ** 2;
  const M = new Float32Array(N), pass = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const s = S[i];
    if (s < T.nogo_deg) { pass[i] = 1; M[i] = (s >= T.caution_deg ? SUGGEST.cautionFactor : 0) + base(s); } // NaN fails the test: no data never passable
    else M[i] = Infinity;
  }
  const idxOf = (lon, lat) => {
    const x = Math.floor((lon - g.x0) / g.dx) - c0, y = Math.floor((g.y1 - lat) / g.dy) - r0;
    return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1;
  };
  return {
    g, dem, set, a, b, L, margin, c0, r0, W, H, N, S, M, pass,
    cellW: g.dx * M_PER_DEG * kx, cellH: g.dy * M_PER_DEG,
    toCell: (p) => [(p[0] - g.x0) / g.dx - c0, (g.y1 - p[1]) / g.dy - r0],
    toLonLat: (x, y) => [g.x0 + (c0 + x) * g.dx, g.y1 - (r0 + y) * g.dy],
    // a no-go found by the check closes its cell and the 8 around it (steep features rarely stop at one 18 m cell)
    block(lon, lat) {
      const i = idxOf(lon, lat); if (i < 0) return;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        pass[ny * W + nx] = 0; M[ny * W + nx] = Infinity;
      }
    },
    penalize(lon, lat) { const i = idxOf(lon, lat); if (i >= 0 && pass[i]) M[i] = Math.max(M[i], SUGGEST.cautionFactor + base(S[i])); },
  };
}

/** A* on the leg's window. Returns {pts, lengthM, snapA, snapB} or null when no path exists. */
async function planLeg(Lg, progress) {
  const { W, H, N, M, pass, cellW, cellH } = Lg, diag = Math.hypot(cellW, cellH);
  const snap = (p, label) => {
    const [fx, fy] = Lg.toCell(p), x = Math.floor(fx), y = Math.floor(fy);
    if (pass[y * W + x]) return { i: y * W + x, moved: 0 };
    const Rr = Math.ceil(SUGGEST.snapM / Math.min(cellW, cellH));
    let best = null;
    for (let dy = -Rr; dy <= Rr; dy++) for (let dx = -Rr; dx <= Rr; dx++) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H || !pass[ny * W + nx]) continue;
      const d = Math.hypot(dx * cellW, dy * cellH);
      if (d <= SUGGEST.snapM && (!best || d < best.moved)) best = { i: ny * W + nx, moved: d };
    }
    if (!best) {
      const s = Lg.S[y * W + x];
      throw fail(`${label} is on ${Number.isNaN(s) ? 'ground without slope data' : `a ${s.toFixed(0)}° slope (no-go)`} in CTX set ${Lg.set}, with no usable cell within ${SUGGEST.snapM} m. Move it.`, true);
    }
    return best;
  };
  let A, B;
  try { A = snap(Lg.a, 'START'); B = snap(Lg.b, 'GOAL'); } catch (e) { if (Lg.first) return null; throw e; } // later passes: just stop

  const gx = B.i % W, gy = (B.i / W) | 0;
  const hdist = (i) => Math.hypot(((i % W) - gx) * cellW, (((i / W) | 0) - gy) * cellH); // admissible: every cell costs ≥ 1 per metre
  const gc = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  let hk = new Float64Array(1 << 16), hv = new Int32Array(1 << 16), hn = 0;
  const push = (v, k) => {
    if (hn === hk.length) { const k2 = new Float64Array(hn * 2); k2.set(hk); hk = k2; const v2 = new Int32Array(hn * 2); v2.set(hv); hv = v2; }
    let i = hn++;
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {
    const top = hv[0], k = hk[--hn], v = hv[hn];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= hn) break;
      if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= k) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = k; hv[i] = v;
    return top;
  };
  gc[A.i] = 0; push(A.i, hdist(A.i));
  let iter = 0, found = A.i === B.i;
  while (hn && !found) {
    const cur = pop();
    if (closed[cur]) continue;
    if (cur === B.i) { found = true; break; }
    closed[cur] = 1;
    const cx = cur % W, cy = (cur / W) | 0, mc = M[cur];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (closed[ni] || !pass[ni]) continue;
      if (dx && dy && (!pass[cy * W + nx] || !pass[ny * W + cx])) continue; // no corner cutting
      const len = dx && dy ? diag : dx ? cellW : cellH;
      const ng = gc[cur] + (len * (mc + M[ni])) / 2;
      if (ng < gc[ni]) { gc[ni] = ng; from[ni] = cur; push(ni, ng + hdist(ni)); }
    }
    if (++iter % 60000 === 0) { progress(`searching CTX set ${Lg.set}… ${Math.min(99, Math.round((100 * iter) / N))}% of the area visited`); await yieldUI(); }
  }
  if (!found) return null;

  // cell path → simplified polyline that keeps every guarantee of the cell path
  const cells = [];
  for (let i = B.i; i !== -1; i = from[i]) cells.push(i);
  cells.reverse();
  const P = cells.map((i) => [(i % W) + 0.5, ((i / W) | 0) + 0.5]);
  if (!A.moved) P[0] = Lg.toCell(Lg.a);
  if (!B.moved) P[P.length - 1] = Lg.toCell(Lg.b);
  const Mc = cells.map((i) => M[i]);
  const segOk = (i, j) => {
    let lim = 0; for (let k = i; k <= j; k++) lim = Math.max(lim, Mc[k]);
    lim += 1e-6;
    return cellsOnSegment(P[i][0], P[i][1], P[j][0], P[j][1], (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const c = y * W + x; return pass[c] === 1 && M[c] <= lim; // never costlier ground than the cell path accepted there
    });
  };
  const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    const [ax, ay] = P[i], [bx, by] = P[j], ux = bx - ax, uy = by - ay, ul = Math.hypot(ux, uy) || 1;
    let dmax = -1, idx = i + 1;
    for (let k = i + 1; k < j; k++) { const d = Math.abs((P[k][0] - ax) * uy - (P[k][1] - ay) * ux) / ul; if (d > dmax) { dmax = d; idx = k; } }
    if (dmax > 1 || !segOk(i, j)) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  let pts = [];
  P.forEach((p, k) => { if (keep[k]) pts.push(Lg.toLonLat(p[0], p[1])); });
  if (pts.length < 2) pts = [Lg.a, Lg.b]; // START and GOAL in the same cell
  let lengthM = 0; for (let k = 1; k < pts.length; k++) lengthM += distance(pts[k - 1], pts[k]);
  return { pts, lengthM, snapA: A.moved, snapB: B.moved };
}

/**
 * Visit every grid cell a straight segment passes through (cell units, continuous coordinates).
 * Where the segment passes exactly through a cell corner, both side cells are visited too.
 * Returns false as soon as visit() returns false.
 */
export function cellsOnSegment(ax, ay, bx, by, visit) {
  let x = Math.floor(ax), y = Math.floor(ay);
  const ex = Math.floor(bx), ey = Math.floor(by);
  const dx = bx - ax, dy = by - ay, sx = Math.sign(dx), sy = Math.sign(dy);
  const tDx = sx ? Math.abs(1 / dx) : Infinity, tDy = sy ? Math.abs(1 / dy) : Infinity;
  let tMx = sx > 0 ? (x + 1 - ax) * tDx : sx < 0 ? (ax - x) * tDx : Infinity;
  let tMy = sy > 0 ? (y + 1 - ay) * tDy : sy < 0 ? (ay - y) * tDy : Infinity;
  if (!visit(x, y)) return false;
  for (let guard = 0; (x !== ex || y !== ey) && guard < 1e6; guard++) {
    if (Math.abs(tMx - tMy) < 1e-12) {
      if (!visit(x + sx, y) || !visit(x, y + sy)) return false;
      x += sx; y += sy; tMx += tDx; tMy += tDy;
    } else if (tMx < tMy) { x += sx; tMx += tDx; } else { y += sy; tMy += tDy; }
    if (!visit(x, y)) return false;
  }
  return x === ex && y === ey; // false if the guard stopped the walk early
}
