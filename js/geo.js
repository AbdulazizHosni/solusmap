// SOLUS — Mars geometry and formatting helpers.
// Reference body: Mars 2000 sphere (IAU 2000 49900), radius 3,396,190 m — the same sphere
// the NASA DEMs and the processed data use. Longitudes are degrees east, -180..180.

export const MARS_R = 3396190;                       // m
export const M_PER_DEG = (2 * Math.PI * MARS_R) / 360; // m per degree of latitude (~59,274 m)
const RAD = Math.PI / 180;

export function wrapLon(lon) {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  return l === -180 ? 180 : l;
}

/** Great-circle distance in metres (haversine on the Mars 2000 sphere). */
export function distance(a, b) {
  const [lon1, lat1] = a, [lon2, lat2] = b;
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total length of a polyline [[lon,lat],...] in metres. */
export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += distance(pts[i - 1], pts[i]);
  return d;
}

/** Points every `step` metres along a polyline. Each sample: {lon, lat, d (m from start), seg}. */
export function densify(pts, step) {
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = distance(a, b);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = (i === 1 ? 0 : 1); k <= n; k++) {
      const t = k / n;
      // linear in lon/lat is fine at these scales (segments of a few km)
      out.push({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, d: acc + L * t, seg: i - 1 });
    }
    acc += L;
  }
  return out;
}

/** Approx. distance (m) from point p to segment ab, using a local equirectangular frame. */
export function pointSegDistance(p, a, b) {
  const k = Math.cos(p[1] * RAD) * M_PER_DEG;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * M_PER_DEG;
  const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * M_PER_DEG;
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t, y = ay + dy * t;
  return { dist: Math.hypot(x, y), t };
}

/** Distance (m) from point to a polyline, plus the along-path position (m) of the nearest point. */
export function pointPathDistance(p, pts) {
  let best = { dist: Infinity, along: 0 }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = distance(pts[i - 1], pts[i]);
    const r = pointSegDistance(p, pts[i - 1], pts[i]);
    if (r.dist < best.dist) best = { dist: r.dist, along: acc + r.t * L };
    acc += L;
  }
  return best;
}

export function fmtDeg(v, kind, mode = 'dd') {
  if (v == null || !isFinite(v)) return '—';
  if (mode === 'dms') {
    const hemi = kind === 'lat' ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    let a = Math.abs(v);
    let d = Math.floor(a); a = (a - d) * 60;
    let m = Math.floor(a); let s = (a - m) * 60;
    if (s >= 59.95) { s = 0; m += 1; } if (m >= 60) { m = 0; d += 1; }
    return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″ ${hemi}`;
  }
  return `${v.toFixed(4)}°`;
}

export function fmtDist(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/** Parse "lat, lon" (decimal, optional N/S/E/W suffixes). Returns [lon, lat] or null. */
export function parseLatLon(text) {
  if (!text) return null;
  const parts = text.trim().replace(/[;]/g, ',').split(/[,\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const num = (s) => {
    const m = s.match(/^(-?\d+(?:\.\d+)?)°?([NSEWnsew])?$/);
    if (!m) return null;
    let v = parseFloat(m[1]);
    const h = (m[2] || '').toUpperCase();
    if (h === 'S' || h === 'W') v = -Math.abs(v);
    return { v, h };
  };
  const a = num(parts[0]), b = num(parts[1]);
  if (!a || !b) return null;
  let lat = a.v, lon = b.v;
  if (a.h === 'E' || a.h === 'W' || b.h === 'N' || b.h === 'S') { lat = b.v; lon = a.v; }
  if (lon > 180) lon -= 360;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}
