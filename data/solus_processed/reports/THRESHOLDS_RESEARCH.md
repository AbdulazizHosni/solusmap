# SOLUS: danger-threshold research

Date: 2026-11-14. Prepared by Fable for Abdulaziz.

> **Approved on 2026-11-14 (phase 2b).** Abdulaziz chose these limits; they are in `manifest.json` under `thresholds` and are used for `level_rover` and `level_marswalk` on hazard points.
>
> | mode | caution from | no-go from | walk-back warning | evidence rows |
> |---|---|---|---|---|
> | rover | 15° | 25° | 10 km | M8, L4, L1, M4, W6, W7 |
> | Marswalk | 15° | 20° | 2 km | W3, W4, W1, W2, W5 |
>
> The limits are compared with slope at a 5 m baseline (HiRISE) or 18 m (CTX). How they classify the two real rover paths is in `PROCESSING_REPORT.md`, section 6.
> The rest of this file is the evidence as originally gathered. Section 4 lists the options that were offered; the approved rover set combines the caution level of R1/R2 with the no-go level of R2, and the approved Marswalk set is W-B.

## How to read this

- Every number below comes from a document I located during this session. No number is from memory.
- "Read" means I extracted the document text myself and found the sentence. "Helper" means a fetch helper quoted the sentence from the live page and I did not re-read the page.
- **No published slope limit for a crewed Mars rover or for suited walking on Mars was found.** Everything below is lunar (1/6 g), robotic Mars rover, or a concept. Using these values for Mars crews is an assumption that must be stated in the app.
- A slope limit only means something together with the distance it is measured over. The sources that state a length scale use about 5 m (MSL) or the vehicle itself. SOLUS has slope at 1 m (HiRISE) and 18 m (CTX). See section 5.

---

## 1. Rover mode: evidence

### 1.1 Crewed rover: Apollo Lunar Roving Vehicle (the only crewed rover ever driven off Earth)

| # | Value | What it limits or describes | Source | Checked |
|---|---|---|---|---|
| L1 | 20–23°, max 25° | Design slope capability: "The LRVs were designed to navigate a 20 – 23° slope in 'favorable conditions' with a max of 25°." | Jacob, Montalvo, Gray, Britton, Thomas, Miller (NASA JSC), *Apollo Lunar Roving Vehicle as Traversed Performance Metrics: Preparing for Artemis Mobile Vehicle Traverse Planning*, abstract for the 57th LPSC, NTRS record 20250011301 (2026). https://ntrs.nasa.gov/citations/20250011301 | Read |
| L2 | up to 20° | Slopes actually driven straight up and down: "Sloped of up to 20 degrees were easily negotiated in a straight-ahead mode." Climbing at full power the vehicle slowed to 4–5 km/h. | Apollo 17 Mission Report, section 10 (pilot's report), quoted in NASA Apollo Lunar Surface Journal, *Working on the Moon: LRV Performance*. https://www.nasa.gov/wp-content/uploads/static/history/alsj/WOTM/WOTM-LRVPerformance.html | Read |
| L3 | 20–25° | Crew opinion, not a test: "the crew believed that the rover could have negotiated slopes of 20 to 25 degrees without great difficulty, side slope operation never became comfortable." | same (Apollo 17 Mission Report) | Read |
| L4 | 15° | Side-slope (roll) stability: "roll instability would be approached on the 15-degree slopes if the vehicle were traveling a contour line with one crewmember on the downhill side." | Apollo 15 Mission Report, section 9, quoted on the same page | Read |
| L5 | 10–15° | Roll angles experienced: "Going cross-slope or parallel to contour lines produces right or left rolls of 10 to 15 degrees." Also: "the pitch needle was pegged at 20 degrees" on Stone Mountain (the gauge limit, not a vehicle limit). | Apollo 16 Mission Report, section 9, quoted on the same page | Read |
| L6 | (no number) | Parking on slopes: "the only problem associated with steep slopes was the tendency of the vehicle to slide downslope when both crewmen were off the vehicle." | Apollo 15 Mission Report, same page | Read |
| L7 | 30 cm | Obstacle driven over: "An angular 30- centimeter (1-foot) high fragment was traversed by the left front wheel" (the suspension bottomed out). | Apollo 15 Mission Report, same page | Read |
| L8 | 36 cm | Ground clearance, fully loaded. | NASA NSSDCA, *The Apollo Lunar Roving Vehicle*. https://nssdc.gsfc.nasa.gov/planetary/lunar/apollo_lrv.html | Helper |

### 1.2 Crewed and pressurized rover concepts, Artemis mobility

| # | Value | What it limits or describes | Source | Checked |
|---|---|---|---|---|
| C1 | > 10° | Terrain difficulty: "Slopes of more than 10 degrees are common at the lunar South Pole (analogous to unimproved mountain passes), making slope traverses complex." | NASA, *2024 Moon to Mars Architecture Concept Review: Lunar Mobility Drivers and Needs* (white paper, 2024). https://www.nasa.gov/wp-content/uploads/2024/06/acr24-lunar-mobility-drivers-and-needs.pdf | Read |
| C2 | up to 20° | Expected terrain, not a vehicle limit: "Traverses from landing zones to habitation zones could encounter slopes of up to 20 degrees." | same | Read |
| C3 | ~10 km/h | Speed of the Space Exploration Vehicle concept: "It can travel at about 10 kilometers per hour." | NASA, *Space Exploration Vehicle Concept* fact sheet FS-2011-08-045-JSC (2011). https://www.nasa.gov/wp-content/uploads/2015/08/464826main_sev_factsheet_508.pdf | Read |
| C4 | 40° | Claimed climbing ability of the Space Exploration Vehicle chassis: "climbing over rocks and up 40-degree slopes". **Secondary source** (a vendor-supplied trade article). The NASA fact sheet itself gives no slope number. | *Steel Chassis Lets Space Vehicles Traverse Grueling Terrain*, Tech Briefs (2015). https://www.techbriefs.com/component/content/article/23331-steel-chassis-lets-space-vehicles-traverse-grueling-terrain | Helper |
| C5 | not found | A slope or obstacle requirement for NASA's Lunar Terrain Vehicle or Pressurized Rover. I searched and found no published number. | — | — |

### 1.3 Robotic Mars rovers: Curiosity (MSL) and Perseverance (Mars 2020)

| # | Value | What it limits or describes | Source | Checked |
|---|---|---|---|---|
| M1 | 45° | Static stability (tip-over), not a driving limit: "The MSL rover is being designed to a static stability of no less than 45 degrees tilt in any direction... the static stability limit should only be seen as an upper bound for vehicle safety." | MSL Project (JPL), *MSL Landing Site Selection User's Guide to Engineering Constraints*, v2 (2006), section 2.1.3. https://marsoweb.nas.nasa.gov/landingsites/msl/memoranda/MSL_Eng_User_Guide_v2.pdf | Read |
| M2 | 30° | Operating tilt limit: "Nominal vehicle operations would usually be kept at vehicle tilt angles below 30 degrees." | same, section 2.1.3 | Read |
| M3 | 30° | Fault protection in flight: "Tilt fault protection is enabled by default, and the nominal flight tilt limit is 30 degrees. However, the tilt limit is typically lowered for each drive." | Rankin, Maimone, Biesiadecki, Patel, Levine, Toupet (JPL), *Driving Curiosity: Mars Rover Mobility Trends During the First Seven Years*, IEEE Aerospace Conference (2020). https://www-robotics.jpl.nasa.gov/media/documents/2020-mobility-trending.pdf | Read |
| M4 | 25.34° | Largest tilt Curiosity experienced in its first seven years (sol 2477). Max pitch 25.22°, max roll 20.69°. | same, Table 1 | Read |
| M5 | ±15° | Pitch and roll limits when that fault protection is switched on: "The nominal flight pitch and roll limits are +/-15 degrees." | same | Read |
| M6 | < 10° / 10–17° / > 17° | Slip on **loose (granular) material**: under 10° tilt gives 0–25 % upslope slip; 10–17° gives 25–80 %; over 17° gives more than 80 %. "In terrain with slope angles over 20 degrees, vehicle upslope motion can effectively be arrested, with slip rates well over 90% quite common." | MSL *User's Guide to Engineering Constraints* (2006), section 2.1.5 | Read |
| M7 | 30° and more | On **solid rock** the limit is higher: at Endurance crater "favorable surface interaction allowed vehicle access up to and exceeding the system's own operational limit of 30 degrees." | same, section 2.1.6 | Read |
| M8 | 15° over 5 m | Landing-site slope limit that also covers driving: "fifteen degrees or less over a 5 m length scale to ensure landing stability and trafficability of the rover" (table: "trafficability in loose granular material"). | same, section 1.5 and summary table | Read |
| M9 | < 5° / 5–15° / > 15° | Slope classes used for MSL mobility testing: low, moderate, high. | same, section 2.1.3 | Read |
| M10 | 0.5 m | Obstacle (bump or hole) the rover is designed to cross: "a protrusion or hole obstacle of less than 0.5 m in height / depth. This compares to a 0.2-m allowable obstacle height / depth on MER." Landing-site rock height limit in the summary table: 0.6 m. | same, section 2.1.4 and summary table | Read |
| M11 | 60 % / 40 % | Wheel-slip fault limits: 60 % for one occurrence, 40 % for two in a row. A drive faulted at 64.8 % slip with "an uphill rover tilt of 18.1 degrees." | Rankin et al. (2020) | Read |
| M12 | 8 cm | Wheel-damage guideline: "When driving on loose material, minimize wheel contact with rocks taller than 8 cm." | Rankin, Patel, Graser, Wang, Rink (JPL), *Assessing Mars Curiosity Rover Wheel Damage*, IEEE Aerospace Conference (2022). https://www-robotics.jpl.nasa.gov/media/documents/fmwi-rankin-2022-0225-final.pdf | Read |
| M13 | 21° | Steepest slope in one reported climb: a drive "up slopes as steep as 21 degrees" that was stopped by excess wheel slip. | JPL news, *NASA's Curiosity Rover Adjusts Route Up Martian Mountain* (22 May 2015). https://www.jpl.nasa.gov/news/nasas-curiosity-rover-adjusts-route-up-martian-mountain | Helper |
| M14 | 45° / 30° / 40 cm | Perseverance: "designed to withstand a 45-degree tilt in any direction without tipping over"; "rover drivers avoid terrains that would tilt the rover more than 30 degrees"; drives over rocks "up to 15.75 inches (40 centimeters)". | NASA Science, *Mars 2020: Perseverance Rover, Rover Components*. https://science.nasa.gov/mission/mars-2020-perseverance/rover-components/ | Helper |

### 1.4 What the two rovers actually did (measured in this project from NASA data)

From the `tilt` field of the NASA/JPL MMGIS waypoint files in this package (rover body tilt recorded on board at the end of each drive). Full numbers are in `regions/<region>/validation.json`.

| Rover | Waypoints | Median tilt | 95th percentile | Maximum | Share above 20° | Share above 25° | Share above 30° |
|---|---|---|---|---|---|---|---|
| Perseverance, sols 13–2022 | 708 | 7.0° | 16.6° | 20.7° (sol 1578) | 0.85 % | 0 % | 0 % |
| Curiosity, sols 3–5073 | 1388 | 7.7° | 17.1° | 29.1° (sol 2692) | 2.2 % | 0.5 % | 0 % |

Neither rover has a waypoint above 30° in these files, which agrees with the 30° operating limit (M2, M3, M14).

---

## 2. Marswalk mode (suited walking): evidence

| # | Value | What it limits or describes | Source | Checked |
|---|---|---|---|---|
| W1 | up to 20° | Suit capability planned for Artemis: "Walking up/down/across a slope of up to 20° and on traverses of up to 2 km away from the lander (depending on terrain)". | Coan, D. (NASA), *Exploration EVA System Concept of Operations Summary for Artemis Phase 1 Lunar Surface Mission*, EVA-EXP-0075 (February 2020). https://www.nasa.gov/wp-content/uploads/2020/01/topic_1-_eva_lunar_surface_concept_of_operations.pdf | Read |
| W2 | up to 20° | The same capability restated a year later: "Walking up/down/across a slope of up to 20°". | Coan, D. (NASA), *NASA Exploration EVA Integrated HITL Testing and Analogs*, Revision A (31 January 2021), NTRS 20210000827. https://ntrs.nasa.gov/citations/20210000827 | Read |
| W3 | ~17° | Apollo experience quoted by NASA: "Apollo 15 traversed on slopes of ~17°". | EVA-EXP-0075 (2020), same slide | Read |
| W4 | 12°, 16°, 20° | Slopes on NASA's notional Artemis walking traverses: "slopes range up to ~16°", "~12°", "~20°" over 1–2 km. | EVA-EXP-0075 (2020), traverse slides | Read |
| W5 | 2 km, ~2 km/h | Walking range and pace: "Walking Range 2 km... Assumes ~2 km/hr walking pace on relatively level regolith. Does not account for slope or obstacles (boulders)." | EVA-EXP-0075 (2020) | Read |
| W6 | ~10 km | Rover range limited by walking back: "Unpressurized Rover Range ~10 km (~5 hr walk back)"; single pressurized rover ~12 km ("< 8-hr walk back"). | EVA-EXP-0075 (2020) | Read |
| W7 | about 6 miles | Apollo walk-back rule: exploration "was confined to the distance astronauts could expect to walk back wearing spacesuits if their rovers broke down: about 6 miles." | NASA SEV fact sheet FS-2011-08-045-JSC (2011) | Read |
| W8 | < 25° | "Slopes of less than 25° are considered accessible by CLSE". **Not a NASA requirement**; a research poster citing a lunar study group. | Iqbal, W. et al., *Astronaut experiences on the slopes along Apollo EVAs*, EPSC2024-196 (2024). https://meetingorganizer.copernicus.org/EPSC2024/EPSC2024-196.html | Read (poster) |
| W9 | < 15° | "The astronauts climbed up to 150 m during the Apollo missions and walked on slopes of <15°." Secondary source. | same (abstract) | Helper |
| W10 | 60° vs < 30° | People misjudge slopes: Apollo 16 astronauts "overestimated a crater slope as 60° when it was less than 30°." | same (poster) | Read |
| W11 | (no number) | Difficulty: Apollo 15, Station 2: "Soft stuff. Hard to work on the slope, hard to move on the slope... because it's so soft and steep." | same (poster, quoting the Apollo 15 crew) | Read |

---

## 3. Human Mars landing and exploration-zone criteria: evidence

| # | Value | What it limits or describes | Source | Checked |
|---|---|---|---|---|
| Z1 | ±50° latitude, ≤ +2 km | Preliminary limits for human Mars exploration zones: "Preliminary latitude boundaries set at +/- 50 degrees"; "Preliminary elevation boundary set at no higher than +2 km (MOLA reference)". | Bussey, B. (NASA HQ) and Hoffman, S. (SAIC), *Human Mars Landing Site and Impacts on Mars Surface Operations*, IEEE Aerospace Conference (2016), NTRS 20160002370. https://ntrs.nasa.gov/citations/20160002370 | Read |
| Z2 | 100 km | Exploration-zone size: "Surface traversing capability out to 100 km radius and 2-week duration". | same | Read |
| Z3 | 30 cm and 5° | Landing hazard avoidance (the ALHAT system, a **landing** requirement, not a driving one): "Avoid 30 centimeter hazards and 5 degree slopes". | same | Read |
| Z4 | 12° | "Effective Ground Slope = 12°" in a lander touchdown diagram (6° lander attitude). A landing-stability value. | same | Read |
| Z5 | 3° / 5° / 15° / 15° | MSL landing-ellipse slope limits over 2–5 km, 200–500 m, 20–40 m and 5 m. Robotic, for landing. | MSL *User's Guide to Engineering Constraints* (2006), section 1.5 | Read |
| Z6 | not found | A terrain-slope criterion for *driving or walking* inside a human Mars exploration zone. The 2015 workshop material I could read gives none. | NASA, *Human Landing Sites Study (HLS2) Overview* (27 Oct 2015). https://www.nasa.gov/wp-content/uploads/2015/11/hls2-overview-v3tagged.pdf | Read |

All three SOLUS regions pass Z1: they lie within ±50° latitude, and the working areas are below +2 km except the high plateau around West Candor Chasma (CTX elevations there reach about +5 km).

---

## 4. Suggested threshold sets (not applied; Abdulaziz picks)

Each set has a "caution" level and a "no-go" level. The labels after each number point to the evidence rows above.

### Rover mode

| Set | Caution from | No-go from | Basis | Use it if |
|---|---|---|---|---|
| **R1 Loose-soil conservative** | 10° (M6, C1) | 15° (M8, L4, M9) | Slip rises sharply above 10° on loose material; 15° over 5 m is the MSL limit for "trafficability in loose granular material"; the Apollo rover neared roll instability on 15° side slopes. | The surface is unknown or sandy. This is the safest claim SOLUS can make from orbit, because the DEMs say nothing about soil. |
| **R2 Apollo-rover based** | 15° (L4, L5) | 25° (L1, L3) | The only crewed-rover record: 20° slopes "easily negotiated" straight on, design maximum 25°, side slopes uncomfortable from about 15°. | You want the limits of a real crewed vehicle and accept that they are lunar (1/6 g). |
| **R3 Robotic firm-ground upper bound** | 20° (L2, M13) | 30° (M2, M3, M14) | The operating tilt limit of both NASA Mars rovers; neither has a waypoint above it in about 14 and 6 years of driving (section 1.4). | You want the most permissive defensible limit. It assumes firm ground and a slow robotic vehicle. |

45° (M1, M14) is a tip-over angle. It should not be used as a driving limit.

### Marswalk mode

| Set | Caution from | No-go from | Basis | Use it if |
|---|---|---|---|---|
| **W-A Conservative** | 10° (C1) | 15° (W9) | Apollo crews mostly walked on slopes under 15°; soft soil made slopes hard work (W11). | You want margin for a tired crew carrying tools. |
| **W-B NASA suit capability** | 15° (W3, W4) | 20° (W1, W2) | The Artemis suit is specified for walking on slopes up to 20°; Apollo 15 worked at about 17°. | You want to quote a current NASA requirement. This is the best-sourced choice. |
| **W-C Upper bound** | 20° (W1) | 25° (W8) | "Accessible" below 25° according to a non-NASA lunar study group. | Only as an outer limit, and labelled as non-NASA. |

### Optional distance rule (both modes)

A walk-back limit is as well sourced as any slope limit: walking range 2 km from shelter (W5), and about 10 km from shelter for an unpressurized rover (W6, W7). The app could warn when a route goes beyond these distances from its start point.

---

## 5. Limits of this evidence (please show these in the app)

1. **Gravity.** Apollo and Artemis values are for the Moon (1/6 g). Mars is 0.38 g. I found no study that converts them, so applying them to Mars is an assumption.
2. **Soil matters as much as slope.** The same vehicle is limited to about 17–20° on loose material (M6) and can exceed 30° on rock (M7). SOLUS DEMs do not show which one a slope is made of.
3. **Baseline and DEM noise.** A threshold of 15° "over 5 m" (M8) is not the same as 15° at 1 m or at 18 m. This project checked DEM slope against the tilt the rovers recorded at the same waypoints. Typical values agree (median differences under 2°), but the DEMs overstate the steep tail, most of all at a 1 m baseline. Perseverance never recorded more than 20.7° tilt, yet at its own waypoints the HiRISE 1 m slope is above 20° at 10–18 % of them. At the 5 m baseline now used this falls to 2–10 %, and at 18 m to 1–4 %. See `reports/PROCESSING_REPORT.md`, section 6.
4. **Obstacles cannot be seen.** Published obstacle limits are 0.3–0.5 m (L7, M10, M14) and 8 cm for wheel wear (M12). A 1 m DEM cannot resolve rocks of that size. The SOLUS "roughness" layer measures metre-scale unevenness, not rocks, so no published obstacle limit can be applied to it directly. The roughness floors in the package (0.25 m over 5 m, 4.5 m over 90 m) are my own placeholders.
5. **No crewed Mars rover limit exists.** Sections 1.1 and 1.2 are lunar or conceptual, and section 1.3 is robotic. Whichever set is picked, the app should say which vehicle it comes from.

## 6. How the slope colour classes were chosen

The overlay classes are 0–5, 5–10, 10–15, 15–20, 20–25, 25–30 and 30°+. Each edge matches evidence above: 5° (Z3, M9), 10° (M6, C1), 15° (M8, L4, W9), 20° (W1, L2), 25° (L1, M4), 30° (M2, M3, M14). They are display classes and the `severity_classes` 1–6 in the manifest; the approved danger thresholds are the ones at the top of this file.
