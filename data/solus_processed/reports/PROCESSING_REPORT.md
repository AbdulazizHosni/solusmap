# SOLUS processing report (phases 2 and 2b, data contract 1.1)

Date: 2026-11-14. Input: the 20 Tier 1 DEMs and context data fetched in phase 1. Every number in this report is read from the files the scripts wrote.

**Status: the phase 2b follow-up is applied in full and all self-checks pass.**

## Phase 2b changes

### What changed from contract 1.0

| item | 1.0 | 1.1 (this package) |
|---|---|---|
| Thresholds | not applied | approved values in `manifest.thresholds`: rover caution 15°, no-go 25°, walk-back 10 km; Marswalk caution 15°, no-go 20°, walk-back 2 km |
| HiRISE slope | 1 m baseline | **5 m baseline**: DEM block-averaged 1 m → 5 m (a block with any NoData pixel is NoData), then Horn 3x3. Used in the grids, hazards, overlays and stats |
| HiRISE grid cell | 2 m | **5 m** |
| HiRISE relief window | 101 m | **21 m** |
| Hazard points (slope, roughness, relief) | connected regions, cap 150 per DEM | **one point per 1 km square**, best source, no cap |
| Slope hazard floor | 10° | **15°** |
| New hazard properties | | `cell_id`, `p95`, `severity`, `level_rover`, `level_marswalk`, `baseline_m` |
| `manifest.json` | | `thresholds` (with full citations), `severity_classes`, `limitations` |
| DEM priority | HiRISE 1, CTX 2 | HiRISE 1; CTX 2, 3, 4… by lowest unknown % |
| Unchanged | | CTX grid tiles (not re-exported), encodings, tile layout, overlay format, data_gap and crater_rim method, all other GeoJSON files |

### What the changes show

1. **The 5 m baseline removes most of the excess steepness, but not all of it.** At Perseverance's waypoints the share of HiRISE slope values at or above 20° falls from 9.5 % (1 m) to 1.7 % (5 m) for set 1159, and from 17.9 % to 9.6 % for set 1228. The rover itself recorded 20° or more at 0.6 % and 2.1 % of those waypoints. For set 1228 the 5 m share is still about 5 times the rover's. Details in section 6.
2. **The approved limits label a small part of the real rover paths as no-go.** In rover mode, 0.2–2.9 % of Perseverance's path and 0.14–0.42 % of Curiosity's path is no-go, depending on the DEM. By the rovers' own recorded tilt, 0.0 % (Perseverance) and 0.5 % (Curiosity) of waypoints are no-go. So the statement 'SOLUS will not label terrain that real rovers drove as no-go' holds for 97.1–99.9 % of the paths, not 100 %. The no-go samples are the DEMs' steep tail, which section 6 shows is overstated.
3. **Every region has more than 3,000 points per type** (you asked to be told): steep_slope 5,404 in Jezero, 3,263 in Gale and 4,575 in West Candor. The DEMs cover 3,438–6,211 squares per region, and 87–97 % of them have at least one spot at or above 15°.
4. **Judged by its single steepest spot, most squares are no-go.** 75–96 % of steep_slope points are rover no-go, because the maximum of a few thousand slope values in a square is usually an artifact or one small scarp. Judged by the 95th percentile in the square, 16–59 % are no-go. I added `level_rover_p95` and `level_marswalk_p95` to each point so the app can use either. See section 2b and question 1.
5. **Size.** The package is now 1.30 GB (expected about 1.2 GB): CTX grids 723 MB, HiRISE grids 404 MB, overlays 129 MB.

### One deviation from the follow-up brief

The brief says: in each 1 km square, pick the best source that has valid data there, then take its steepest spot. Applied per square, a HiRISE strip that clips a corner of a square would win the whole square, and a cliff in the rest of the square (covered only by CTX) would get no point. I therefore applied the same preference **per location**: at every location the value comes from the most preferred source with a valid value there (HiRISE, then CTX by lowest unknown %), and the point is the steepest such location in the square. Where one source covers the whole square this is identical to the brief. It is also exactly what the app does when it samples a route. `dem_id` is the source at the winning spot, `p95` is that source's 95th percentile inside the square, `source_coverage_pct` says how much of the square that source covers, and `sources_in_cell` lists every source with data there.

## 1. Commands run, runtime, output sizes

```
python3 code/01_native.py --jobs 4 ctx ; python3 code/01_native.py --jobs 2 hirise     # slope, 5 m slope (HiRISE), roughness, relief, unknown, suspect, footprint
python3 code/02_hazards.py                                                             # data gaps, crater rims, 1 km cell hazards
python3 code/03_validation.py                                                          # HiRISE vs CTX at 18 m, rover paths, threshold classification, figures
python3 code/04_export_grids.py --jobs 4 ctx ; python3 code/04_export_grids.py --jobs 3 hirise
python3 code/05_overlays.py --jobs 3
python3 code/06_context.py ; python3 code/07_selfcheck.py ; python3 code/08_report.py
```
For phase 2b only these were rerun: `01_native.py hirise`, all of `02`, the rover-path part of `03`, `04` and `05` for HiRISE, then `06`, `07`, `08`. The CTX grid tiles are the phase 2 files, untouched; only `baseline_m: 18` was added to their slope `meta.json`.

### Output sizes

| region | grids CTX (18 m) | grids HiRISE (5 m) | overlays | GeoJSON and JSON | region total |
|---|---|---|---|---|---|
| jezero | 330 MB | 129 MB | 48 MB | 19 MB | 526 MB |
| gale | 176 MB | 119 MB | 24 MB | 12 MB | 331 MB |
| west_candor | 216 MB | 156 MB | 57 MB | 17 MB | 446 MB |
| **all** | **723 MB** | **404 MB** | **129 MB** | **48 MB** | **1,305 MB** (with reports and code) |

1,911 tiles x 4 variables = 7,644 tile files. Each `grids/<dem_id>/` folder is independent.

## 2. Results per DEM

Slope is Horn 3x3 at a 5 m baseline for HiRISE and 18 m for CTX. Roughness is the RMS residual from a plane in a 5 x 5 pixel window (5 m HiRISE, 90 m CTX). DEMs are listed in source-preference order. 'Slope area' is the share of the valid DEM area that has a slope value.

| region | DEM | priority | slope p50 / p95 / max (°) | slope area % | rough p50 / p95 (m) | relief p50 / p95 (m) | unknown % in footprint | suspect % | data_gap points |
|---|---|---|---|---|---|---|---|---|---|
| jezero | hirise_1206 | 1 | 5.5 / 16.8 / 65.2 | 97.4 | 0.02 / 0.19 | 2.7 / 8.0 | 0.10 | 0.060 | 102 → 102 |
| jezero | hirise_1118 | 1 | 9.8 / 21.5 / 85.6 | 94.4 | 0.04 / 0.27 | 4.6 / 10.3 | 0.83 | 0.075 | 484 → 150 |
| jezero | hirise_1228 | 1 | 9.7 / 23.2 / 87.0 | 91.9 | 0.04 / 0.34 | 4.6 / 10.9 | 3.24 | 0.143 | 1,345 → 150 |
| jezero | hirise_1159 | 1 | 6.6 / 19.9 / 84.9 | 89.6 | 0.03 / 0.39 | 3.2 / 9.5 | 4.62 | 0.142 | 703 → 150 |
| jezero | ctx_1228 | 2 | 4.2 / 16.7 / 84.0 | 99.6 | 0.45 / 2.21 | 7.0 / 26.9 | 0.14 | 0.009 | 157 → 150 |
| jezero | ctx_1206 | 3 | 4.3 / 16.3 / 83.6 | 99.6 | 0.45 / 2.24 | 7.1 / 26.3 | 0.15 | 0.007 | 259 → 150 |
| jezero | ctx_1118 | 4 | 4.4 / 18.9 / 86.6 | 99.3 | 0.55 / 2.94 | 7.4 / 30.6 | 0.43 | 0.048 | 553 → 150 |
| jezero | ctx_1159 | 5 | 4.5 / 18.6 / 88.0 | 98.6 | 0.52 / 3.40 | 7.5 / 29.7 | 1.42 | 0.205 | 4,052 → 150 |
| gale | hirise_66 | 1 | 6.0 / 20.9 / 86.8 | 97.1 | 0.03 / 0.27 | 3.0 / 10.2 | 0.81 | 0.099 | 665 → 150 |
| gale | hirise_608 | 1 | 7.7 / 22.9 / 86.9 | 92.9 | 0.03 / 0.38 | 3.8 / 11.3 | 1.14 | 0.139 | 1,594 → 150 |
| gale | ctx_66 | 2 | 6.0 / 23.2 / 88.2 | 99.4 | 0.83 / 4.04 | 9.8 / 39.0 | 0.56 | 0.108 | 754 → 150 |
| gale | ctx_608 | 3 | 6.2 / 23.2 / 87.7 | 98.6 | 0.82 / 4.06 | 10.4 / 38.5 | 1.29 | 0.107 | 2,641 → 150 |
| west_candor | hirise_1029 | 1 | 5.9 / 15.2 / 78.5 | 89.4 | 0.02 / 0.28 | 2.8 / 6.8 | 1.33 | 0.089 | 663 → 150 |
| west_candor | hirise_376 | 1 | 14.8 / 32.9 / 87.5 | 89.8 | 0.06 / 0.63 | 7.2 / 16.7 | 1.40 | 0.241 | 1,591 → 150 |
| west_candor | hirise_482 | 1 | 18.2 / 33.7 / 83.7 | 93.0 | 0.06 / 0.74 | 9.5 / 18.0 | 1.88 | 0.332 | 1,260 → 150 |
| west_candor | hirise_1347 | 1 | 12.9 / 30.5 / 87.2 | 73.9 | 0.08 / 0.68 | 6.5 / 15.0 | 5.06 | 0.319 | 2,532 → 150 |
| west_candor | ctx_1029 | 2 | 7.0 / 26.8 / 82.5 | 99.1 | 0.67 / 5.69 | 11.8 / 45.1 | 0.49 | 0.074 | 779 → 150 |
| west_candor | ctx_1347 | 3 | 11.2 / 37.8 / 84.2 | 97.8 | 1.31 / 7.52 | 19.1 / 67.5 | 1.53 | 0.084 | 2,032 → 150 |
| west_candor | ctx_376 | 4 | 9.8 / 35.4 / 88.5 | 98.3 | 1.07 / 6.44 | 16.7 / 63.5 | 1.81 | 0.494 | 3,255 → 150 |
| west_candor | ctx_482 | 5 | 14.1 / 38.1 / 88.3 | 97.4 | 1.35 / 7.61 | 24.7 / 68.9 | 2.60 | 0.582 | 1,745 → 150 |

- **5 m against 1 m on HiRISE.** The 95th-percentile slope drops by 4.5–16.7° when the baseline goes from 1 m to 5 m. The 1 m statistics are kept in `validation.json` (`hirise_slope_1m_vs_5m_baseline`).
- **Cost of the strict no-fill rule at 5 m.** A 5 m block needs all 25 pixels and the slope needs 3 x 3 blocks, so one missing pixel removes slope from a 15 m square. The 5 m slope covers 73.9–97.4 % of the valid HiRISE area.
- **HiRISE relief with the 21 m window** now covers 64–96 % of the valid pixels (it was 10–74 % with the 101 m window).
- **Maximum slopes of 80–90° are DEM artifacts, not cliffs.**

## 2b. Hazard points

Grid: 1 km x 1 km cells in longitude/latitude over each region's search box, with the cell width in longitude set at the box's centre latitude (for Jezero: 0.017790° x 0.016871° at 18.5° N). `cell_id` is `r<row from the north edge>_c<column from the west edge>`. The grid is described in each `region.json` under `hazard_grid`.

| region | type | squares with data | points kept | from HiRISE | from CTX | floor (HiRISE / CTX) | suspect |
|---|---|---|---|---|---|---|---|
| jezero | steep_slope | 6,211 | 5,404 | 237 | 5,167 | 15° / 15° | 800 |
| jezero | rough_terrain | 6,191 | 3,798 | 278 | 3,520 | 0.25 m / 4.5 m | 1,010 |
| jezero | relief | 6,191 | 5,608 | 258 | 5,350 | 3.7 m / 15.9 m | 888 |
| gale | steep_slope | 3,438 | 3,263 | 263 | 3,000 | 15° / 15° | 779 |
| gale | rough_terrain | 3,419 | 2,647 | 296 | 2,351 | 0.25 m / 4.5 m | 978 |
| gale | relief | 3,419 | 3,247 | 283 | 2,964 | 3.7 m / 15.9 m | 863 |
| west_candor | steep_slope | 4,713 | 4,575 | 265 | 4,310 | 15° / 15° | 1,102 |
| west_candor | rough_terrain | 4,676 | 4,248 | 402 | 3,846 | 0.25 m / 4.5 m | 1,515 |
| west_candor | relief | 4,676 | 4,561 | 358 | 4,203 | 3.7 m / 15.9 m | 1,345 |

Other types (method unchanged): jezero: 1,152 data_gap, 208 crater_rim; gale: 600 data_gap, 210 crater_rim; west_candor: 1,200 data_gap, 166 crater_rim. Total hazard features: jezero 16,170, gale 9,967, west_candor 14,750.

### steep_slope points by level

| region | points | severity 3 / 4 / 5 / 6 | rover: caution / no-go (by steepest spot) | Marswalk: caution / no-go (by steepest spot) | rover: ok / caution / no-go (by p95 in the square) | Marswalk: ok / caution / no-go (by p95) |
|---|---|---|---|---|---|---|
| jezero | 5,404 | 659 / 693 / 634 / 3,418 | 1,352 / 4,052 | 659 / 4,745 | 3,165 / 1,358 / 881 | 3,165 / 887 / 1,352 |
| gale | 3,263 | 258 / 276 / 291 / 2,438 | 534 / 2,729 | 258 / 3,005 | 1,238 / 1,102 / 923 | 1,238 / 577 / 1,448 |
| west_candor | 4,575 | 95 / 98 / 167 / 4,215 | 193 / 4,382 | 95 / 4,480 | 732 / 1,165 / 2,678 | 732 / 578 / 3,265 |

`level_rover`, `level_marswalk` and `severity` use `value` (the steepest spot), as the brief specifies. 63–92 % of the points are severity 6 (30° or more). A single steepest value per square is easily set by noise or by one small scarp, and section 6 shows that the DEMs' steep tail is overstated even where a rover drove. West Candor is a canyon: there the square-wide p95 is also rover no-go in 59 % of the squares, against 16 % in Jezero and 28 % in Gale, so much of its steepness is real. The `p95` property, and the two `level_*_p95` properties I added, describe the square as a whole.

Squares at the edge of the coverage: 380 in jezero, 261 in gale, 354 in west_candor steep_slope points come from a source that covers less than half of its square. Their evidence sentence says so.

## 3. Suspect rule as applied, and what it caught (unchanged from phase 2)

Nothing was deleted or corrected. Suspect pixels are flagged in `<dem_id>_suspect.png`, and a hazard gets `suspect: true` when the computation window behind its value touches a flagged pixel (for a 5 m HiRISE slope value: the 15 m square of 1 m pixels it was computed from).

**(a) MOLA consistency.** MOLA 463 m is interpolated bilinearly to every DEM pixel centre (for this check only). A pixel is flagged when

`|(DEM − MOLA) − median(DEM − MOLA)| > max(200 m, 5 × MAD) + local MOLA range`

where MAD is the median absolute deviation of DEM − MOLA over the DEM, and *local MOLA range* is max − min of the 3 x 3 MOLA cells (about 1.4 km) around the pixel. The last term is the looser limit on steep terrain. The base tolerance max(200 m, 5 × MAD) is 200 m in 16 DEMs and 206–257 m in the other 4. (Chosen by Fable.)

**(b) Spikes.** A pixel is flagged when `|z − median3x3(z)| > max(5 × local MAD, 1 pixel size)`, where local MAD is the 3 x 3 median of those absolute deviations. (Chosen by Fable.)

| region | DEM | MOLA-flagged % | spike % | any % | largest MOLA cluster | its centre (lon, lat) | lowest elevation flagged? | highest elevation flagged? |
|---|---|---|---|---|---|---|---|---|
| jezero | hirise_1206 | 0.000 | 0.060 | 0.060 | none |  | -2165 m: no | -1816 m: no |
| jezero | hirise_1118 | 0.000 | 0.075 | 0.075 | none |  | -2408 m: no | -1482 m: no |
| jezero | hirise_1228 | 0.026 | 0.117 | 0.143 | 1,244 m² | 77.3393, 18.5581 | -2812 m: yes | -1616 m: no |
| jezero | hirise_1159 | 0.001 | 0.142 | 0.142 | 213 m² | 77.2817, 18.3923 | -2298 m: no | -1436 m: no |
| jezero | ctx_1228 | 0.000 | 0.009 | 0.009 | 324 m² | 77.5616, 18.1507 | -2734 m: no | -1493 m: no |
| jezero | ctx_1206 | 0.000 | 0.006 | 0.007 | 2,916 m² | 76.9310, 18.6406 | -2609 m: no | -1495 m: no |
| jezero | ctx_1118 | 0.023 | 0.025 | 0.048 | 0.020 km² | 77.5642, 18.3097 | -3162 m: yes | -1376 m: no |
| jezero | ctx_1159 | 0.180 | 0.027 | 0.205 | 0.615 km² | 77.5610, 17.0882 | -3968 m: yes | -235 m: yes |
| gale | hirise_66 | 0.000 | 0.099 | 0.099 | 39 m² | 137.4836, -5.1366 | -3124 m: no | -1734 m: no |
| gale | hirise_608 | 0.000 | 0.139 | 0.139 | none |  | -3481 m: no | -1470 m: no |
| gale | ctx_66 | 0.065 | 0.043 | 0.108 | 0.157 km² | 137.2203, -5.1227 | -5330 m: yes | -122 m: yes |
| gale | ctx_608 | 0.083 | 0.024 | 0.107 | 0.562 km² | 137.7053, -4.8941 | -4879 m: yes | 347 m: yes |
| west_candor | hirise_1029 | 0.000 | 0.089 | 0.089 | none |  | 664 m: no | 1541 m: no |
| west_candor | hirise_376 | 0.000 | 0.241 | 0.241 | none |  | 396 m: no | 2940 m: no |
| west_candor | hirise_482 | 0.002 | 0.330 | 0.332 | 328 m² | -76.7199, -4.6444 | -586 m: no | 3094 m: no |
| west_candor | hirise_1347 | 0.000 | 0.319 | 0.319 | none |  | -577 m: no | 847 m: no |
| west_candor | ctx_1029 | 0.053 | 0.021 | 0.074 | 0.109 km² | -76.5796, -5.2518 | -586 m: yes | 3538 m: no |
| west_candor | ctx_1347 | 0.008 | 0.076 | 0.084 | 0.022 km² | -76.5092, -4.6474 | -606 m: no | 5015 m: yes |
| west_candor | ctx_376 | 0.420 | 0.075 | 0.494 | 2.817 km² | -76.9860, -4.3213 | -483 m: no | 5870 m: yes |
| west_candor | ctx_482 | 0.489 | 0.094 | 0.582 | 1.445 km² | -76.9833, -4.3218 | -946 m: yes | 5706 m: yes |

**Gale set 66 CTX, −5330 m: flagged.** The lowest pixel is at 137.1740°E, -4.8086° (row 1384, column 148). It is 834 m below MOLA at a place where MOLA varies by only 14 m across 1.4 km, so no real pit can explain it. The pixel touches a data gap, which is where stereo matching errors usually sit. Rule (a) flags it; it was not changed or removed.

Where the suspect pixels cluster: MOLA-flagged pixels are almost all in CTX DEMs. Across the ten CTX DEMs, 90 % of them lie within 5 pixels (90 m) of a data gap or the footprint edge, and 48 % of those with a slope value are on slopes of 20° or more. HiRISE DEMs are tied to their CTX DEM, so rule (a) flags almost nothing in them; their flags are spikes.

**Not flagged, by decision (follow-up brief, section 5):** the straight-line artifacts in HiRISE DEMs (detector seams and jitter). They are listed in `manifest.limitations`.

## 4. Sinusoidal scale error (unchanged from phase 2)

With ε = |Δλ · sin φ| (Δλ = longitude distance from the DEM's central meridian, in radians), the largest linear scale error in any direction is a − 1, where a = (√(4 + ε²) + ε) / 2, and the slope error is at most sin θ · cos θ · (a − 1).

| region | DEM | max scale error (%) | worst slope error at 30° (°) | at 45° (°) |
|---|---|---|---|---|
| jezero | hirise_1206 | 0.0181 | 0.0045 | 0.0052 |
| jezero | hirise_1118 | 0.0174 | 0.0043 | 0.0050 |
| jezero | hirise_1228 | 0.0192 | 0.0048 | 0.0055 |
| jezero | hirise_1159 | 0.0166 | 0.0041 | 0.0048 |
| jezero | ctx_1228 | 0.0864 | 0.0214 | 0.0247 |
| jezero | ctx_1206 | 0.0849 | 0.0211 | 0.0243 |
| jezero | ctx_1118 | 0.0799 | 0.0198 | 0.0229 |
| jezero | ctx_1159 | 0.1409 | 0.0350 | 0.0404 |
| gale | hirise_66 | 0.0053 | 0.0013 | 0.0015 |
| gale | hirise_608 | 0.0058 | 0.0014 | 0.0016 |
| gale | ctx_66 | 0.0266 | 0.0066 | 0.0076 |
| gale | ctx_608 | 0.0297 | 0.0074 | 0.0085 |
| west_candor | hirise_1029 | 0.0043 | 0.0011 | 0.0012 |
| west_candor | hirise_376 | 0.0051 | 0.0013 | 0.0015 |
| west_candor | hirise_482 | 0.0044 | 0.0011 | 0.0013 |
| west_candor | hirise_1347 | 0.0041 | 0.0010 | 0.0012 |
| west_candor | ctx_1029 | 0.0216 | 0.0054 | 0.0062 |
| west_candor | ctx_1347 | 0.0211 | 0.0052 | 0.0060 |
| west_candor | ctx_376 | 0.0278 | 0.0069 | 0.0080 |
| west_candor | ctx_482 | 0.0188 | 0.0047 | 0.0054 |

Worst case: jezero/ctx_1159 (a wide CTX strip at 18° N) at 0.141 % scale error, which changes a 45° slope by at most 0.040° at the far corner of the strip. For every HiRISE DEM the worst case is under 0.005°. Against the several degrees of scatter between two DEMs of the same ground (section 5), **the distortion is negligible for slope.**

## 5. HiRISE vs CTX slope at the same 18 m baseline (unchanged from phase 2)

For each of the ten same-set pairs the HiRISE DEM was area-averaged onto its paired CTX grid (cells with any NoData contributor stay NoData), Horn slope was computed at 18 m, and it was compared cell by cell with the CTX slope.

| region | pair | cells | median HiRISE@18 m / CTX (°) | median difference (°) | RMSE (°) | 5th..95th pct of difference (°) | within 5° | correlation r | same side of 15° / 20° / 25° |
|---|---|---|---|---|---|---|---|---|---|
| jezero | hirise_1118 vs ctx_1118 | 160,316 | 9.5 / 9.03 | +0.03 | 6.3 | -9.4 .. 7.12 | 77.6 % | 0.602 | 83.5 / 90.3 / 95.2 % |
| jezero | hirise_1159 vs ctx_1159 | 102,783 | 5.82 / 5.2 | +0.42 | 3.65 | -4.85 .. 6.15 | 87.3 % | 0.725 | 94.1 / 97.4 / 98.9 % |
| jezero | hirise_1206 vs ctx_1206 | 182,338 | 5.37 / 4.54 | +0.55 | 3.93 | -4.56 .. 7.26 | 85.1 % | 0.531 | 95.3 / 98.6 / 99.6 % |
| jezero | hirise_1228 vs ctx_1228 | 164,074 | 9.93 / 9.4 | +0.18 | 5.71 | -8.87 .. 7.78 | 76.5 % | 0.63 | 83.1 / 89.5 / 95.3 % |
| gale | hirise_66 vs ctx_66 | 292,744 | 5.2 / 5.1 | +0.09 | 5.17 | -7.27 .. 8.41 | 77.6 % | 0.435 | 91.9 / 96.6 / 98.6 % |
| gale | hirise_608 vs ctx_608 | 315,081 | 6.47 / 6.66 | -0.17 | 4.08 | -6.45 .. 5.77 | 85.3 % | 0.723 | 91.7 / 95.9 / 98.3 % |
| west_candor | hirise_376 vs ctx_376 | 226,582 | 12.59 / 11.88 | +0.21 | 5.93 | -9.0 .. 9.68 | 71.1 % | 0.76 | 82.9 / 89.6 / 92.5 % |
| west_candor | hirise_482 vs ctx_482 | 199,509 | 17.8 / 16.95 | -0.03 | 6.49 | -10.85 .. 9.53 | 71.2 % | 0.776 | 85.7 / 85.5 / 84.9 % |
| west_candor | hirise_1029 vs ctx_1029 | 97,156 | 5.26 / 5.36 | -0.04 | 3.64 | -6.4 .. 4.07 | 89.7 % | 0.602 | 95.8 / 98.7 / 99.5 % |
| west_candor | hirise_1347 vs ctx_1347 | 47,591 | 12.64 / 12.45 | -0.08 | 8.04 | -14.61 .. 10.4 | 61.0 % | 0.555 | 76.9 / 81.9 / 87.2 % |

**Result: no bias, but large scatter.** The median difference is between -0.17° and +0.55° in all ten pairs. Cell by cell, RMSE is 3.6–8.0°. The last column is the share of cells that the two DEMs put on the same side of each approved threshold. Figures: `reports/figures/slope18_<region>_<pair>.png`.

## 6. Rover-path validation with the approved thresholds

Slope was sampled along the merged NASA/JPL traverse lines, one sample per slope cell (5 m for HiRISE, 18 m for CTX). ok is below 15°; caution is 15–25° (rover) or 15–20° (Marswalk); no-go is 25° or more (rover) or 20° or more (Marswalk).

### jezero: Perseverance (Mars 2020)

Rover-recorded tilt at 708 waypoints (NASA's own `tilt` field): median 7.03°, 95th percentile 16.62°, maximum 20.68° (sol 1578). By the approved limits: rover mode 91.53 % ok, 8.47 % caution, 0.0 % no-go; Marswalk mode 91.53 % ok, 7.63 % caution, 0.85 % no-go.

| DEM (baseline) | path with a slope value (km) | path median / p95 / max (°) | rover mode: ok / caution / no-go (%) | Marswalk: ok / caution / no-go (%) | whole DEM, rover mode: ok / caution / no-go (%) |
|---|---|---|---|---|---|
| hirise_1206 | 0 | not covered | | | |
| hirise_1118 | 0 | not covered | | | |
| hirise_1228 (5 m) | 13.32 | 11.15 / 20.62 / 81.24 | 77.67 / 19.74 / 2.59 | 77.67 / 16.59 / 5.74 | 76.3 / 20.27 / 3.43 |
| hirise_1228 (1 m, comparison only) | | 11.43 / 24.31 / 88.67 | 72.13 / 23.3 / 4.56 | 72.13 / 17.62 / 10.25 | |
| hirise_1228 (18 m, comparison only) | | 11.84 / 17.93 / 23.42 | 79.25 / 20.75 / 0.0 | 79.25 / 19.45 / 1.3 | |
| hirise_1159 (5 m) | 12.62 | 9.66 / 17.76 / 37.57 | 86.88 / 12.92 / 0.2 | 86.88 / 11.38 / 1.74 | 87.26 / 10.98 / 1.76 |
| hirise_1159 (1 m, comparison only) | | 10.35 / 23.8 / 75.22 | 77.33 / 18.33 / 4.34 | 77.33 / 13.86 / 8.81 | |
| hirise_1159 (18 m, comparison only) | | 9.59 / 16.85 / 21.28 | 90.65 / 9.35 / 0.0 | 90.65 / 7.73 / 1.62 | |
| ctx_1228 (18 m) | 46.3 | 4.86 / 17.36 / 42.83 | 88.96 / 10.23 / 0.82 | 88.96 / 8.32 / 2.72 | 93.45 / 5.05 / 1.5 |
| ctx_1206 (18 m) | 33.5 | 6.35 / 21.09 / 46.29 | 86.78 / 10.32 / 2.9 | 86.78 / 7.52 / 5.7 | 93.89 / 4.58 / 1.53 |
| ctx_1118 (18 m) | 46.12 | 5.43 / 17.55 / 43.12 | 88.52 / 10.3 / 1.17 | 88.52 / 8.78 / 2.69 | 91.31 / 6.49 / 2.2 |
| ctx_1159 (18 m) | 46.24 | 6.05 / 19.51 / 53.57 | 88.05 / 9.58 / 2.37 | 88.05 / 7.43 / 4.52 | 92.1 / 5.44 / 2.46 |

DEM slope and rover tilt at the same waypoints:

| DEM | baseline | waypoints | median DEM slope / rover tilt (°) | median difference (°) | 5th..95th pct (°) | DEM share ≥ 20° / 30° (%) | rover share ≥ 20° / 30° (%) | DEM, rover mode: ok / caution / no-go (%) | rover tilt, rover mode: ok / caution / no-go (%) |
|---|---|---|---|---|---|---|---|---|---|
| hirise_1228 | 1 m (comparison only) | 246 | 13.58 / 11.48 | +1.49 | -5.01 .. 16.77 | 17.9 / 4.1 | 2.0 / 0.0 | 61.38 / 31.3 / 7.32 | 79.27 / 20.73 / 0.0 |
| hirise_1228 | 5 m | 239 | 12.94 / 11.57 | +1.29 | -4.78 .. 10.04 | 9.6 / 0.8 | 2.1 / 0.0 | 68.2 / 28.03 / 3.77 | 78.66 / 21.34 / 0.0 |
| hirise_1228 | 18 m (comparison only) | 223 | 13.43 / 12.06 | +0.62 | -4.05 .. 6.63 | 3.6 / 0.0 | 2.2 / 0.0 | 62.33 / 37.67 / 0.0 | 77.13 / 22.87 / 0.0 |
| hirise_1159 | 1 m (comparison only) | 190 | 10.91 / 11.27 | -0.06 | -5.68 .. 12.05 | 9.5 / 3.7 | 1.6 / 0.0 | 77.37 / 17.89 / 4.74 | 86.32 / 13.68 / 0.0 |
| hirise_1159 | 5 m | 181 | 9.91 / 11.09 | -1.05 | -5.35 .. 4.69 | 1.7 / 0.0 | 0.6 / 0.0 | 85.08 / 14.92 / 0.0 | 88.95 / 11.05 / 0.0 |
| hirise_1159 | 18 m (comparison only) | 160 | 9.43 / 11.09 | -0.45 | -4.75 .. 2.82 | 1.2 / 0.0 | 0.6 / 0.0 | 91.88 / 8.12 / 0.0 | 90.62 / 9.38 / 0.0 |
| ctx_1228 | 18 m | 708 | 5.94 / 7.03 | -0.49 | -7.18 .. 9.87 | 2.4 / 0.1 | 0.8 / 0.0 | 88.14 / 11.72 / 0.14 | 91.53 / 8.47 / 0.0 |
| ctx_1206 | 18 m | 499 | 7.84 / 8.82 | -0.46 | -7.49 .. 13.6 | 8.4 / 1.8 | 1.0 / 0.0 | 79.96 / 15.03 / 5.01 | 89.38 / 10.62 / 0.0 |
| ctx_1118 | 18 m | 690 | 6.21 / 7.17 | -0.34 | -7.28 .. 9.79 | 3.3 / 0.0 | 0.9 / 0.0 | 85.94 / 12.75 / 1.3 | 91.3 / 8.7 / 0.0 |
| ctx_1159 | 18 m | 708 | 7.01 / 7.03 | -0.30 | -7.04 .. 12.12 | 4.5 / 1.1 | 0.8 / 0.0 | 85.73 / 12.43 / 1.84 | 91.53 / 8.47 / 0.0 |

Figure: `reports/figures/traverse_slope_jezero.png`.

### gale: Curiosity (MSL)

Rover-recorded tilt at 1388 waypoints (NASA's own `tilt` field): median 7.68°, 95th percentile 17.11°, maximum 29.12° (sol 2692). By the approved limits: rover mode 91.14 % ok, 8.36 % caution, 0.5 % no-go; Marswalk mode 91.14 % ok, 6.63 % caution, 2.23 % no-go.

| DEM (baseline) | path with a slope value (km) | path median / p95 / max (°) | rover mode: ok / caution / no-go (%) | Marswalk: ok / caution / no-go (%) | whole DEM, rover mode: ok / caution / no-go (%) |
|---|---|---|---|---|---|
| hirise_66 | 0 | not covered | | | |
| hirise_608 | 0 | not covered | | | |
| ctx_66 (18 m) | 38.93 | 5.98 / 14.35 / 43.65 | 95.61 / 3.98 / 0.42 | 95.61 / 3.28 / 1.11 | 85.76 / 10.17 / 4.07 |
| ctx_608 (18 m) | 38.93 | 5.47 / 12.73 / 33.2 | 97.69 / 2.17 / 0.14 | 97.69 / 1.48 / 0.83 | 83.95 / 12.15 / 3.9 |

DEM slope and rover tilt at the same waypoints:

| DEM | baseline | waypoints | median DEM slope / rover tilt (°) | median difference (°) | 5th..95th pct (°) | DEM share ≥ 20° / 30° (%) | rover share ≥ 20° / 30° (%) | DEM, rover mode: ok / caution / no-go (%) | rover tilt, rover mode: ok / caution / no-go (%) |
|---|---|---|---|---|---|---|---|---|---|
| ctx_66 | 18 m | 1388 | 6.35 / 7.68 | -1.43 | -9.92 .. 7.22 | 1.6 / 0.3 | 2.2 / 0.0 | 93.44 / 6.2 / 0.36 | 91.14 / 8.36 / 0.5 |
| ctx_608 | 18 m | 1388 | 6.09 / 7.68 | -1.90 | -9.55 .. 5.49 | 1.1 / 0.1 | 2.2 / 0.0 | 97.19 / 2.59 / 0.22 | 91.14 / 8.36 / 0.5 |

Figure: `reports/figures/traverse_slope_gale.png`.

### Does the 5 m baseline fix the noise problem?

Mostly, for the steep tail; not completely.

| HiRISE set | baseline | median difference to rover tilt (°) | spread of the difference, 5th..95th pct (°) | DEM share ≥ 20° (%) | rover share ≥ 20° (%) | DEM share ≥ 30° (%) | rover share ≥ 30° (%) |
|---|---|---|---|---|---|---|---|
| 1159 | 1 m | -0.06 | -5.68 .. 12.05 | 9.5 | 1.6 | 3.7 | 0.0 |
| 1159 | 5 m | -1.05 | -5.35 .. 4.69 | 1.7 | 0.6 | 0.0 | 0.0 |
| 1159 | 18 m | -0.45 | -4.75 .. 2.82 | 1.2 | 0.6 | 0.0 | 0.0 |
| 1228 | 1 m | +1.49 | -5.01 .. 16.77 | 17.9 | 2.0 | 4.1 | 0.0 |
| 1228 | 5 m | +1.29 | -4.78 .. 10.04 | 9.6 | 2.1 | 0.8 | 0.0 |
| 1228 | 18 m | +0.62 | -4.05 .. 6.63 | 3.6 | 2.2 | 0.0 | 0.0 |

- Going from 1 m to 5 m cuts the share of waypoints at or above 30° from 3.7 % and 4.1 % to 0.0 % and 0.8 %. The rover recorded none.
- The spread of the difference to rover tilt narrows (upper end from +12.05° and +16.77° to +4.69° and +10.04°).
- Set 1159 at 5 m is close to the rover (1.7 % at or above 20° against 0.6 %). Set 1228 at 5 m still shows 9.6 % against 2.1 %.
- The 18 m baseline is closer to the rover still. The 5 m baseline keeps more detail and is nearer the rover's own length, at the price of some remaining noise.

### What the classification shows

- Along the real rover paths, 77.67–97.69 % of samples are ok in rover mode, depending on the DEM. The rovers' recorded tilt is ok at 91.53 % (Perseverance) and 91.14 % (Curiosity) of waypoints.
- Rover-mode no-go along the paths is 0.14–2.9 %. By recorded tilt it is 0 % for Perseverance and 0.5 % for Curiosity. The DEMs therefore mark a little more no-go than the rovers experienced.
- Marswalk no-go (20°) along the paths is 0.83–5.74 %; by recorded tilt it is 0.85 % and 2.23 %.
- In Jezero the path has more caution terrain than the DEM average, because Perseverance climbed the delta and the crater rim. In Gale it has less, because Curiosity avoided the steep flanks of Mount Sharp.

### What this does NOT prove

- Rover drivers chose these paths to avoid hazards, so the path is a biased (easy) sample of the terrain.
- Perseverance and Curiosity are ~1-tonne robotic rovers; a crewed rover has a different mass, wheelbase, speed and risk tolerance.
- DEM slope at a 5 m or 18 m baseline is not the tilt the rover experienced; DEM noise raises slopes, most of all at short baselines.
- Slope alone ignores soil strength: sand at low slope has stopped rovers.
- Rover tilt is recorded only where a drive ended, not continuously, and the waypoint position can be off by a few metres relative to the DEM.
- West Candor has no rover, so nothing there is validated against ground truth.

## 7. Deviations from the briefs, and choices they left open

### Phase 2b follow-up

| # | Topic | What the follow-up says | What I did | Why |
|---|---|---|---|---|
| 1 | Best source per square (3.2) | Pick the best source with valid data in the square, then its steepest spot | Applied the same preference per location inside the square (see 'One deviation' at the top) | A source clipping a corner of a square would otherwise hide hazards in the rest of it. Identical to the brief where one source covers the square. |
| 2 | Rough and relief across cameras (3.3) | Roughest spot / largest relief in the square | When HiRISE and CTX both contribute to a square, the winner is the spot with the largest value relative to its own floor | HiRISE and CTX roughness and relief use different windows (5 m and 21 m against 90 m), so their raw values cannot be compared. |
| 3 | `severity`, `level_*` for other types (3.4) | `level_*` for steep_slope only, null otherwise | `severity` is also null for rough_terrain, relief, data_gap and crater_rim | The severity classes are in degrees. |
| 4 | `area_m2` for cell points | Properties as before | `area_m2` = area inside the square at or above the floor, in the winning source | There is no connected region any more. |
| 5 | Extra properties | Listed set | Added `level_rover_p95`, `level_marswalk_p95`, `source_coverage_pct`, `sources_in_cell`; kept `set_id`, `source_file` | See section 2b: the steepest spot alone marks most squares no-go. |
| 6 | HiRISE source order | HiRISE 1; CTX 2, 3, 4… by lowest unknown % | `priority` as specified. Overlapping HiRISE DEMs (Jezero sets 1159, 1206, 1228; some in West Candor) all have priority 1; for hazards they are also ordered by lowest unknown %. `source_order` in `region.json` gives the full order | The hazard method needs a strict order; the app may want the same tie-break. |
| 7 | 5 m block grid (2) | Block-average 1 m → 5 m | Blocks are aligned to the DEM's top-left corner; up to 4 leftover rows and columns at the bottom and right edges get no 5 m slope | They cannot form a full 25-pixel block. |
| 8 | HiRISE grid sampling (2) | Same rules as before at 5 m cells | 5 x 5 sample points per 5 m cell; slope = max of the 5 m slope blocks they fall in | In 7.1 % of valid HiRISE cells the slope is NoData although `unknown` is 0, because the strict 5 m rule gives no slope near gaps. |
| 9 | Crater rims (5) | Keep as is | Method unchanged; a rim measured on HiRISE now uses the 5 m slope, as section 2 of the follow-up requires for hazards |  |
| 10 | CTX slope meta | CTX unchanged | Tiles untouched; added `baseline_m: 18` to the CTX slope `meta.json` | So every slope grid states its baseline. |
| 11 | Overlay size for HiRISE slope | Slope overlay from the 5 m slope | Overlay geometry unchanged (2.5–7.3 m per pixel); each pixel shows its nearest 5 m slope value | Where the overlay pixel is under 5 m, neighbouring pixels repeat a value. |
| 12 | Limitations (6) | At least the eight listed | 15 sentences: the eight, plus 7 from the processing results |  |

### Still in force from phase 2

| # | Topic | What I did |
|---|---|---|
| 1 | Roughness floor | 0.25 m (HiRISE, 5 m window) and 4.5 m (CTX, 90 m window) = 5 % of the window. Chosen by Fable. |
| 2 | Relief floor | 3.7 m (HiRISE, 21 m window) and 15.9 m (CTX, 90 m window) = window × tan 10°. Chosen by Fable. |
| 3 | Data-gap points | Minimum area 100 m² (HiRISE) and 972 m² (CTX); at most 150 per DEM, largest first; the point is the spot farthest from valid data. |
| 4 | Footprint | Valid mask closed over gaps up to about 300 m, holes filled; polygon simplified at 9 m (HiRISE) and 18 m (CTX). |
| 5 | Spike rule | Floor of one pixel size added to the 5 × local MAD test. |
| 6 | crater_rim `value` | Diameter in km for every crater; rim slopes in `rim_slope_max_deg`, `rim_slope_p95_deg`, `rim_coverage_pct`; a rim counts as measured at ≥ 10 % coverage. |
| 7 | Grid NoData | Slope or rough is NoData when any contributor has no value, even if `unknown` is 0: 3,140,708 of 95,664,326 valid cells (3.28 %) over all grids. |
| 8 | rough encoding | Values above 327.67 m saturate (2 cells). |
| 9 | Overlays | Unknown and suspect: marked if any native pixel in the overlay cell is flagged. Hillshade from the DEM averaged to the overlay cell. 14 of 20 DEMs are downsampled to fit 4096 px. |
| 10 | region.json stats | `slope_p50_deg`, `slope_p95_deg` from all CTX DEMs pooled (18 m); HiRISE (5 m) pooled separately. |
| 11 | Traverse | Per-drive segments merged before sampling; display line simplified at 3 m; original waypoint files copied unchanged. |
| 12 | Geology | Clipped to the search box, simplified at 0.002° (about 120 m). |

All rules of the original brief were followed without exception: no DEM was mosaicked, nothing was filled, no outlier was changed, MOLA offsets are stored for display only and are in no grid, no new data source was added, and the approved thresholds are in the manifest exactly as given.

## Self-check results

- **Slope against GDAL** (`gdaldem slope`, GDAL's own Horn implementation): ctx_608 at 18 m, 2,132,532 values, largest difference 0.0065°; hirise_1159 at 5 m, 234,351 values, largest difference 0.0069°; hirise_376 at 5 m, 234,573 values, largest difference 0.0057°. NoData masks identical in all three. For HiRISE the 5 m DEM was rebuilt inside the check with separate code.
- **Three random tiles against the raw DEMs** (unknown, elevation, slope and roughness recomputed per cell with separate code; HiRISE slope from strict 5 x 5 block means and Horn at 5 m; roughness from an explicit least-squares plane): west_candor/hirise_376 tile 1_0: 120 cells, 0 mismatches; west_candor/hirise_482 tile 0_8: 120 cells, 0 mismatches; gale/ctx_66 tile 7_12: 120 cells, 0 mismatches.
- **Hazard points.** 37,351 steep_slope, rough_terrain and relief points: 0 on NoData, 0 values differing from the raster at the point, 0 below the floor, 0 squares with two points of one type, 0 wrong `cell_id`, 0 `level_*` not matching `value` and the thresholds, 0 wrong `severity`, 0 wrong `baseline_m`, 0 points where a more preferred source has a value. For 360 sampled squares the maximum was recomputed by brute force: 0 differences. 2 points lie so close to a square's edge that their coordinates, rounded to 6 decimals (0.06 m), fall in the neighbouring square; `cell_id` is the authoritative square. Of 26 craters with a measured rim, 23 have their centre point on valid data; the others have a covered rim but a centre outside the DEM.
- **GeoJSON.** 14 files, 41,521 features: 0 files with problems (structure, geometry validity, coordinate range, contract 1.1 hazard properties, unique ids).
- **Tile files.** 1,911 tiles in 20 DEMs: 0 problems (files, byte sizes, tile lists, bounds, `nominal_res_m`, `baseline_m`).
- **Overlays.** 80 PNG files: 0 problems.
- **Manifest.** Approved thresholds, severity classes and citations present and unchanged: 0 problems. 15 limitation sentences.

## 8. Open questions for Abdulaziz

1. **Which level should colour a hazard point: the steepest spot or the 95th percentile?** By the steepest spot, 75–96 % of points are rover no-go and the map is nearly all one colour. By p95, 16–59 % are no-go. Both are in the file. I recommend colouring by p95 and showing the steepest spot in the detail panel.
2. **Number of points.** 13,242 steep_slope points over the three regions, about one per square, and `hazards.geojson` is 11–18 MB per region. Options: show only squares whose p95 is caution or no-go; show points only when zoomed in; or raise the floor.
3. **Set 1228 (Jezero HiRISE) is noisier than set 1159**, also at 5 m (section 6). It also sits 37 m off MOLA. If one HiRISE DEM is to be featured in the demo, 1159 is the better-behaved one.
4. **Overlapping HiRISE DEMs** all have priority 1. Should the app use `source_order` from `region.json` as the tie-break, as the hazard points do?
5. **Roughness and relief floors are still my placeholders.** No published limit applies to them (research file, section 5, item 4). The app could hide these two types by default.

## Where things are

| path | contents |
|---|---|
| `manifest.json` | contract 1.1, CRS, regions, citations, approved thresholds with full sources, severity classes, limitations |
| `regions/<region>/region.json` | DEM list in preference order, hazard grid, statistics, notes the app must show |
| `regions/<region>/hazards.geojson`, `craters.geojson`, `footprints.geojson`, `geology.geojson`, `traverse.geojson` | map layers |
| `regions/<region>/validation.json` | sections 5 and 6 in machine-readable form, plus HiRISE 1 m against 5 m statistics |
| `regions/<region>/overlays/` | slope, unknown, suspect and hillshade PNGs with sidecars |
| `regions/<region>/grids/<dem_id>/<var>/` | tiled binary grids and `meta.json` (HiRISE 5 m, CTX 18 m) |
| `reports/THRESHOLDS_RESEARCH.md` | threshold evidence; the approved set is marked at the top |
| `reports/SELFCHECK.json`, `reports/figures/` | check results and figures |
| `code/` | all scripts |
