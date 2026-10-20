# Kp 3-hour forecaster: model card

**Promoted:** `kp3h-mlp-v1-87236383` (see `promoted.json`). Issue: GAU-113. Project: P-GAU-15.

## What it predicts
- Kp **3 hours ahead**, plus **P(Kp ≥ 5−)**, the probability of a G1+ storm (SWPC counts 5−, 5 and 5+ as G1).
- **Inputs:** the last 6 hours (hourly means) of Bz GSM, By GSM, solar-wind speed, density, dynamic pressure and Newell coupling, plus the current Kp. These are exactly the quantities the live pipeline measures, so training and serving use the same features (`ml/kp_model.py`).
- **Model:** an ensemble of 5 MLPs (MLP 37-64-32, heads: Kp (Huber) + storm (BCE)), trained with AdamW lr 1e-3 wd 1e-4, batch 512, early stop on validation (patience 8).
- **Storage:** weights are plain JSON, so there's no pickle, and inference needs numpy only.

## Data and splits
- **Source:** NASA OMNI2 hourly (spdf.gsfc.nasa.gov low_res_omni). The files are downloaded on demand to `ml/data/` (gitignored) and pinned by SHA-256 in the model file.
- **Splits, ordered by time with no shuffling:**
  - train 2010–2019 (86463 h);
  - validate 2020–2021 (17135 h);
  - test 2022–2024 (25483 h, including the May 2024 G5 storm).
- **Determinism:** training is deterministic. A re-run gives identical weights and metrics, and the version name comes from the data checksums.

## Held-out results (2022–2024)
| Metric | Model | Persistence | Climatology |
|---|---|---|---|
| Kp MAE | 0.608 | 0.6732 | – |
| Kp MAE during storm hours | 1.3072 | 1.1099 | – |
| Storm Brier score | 0.023 | 0.03622 | 0.03715 |

- **Brier skill:** +0.3809 against climatology and +0.365 against persistence.
- **At P ≥ 0.5:** the model detects 37% of storm hours, and 28% of its warnings are false alarms.
- **Validation (2020–2021):** MAE 0.5234 against persistence 0.5858; Brier skill against climatology +0.2688.

## Promotion gate (`ml/train/train_kp.py`)
On the test years, the model must:
- beat persistence MAE by at least 5%;
- have a positive Brier skill score against climatology;
- produce only finite outputs.

Result: **passed**. Training only writes a candidate; promotion is a separate, deliberate step (`--promote`) that refuses a failed candidate.

## Known limitations
- **Storm hours:** during storms the Kp value is *worse than persistence*, because the regressor pulls rare extremes toward the mean. Use the **storm probability** for warnings; the UI banner colours by probability for this reason.
- **Timing gap:** OMNI2 solar wind is time-shifted to the bow shock, but the live NOAA RTSW feed is at L1, roughly 30–60 min upstream. Live forecasts therefore see the drivers slightly early. This hasn't been corrected yet.
- **Kp source gap:** live Kp is the NOAA estimated planetary index, while training used Kyoto definitive Kp.
- **Interval:** the "ENSEMBLE" range is the spread across the 5 members, not a calibrated confidence interval.
- **Horizon:** 3 h, set by the L1 lead time. No claim is made beyond it.

## Retrain and promote
```
python3 ml/train/train_kp.py                  # candidate + metrics + gate in registry.json
python3 ml/train/train_kp.py --promote FILE   # only if the gate passed
python3 -I ml/tests/test_kp_model.py
```
