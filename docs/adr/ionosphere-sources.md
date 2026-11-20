# ADR: Ionosphere data sources and the scintillation-risk idea

- **Status:** Proposed, awaiting approval (no Linear issue yet: TBC)
- **Date:** 2026-11-18
- **Context:** Malaysia lies under the equatorial ionization anomaly (EIA). After sunset, plasma bubbles there cause amplitude and phase scintillation that degrades GNSS. Gauss wants, eventually, a scintillation-risk indicator for GNSS users. This ADR records what is ingested now, what is not, and what must be true before anything operator-facing is said.

## Decision

Ingest **NOAA SWPC GloTEC** as a regional TEC summary over Malaysia (`backend/adapters/glotec.ts`, source id `glotec-swpc`, field `ionosphere` on the canonical point). Do not compute or show a scintillation index yet.

## What is ingested

| | |
|---|---|
| Product | GloTEC Total Electron Content, a data-assimilative model (Gauss-Markov Kalman filter on ground GNSS and F-region profile observations); operational since Feb 2025 (NCEI product page, https://www.ncei.noaa.gov/products/space-weather/space-weather-prediction-center/products-and-data) |
| URLs | Index `https://services.swpc.noaa.gov/products/glotec/geojson_2d_urt.json` (about 4.5k entries, 510 KB; read as a 3 KB byte-range tail); file `.../products/glotec/geojson_2d_urt/glotec_icao_YYYYMMDDTHHMMSSZ.geojson` (2.4 MB) |
| Format | GeoJSON FeatureCollection, 5184 Point features, 5° longitude x 2.5° latitude; properties `tec` (TECU, file metadata range 0-300), `anomaly` (TECU), `hmF2` (km), `NmF2` (m^-3), `quality_flag` 0-5 |
| Cadence | 10 min model steps; the 01:35Z step was listed at 02:01Z on 18 Nov 2026, so a healthy reading is already about 26 min old. Freshness bound 60 min (`shared/policy/freshness.json`, `glotec_tec`) |
| Access | No login. Server sends `access-control-allow-origin: *`. Some clients without a browser user agent were refused with HTTP 403 in a manual check (WebFetch); Node `fetch` is used by the other SWPC adapters and is expected to work, but that is not yet verified from the live service |
| Licence / terms | UNVERIFIED. SWPC's GloTEC page states no data licence and links the NOAA/NWS disclaimer (https://www.spaceweather.gov/products/glotec). It is a US-government product; credit NOAA SWPC and keep the caveats below. Check again before any redistribution |
| `quality_flag` | SWPC: mean number of F-region observations in the vertical profile, rounded up, capped at 5. Flag 0 means no observation; TEC there relaxes toward IRI-2016 climatology driven by F10.7. The adapter therefore reports `constrainedCells` (flag >= 1) next to `cells` |

The adapter keeps cells with centres at 2-7 N, 100-119 E (8 cells: lat 3.75 and 6.25, lon 102.5, 107.5, 112.5, 117.5), reports mean, min and max TEC, the cell nearest Kuala Lumpur, and the rate of change (TECU/h) of the regional mean against a step 20-90 min older. The global grid is parsed, summarised and dropped. At 5° x 2.5° resolution a plasma bubble (tens to hundreds of km) is not resolved.

## What is not ingested (yet)

- **NASA CDDIS IONEX maps** (IGS combined, `gnss/products/ionex`): need an Earthdata login. Later option only; Josh creates any account.
- **GIRO / DIDBase ionosondes** (https://giro.uml.edu/didbase/): data are "free to scientists" under the Rules of the Road (provenance and acknowledgement duties, co-authorship offered to data owners); numerical access is through SAOExplorer or a read-only account, not a plain no-login JSON API. Whether a station near Malaysia reports to DIDBase is UNVERIFIED (check the Fast Station List, https://giro.uml.edu/ionoweb/). Later option for foF2/hmF2 validation, after reading the Rules of the Road and agreeing acknowledgement wording.
- **Scintillation indices (S4, sigma-phi) and ROTI**: need dual-frequency GNSS receiver data at 1-50 Hz (or 30 s RINEX for ROTI). Open networks (IGS, regional CORS) exist but have not been assessed for terms.

## The scintillation-risk idea, and why it needs validation

TEC and its gradients are a necessary background, not a scintillation measurement. Scintillation is caused by metre-to-kilometre irregularities (equatorial spread F), which a 2.5° x 5° assimilation map smooths out. A candidate indicator would use local time (post-sunset), the pre-reversal enhancement signature (rapid TEC and hmF2 change near the EIA crests), season (equinox maxima), and solar flux. Before any operator-facing claim it must be compared with published S4 or ROTI from Southeast Asian receivers over at least one equinox season, with hit rate and false-alarm rate reported, and with a persistence baseline. Until then Gauss shows TEC with its source and time and says nothing about scintillation risk. No public copy claims.

## Consequences

- Ranges are checked (TEC 0-300 TECU, lat/lon on the globe), a bad file never replaces the last honest reading, and an old reading becomes null.
- Requirements: REQ-ION-001 to REQ-ION-008 (`requirements/requirements.json`).
- Bandwidth: one 2.4 MB file per 10-min step (about 350 MB per day) plus one baseline file after a restart. On a metered link, lengthen `GLOTEC_MS` or switch the source off with `sources`.
