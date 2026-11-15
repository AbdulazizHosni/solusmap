// SOLUS — static configuration.
// Everything scientific (thresholds, limitations, citations) is read from the processed
// data's manifest.json first. The values here are only fallbacks so the app still runs
// without data, and they are the values Abdulaziz approved on 2026-11-14.

export const APP_VERSION = 'v0.9 (MVP)';
// Resolved from this file's location, so pages in sub-folders (tests/) find the data too.
export const DATA_ROOT = new URL('../data/solus_processed', import.meta.url).href;

// NASA/JPL Mars Trek WMTS (equirectangular, matrix set default028mm).
// Grid: origin (-180, 90); level z has 2^(z+1) x 2^z tiles; every tile spans 180/2^z degrees.
// Tile sizes and max levels were read from each layer's WMTSCapabilities.xml (2026-11-14).
export const TREK = {
  base: 'https://trek.nasa.gov/tiles/Mars/EQ',
  url(l, z, row, col) {
    return `${this.base}/${l.id}/1.0.0/default/default028mm/${z}/${row}/${col}.${l.ext}`;
  },
};

export const GLOBAL_LAYERS = {
  // Global colour base (max level 7 read from its WMTSCapabilities.xml, 2026-11-14). Viking colour gives
  // context around the regional mosaics; it is display only and never used for any calculation.
  viking: { id: 'Mars_Viking_MDIM21_ClrMosaic_global_232m', ext: 'jpg', tile: 256, maxZoom: 7,
          label: 'Viking colour mosaic (MDIM 2.1)', source: 'NASA Viking Orbiter, USGS MDIM 2.1, 232 m', bbox: [-180, -90, 180, 90] },
  mola: { id: 'Mars_MGS_MOLA_ClrShade_merge_global_463m', ext: 'jpg', tile: 256, maxZoom: 7,
          label: 'MOLA colour hillshade', source: 'NASA MGS MOLA, 463 m', bbox: [-180, -90, 180, 90] },
  themis: { id: 'THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018', ext: 'png', tile: 256, maxZoom: 9,
          label: 'THEMIS daytime infrared', source: 'NASA Mars Odyssey THEMIS, 100 m', bbox: [-180, -65, 180, 65] },
};

// Regional imagery, drawn bottom → top. bbox = [minLon, minLat, maxLon, maxLat].
export const REGION_IMAGERY = {
  jezero: [
    { id: 'Jezero_CTX_BlockAdj_dd', ext: 'png', tile: 256, maxZoom: 12, label: 'CTX mosaic (preliminary)', source: 'NASA MRO CTX',
      bbox: [75.1537692, 15.9058484, 78.8717121, 19.4453003] },
    { id: 'JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0', ext: 'png', tile: 256, maxZoom: 13, label: 'CTX mosaic, controlled (6 m)', source: 'NASA MRO CTX',
      bbox: [77.1604655, 18.2110274, 77.6991776, 18.7211945] },
    { id: 'JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd', ext: 'png', tile: 256, maxZoom: 17, label: 'HiRISE mosaic, controlled (25 cm)', source: 'NASA MRO HiRISE',
      bbox: [77.2229331, 18.3067994, 77.583964, 18.669315] },
  ],
  gale: [
    { id: 'Gale_CTX_BlockAdj_dd', ext: 'png', tile: 256, maxZoom: 12, label: 'CTX Gale mosaic', source: 'NASA MRO CTX',
      bbox: [135.1842593, -6.5732988, 139.2413012, -2.8077809] },
    { id: 'curiosity_ctx_mosaic', ext: 'png', tile: 256, maxZoom: 10, label: 'CTX Curiosity site mosaic', source: 'NASA MRO CTX',
      bbox: [136.2768326, -7.2137273, 139.3864225, -3.5804738] },
    { id: 'curiosity_hirise_mosaic', ext: 'png', tile: 256, maxZoom: 16, label: 'HiRISE Curiosity site mosaic', source: 'NASA MRO HiRISE',
      bbox: [137.1224669, -4.9254743, 137.7298129, -4.2489588] },
  ],
  west_candor: [
    { id: 'West_Candor_Chasma_longlat', ext: 'png', tile: 256, maxZoom: 12, label: 'CTX West Candor mosaic', source: 'NASA MRO CTX',
      bbox: [-77.591529, -7.4890436, -76.5878504, -3.9755598] },
    { id: 'PSP_001918_1735_RED_A_01_ORTHO_longlat', ext: 'png', tile: 256, maxZoom: 16, label: 'HiRISE SW Candor', source: 'NASA MRO HiRISE',
      bbox: [-76.9823817, -6.5613214, -76.8732883, -6.3775787] },
  ],
};

// Used only when region.json can't be loaded.
export const REGION_FALLBACK = {
  jezero: { id: 'jezero', name: 'Jezero crater', focus_bbox: [77.0, 18.15, 77.75, 18.75], mission: 'Mars 2020 · Perseverance' },
  gale: { id: 'gale', name: 'Gale crater', focus_bbox: [137.0, -5.4, 137.8, -4.2], mission: 'MSL · Curiosity' },
  west_candor: { id: 'west_candor', name: 'West Candor Chasma', focus_bbox: [-77.6, -5.5, -76.5, -4.3], mission: 'Orbital data only' },
};
export const REGION_ORDER = ['jezero', 'gale', 'west_candor'];

export const FALLBACK_THRESHOLDS = {
  status: 'fallback (manifest.json not loaded)',
  modes: {
    rover: { caution_deg: 15, nogo_deg: 25, walkback_km: 10 },
    marswalk: { caution_deg: 15, nogo_deg: 20, walkback_km: 2 },
  },
};

// Travel speeds for the time estimate — both from NASA documents found in THRESHOLDS_RESEARCH.md:
// rover ~10 km/h (NASA SEV fact sheet FS-2011-08-045-JSC, row C3);
// walking ~2 km/h on level regolith (EVA-EXP-0075, 2020, row W5; does not account for slope).
export const SPEEDS_KMH = { rover: 10, marswalk: 2 };

export const FALLBACK_SEVERITY = [
  { severity: 1, min_deg: 5, max_deg: 10 }, { severity: 2, min_deg: 10, max_deg: 15 },
  { severity: 3, min_deg: 15, max_deg: 20 }, { severity: 4, min_deg: 20, max_deg: 25 },
  { severity: 5, min_deg: 25, max_deg: 30 }, { severity: 6, min_deg: 30, max_deg: null },
];

// Route analysis
export const ROUTE = {
  maxSamples: 6000,       // per route
  minStep: 5,             // m
  mergeGap: 60,           // m — flagged runs closer than this merge into one flag
  minUnknownRun: 50,      // m — shorter data gaps are reported in totals but not flagged
  hazardBuffer: 250,      // m — precomputed hazards this close to the route are listed
};

// Lowest-risk route (brief P2 #23): least-cost path on one CTX slope grid per leg, checked and re-planned.
// These are SOLUS choices, not published values, and the app says so next to every lowest-risk route.
export const SUGGEST = {
  refDeg: 10,             // cost per metre below caution = 1 + (slope / refDeg)²: 5° costs 1.25, 10° 2
  cautionFactor: 30,      // a caution cell costs this much more per metre, so it is used only when no detour exists
  maxPasses: 10,          // plan → check → block no-go / penalise caution → re-plan, at most this many times
  marginM: 1500,          // search area: the leg's bounding box plus this margin …
  marginFrac: 0.35,       // … or this fraction of the leg length, whichever is larger
  maxCells: 4_000_000,    // larger search areas are refused (split the leg with an extra point)
  snapM: 100,             // START/GOAL on no-go or no-data ground may move this far to the nearest usable cell
};
