# Stability and redundancy process

This is how Constellation stays stable. It follows the NASA Systems Engineering Handbook (SP-2016-6105 Rev 2), scaled down to a small team and a single host.

| Handbook process | What we do | Tool |
|---|---|---|
| §6.2 Requirements management | Every requirement has an ID, a "shall" statement, a rationale, a Linear parent, an owner and a verification method (T/A/I/D) | `requirements/requirements.json` |
| §5.3 Verification | Each requirement maps to passing tests or inspected evidence; a renamed test fails the gate | `npm run verify` → `test-results/verification/vcrm.md` |
| §6.4 Technical risk (FMEA) | Each failure mode has detection, mitigation, 5×5 risk, residual risk and fault-injection proof, or a recorded gap | `requirements/fmea.json` (checked by `npm run verify`) |
| §6.7 Technical assessment | Measures with green/amber/red thresholds and margins, including live forecast skill and free disk | `GET /api/system/tpm`, `npm run tpm` |
| §6.5 Configuration management | Only verified commits are tagged; only verified tags on `main` are deployed; every deploy is recorded | `scripts/release/create-tag.sh`, `npm run deploy` |
| §5.5 Transition | Health check after each deploy; automatic rollback when unhealthy | `npm run deploy`, `npm run rollback` |

## The loop

1. **Change:** work on a branch named from the Linear issue. Run `npm run verify -- --no-build` while iterating.
2. **Gate:** before merging, run `npm run verify`. It must end with `✅ VERIFY PASSED`. Attach `vcrm.md` to the PR.
3. **New behaviour:** add or extend a requirement in `requirements.json`. For a new way the system can fail, add an FMEA row with a fault-injection test.
4. **Release:** on a clean `main`, run `bash scripts/release/create-tag.sh vX.Y.Z`. It runs verify and records the result in the tag.
5. **Deploy:** run `GAUSS_LIVE_CHECKOUT=<live checkout> npm run deploy -- vX.Y.Z`. Use `--dry-run` first if unsure. An unhealthy release rolls back by itself.
6. **Operate:** `npm run tpm` reports green, amber or red. Amber means a margin is shrinking, so act before it turns red. Red means an FMEA mitigation has been breached.
7. **Undo:** run `npm run rollback`.

## Open risks (from the FMEA)

- **FM-13, single host (residual risk 20/25):** everything runs on one laptop. Planned fix: a warm standby on the Talos host, with data replication and Tailscale failover. That needs SSH access and approval.
- **FM-14, disk filling:** the measure exists, but `npm run tpm` isn't yet scheduled with an alert. Planned fix: a launchd job every 10 min that sends a phone alert on red. That needs approval for a launchctl change.

Review this table whenever an FMEA row or residual risk changes.
