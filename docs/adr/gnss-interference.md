# ADR: GNSS interference indicator from open ADS-B data (research note)

- **Status:** Blocked on source terms. No adapter built (see Decision).
- **Date:** 2026-11-18
- **Context:** GPSJam (gpsjam.org) colours hexagons daily by the share of aircraft with poor ADS-B position-accuracy reports. Its FAQ gives no download or licence, so we do not copy its map. We would compute our own indicator over Malaysia (about 0-8N, 99-120E) from an open source, and use GPSJam only as a person's visual cross-check.

## Source terms (checked 2026-11-18)

| Source | What the official page says | Allows Gauss use? |
|---|---|---|
| OpenSky Network | [Terms of use and Data License Agreement](https://opensky-network.org/about/terms-of-use): "Any use by a for-profit or commercial entity ... requires a written license from OpenSky Network, regardless of purpose." Also restricts operational use inside a live product or service. | **No.** Lightbound is a for-profit entity. A written licence is needed. |
| airplanes.live | The [API guide](https://airplanes.live/api-guide) is headed "Non-Commercial Use", with a limit of 1 request/s and no SLA (as quoted by a search snippet; the page returns HTTP 403 to scripted fetches, so the full terms are UNVERIFIED). Live check: `GET https://api.airplanes.live/v2/point/4/102/250` returns an error asking us to email contact@airplanes.live with project links and a description. | **Not clearly.** Access now needs a request to the operator, and the product is non-commercial only. Gauss is a company building a product, so this needs their written answer. |
| ADS-B Exchange | Its [support FAQ](https://support.adsbexchange.com/hc/en-us/articles/37363886073613-I-m-building-a-project-for-my-company-but-we-aren-t-making-money-off-of-it-can-I-get-a-free-API-key) says a project for a commercial entity needs a commercial API licence even if internal and unsold. Personal tier is paid (RapidAPI); enterprise is quote-based. | **No** (paid; the brief rules out purchases). |

## Decision

None of the three clearly allows this use by a for-profit early-stage company at no cost, so **no adapter or ingest is added**. Next step for a person (Josh): email contact@airplanes.live as their API message asks (project description, public repo link, hourly polling of one region, only accuracy fields and counts kept, no callsigns or tracks), and keep their written reply with this note. Do not use OpenSky or ADS-B Exchange without a licence. A self-run ADS-B receiver feeding our own Malaysia box would avoid the terms question, but needs hardware and is out of scope here.

## Design to build once a source is cleared (not built)

- Poll one point query (radius under 250 nm covers peninsular Malaysia; Borneo needs a second point), hourly or slower, honouring the source's rate limit with exponential back-off on 429/5xx.
- Keep only `nac_p` (Navigation Accuracy Category for Position) and `nic`, aircraft count and a 0.5-degree cell. Never store hex codes, callsigns, registrations or tracks. Drop rows with missing or malformed accuracy fields.
- GPSJam's published method: an aircraft report is "bad" at NACp below 8; a cell is coloured by the share of bad reports: under 2% good, 2-10% some, over 10% bad (see [GPSJam FAQ](https://gpsjam.org/about)). UNVERIFIED here: the page was not fetched; check the thresholds before coding them.
- Minimum-sample rule: a cell is painted only with at least 10 distinct aircraft-hours in the day (value TBC against data), else "insufficient".
- Store one small daily summary per cell: `{ date, cell, nTotal, nBad, share, class, source, observedAt }`, read-only on the feed behind `API_POLICY`.

## Analysis plan (no claims yet)

Keep the daily indicator beside the daily ionosphere TEC summary (GloTEC over Malaysia, PR #309, REQ-ION-001..008). The aim is to tell intentional interference from natural equatorial scintillation:

| Feature | Jamming / spoofing | Equatorial scintillation |
|---|---|---|
| Local time | Independent of local time | Post-sunset onset (about 19-24 LT), equinox peak |
| Space | Localised, fixed to a source | Broad, follows the equatorial anomaly crests (about +/-15 deg magnetic latitude) |
| Persistence | Persistent over days | Season and solar-cycle dependent, tied to space weather |
| Co-variate | Unrelated to TEC gradients | Co-occurs with large TEC gradients and plasma bubbles |

Method: (1) bin hourly cell shares by local time (UTC+8, Malaysia) to test for the post-sunset peak; (2) correlate daily share with TEC gradient and with Kp/Dst as controls; (3) flag cells with elevated share in all local-time bins on at least 3 consecutive days. Report associations only, with sample sizes. Caveat: ADS-B NACp also degrades from airframe and avionics faults, so a small aircraft count per cell needs the minimum-sample rule.

## Requirements

Reserved IDs: REQ-GNSS-001.. (REQ-ION-xxx belongs to PR #309). None are added now because no behaviour changes.
