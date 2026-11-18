# Argo update: signed releases

**Status: DRAFT design with a first implementation (GAU-238, 2026-11-10). No release key exists, so no device can
update this way yet. Changes to this design or to `tools/argo/update.go` are crypto changes: Josh reviews and merges.**

Josh's decision (10 Nov 2026): the autoupdater is "Argo on every device". This is how a device learns that a newer
Argo exists and, when a person says so, replaces its own binary without having to trust the network or the hub.

## Design in one page

- **One root of trust:** an Ed25519 release public key (RFC 8032, Go `crypto/ed25519`) compiled into Argo
  (`releasePublicKey` in `update.go`). It is **empty today**. With no key pinned, `argo update` fetches nothing,
  reports that, and `apply` refuses ("no release key pinned").
- **Release manifest** (JSON, at most 64 KiB):

  ```json
  {
    "version": "0.2.0",
    "commit": "0123abc",
    "created": "2026-11-10T08:00:00Z",
    "expires": "2026-12-10T08:00:00Z",
    "artifacts": {
      "darwin/arm64": { "url": "https://…/argo-darwin-arm64", "sha256": "<64 hex>", "size": 9437184 },
      "linux/amd64":  { "url": "https://…/argo-linux-amd64",  "sha256": "<64 hex>", "size": 9123456 }
    }
  }
  ```

- **Detached signature:** `<manifest URL>.sig` holds the base64 Ed25519 signature over the bytes
  `"argo-release-manifest-v1\n"` followed by the exact manifest bytes. The prefix means a signature the release key
  made for anything else is never a valid manifest signature.
- **Order of checks** (`verifyManifest`): signature first, before any field is read; then expiry (and a 90-day cap on
  a manifest's lifetime); then version (strictly newer than the running Argo, and not older than the newest version
  this device has ever verified); then a build for this `GOOS/GOARCH`; then that build's size (1 byte to 100 MB),
  SHA-256 and URL.
- **Fetching:** https from anywhere with normal certificate checks, or plain http only from this machine or a tailnet
  address: the same rule the hub client uses (`tailnetOnly` in `main.go`). No redirect is followed, proxy variables
  are ignored, URLs with credentials are refused.
- **Applying** (`argo update apply`): download to a new 0600 file in the binary's own directory, stop at the signed
  size, compare SHA-256; run the new file with `version` and require `argo <manifest version>`; copy the current binary
  to `<binary>.prev`; rename the new file over the binary (atomic on one filesystem); run it again; if that fails,
  rename `.prev` back.
- **Never automatic.** There is no code path that applies an update without a person running `argo update apply`. The
  minute tick only checks, at most once a day, and only once a key is pinned; the answer feeds the `argo` posture
  item (`warn` = a newer signed release exists), which reaches `/mesh` in the posture line.
- **macOS:** `apply` refuses unless `--reset-mac-permissions` is given, and says why: macOS ties the Messages
  automation and Full Disk Access grants to the binary's ad-hoc signature, so replacing the binary silences phone
  texts until someone clicks Allow at the Mac. This stays until Argo is signed with a stable identity.

State: `~/.local/state/argo/update.json` (0600): last attempt, last verified check, newest version ever verified.

## Threat model

Assets: the Argo binary on every device (it holds the device token and relay keys, and runs every minute as the
user). The attacker wants to run their code as Argo, or keep devices on a version with a known flaw.

| Threat | What the attacker has | Defence | Left over |
|---|---|---|---|
| **Malicious or compromised hub** | Full control of what the Gauss hub serves | The hub is only a file server here. The manifest is trusted only through the pinned key; the build only through the SHA-256 and size inside the signed manifest. | The hub can withhold updates (see freeze). |
| **Network attacker (MITM)** | Can read and change traffic, answer DNS, present their own certificate | Same as above; TLS verification is never turned off; no redirects; no proxies from the environment; plain http only on loopback or the tailnet (WireGuard underneath). | Can block the fetch (see freeze). Can see that a device asked for an update. |
| **Rollback / downgrade** | An old, correctly signed manifest for a flawed version | A manifest is refused unless its version is strictly newer than the running one. | A device that never saw the newer release can be given an older one that is still newer than what it runs, until that manifest expires. |
| **Replay of an older release** | A correctly signed, unexpired manifest older than one the device has seen | The device remembers the newest version it ever verified and refuses anything older. | The floor lives in a local state file; deleting it (local access) removes it. |
| **Freeze** (hiding that a newer release exists) | Can block or replay responses | Every manifest expires (and may not be valid for more than 90 days), so "nothing new" cannot be claimed forever. A check that did not verify is never recorded as a check: after 3 days without one the posture item turns `unknown`, visible on `/mesh`. | Up to the manifest's remaining lifetime of staleness. Shorter lifetimes need more frequent signing. |
| **Release key compromise** | The private release key | None in the client: whoever holds the key can sign a build every device accepts when its owner runs `apply`. Mitigations are procedural: keep the key offline or on a hardware token; nothing applies by itself, so a person is in the loop on each device. | **No rotation or revocation exists.** Replacing the key needs a new Argo installed by hand on every device. See open decisions. |
| **Partial write** (power loss, disk full, killed mid-update) | Nothing; an accident | The download goes to a separate temp file and is removed on any error; the binary is replaced with one rename; the previous binary is kept as `.prev` and restored if the new one does not run in place. | A crash between the rename and the second run leaves the new binary in place (it already ran once from the temp file). A stray `.argo-update-*` file can be left by a hard kill. |
| **Wrong platform** | A mistake in the release, or a manifest without this platform | No entry for this `GOOS/GOARCH`: refused. A mislabelled build fails the "must run and report its version" step before anything is replaced. | None known. |
| **Oversized download** (disk filling) | Controls the download server | Size is in the signed manifest and capped at 100 MB; the download stops one byte past the signed size. | None known. |
| **Local attacker with the user's rights** | Can already replace the binary | Out of scope: the update path gives them nothing new. | |

The clock matters: expiry is judged by the device's clock. A device whose clock is far behind accepts an expired
manifest; a manifest dated more than a day ahead of the device is refused.

## Where the manifest is served from (decision needed, nothing built)

Argo looks, in order, at `--manifest URL`, the `ARGO_UPDATE_MANIFEST` variable, and then
`<gauss_url>/argo/release/manifest.json` on the hub the device is enrolled with. **No such hub route exists; this
change adds none.** Options:

1. **The Gauss hub over the tailnet** (drafted default). Devices already reach it; the files are static; no
   third party. The hub cannot forge a release, only withhold one. Needs a small static route and a place on the hub
   for release files, outside the public API allowlist.
2. **A release host on the public internet over https** (for example release assets of the repository). Works for
   devices off the tailnet; adds a third party that sees which addresses ask.
3. **Both**, the hub first.

## Not built yet

- **A signing tool and release procedure.** Nothing in the repository creates the release key or signs a manifest;
  tests make throwaway keys in memory. The exact signing input is given above.
- **Key rotation or a second (offline root) key.**
- **A stable macOS signing identity**, which would remove the permissions reset and the macOS flag.
- **"Update available" as a phone text.** Today it shows only as the posture item on `/mesh` and in `argo posture`.
- **Reproducible builds / build provenance.** The manifest carries a commit, but nothing checks that the binary was
  built from it.

## Tests

`tools/argo/update_test.go`, one or more per rule: no key pinned; bad, missing, wrong-key, wrong-context signature;
expired, undated, over-long and future-dated manifests; equal and older versions; replay below the remembered floor;
wrong platform; size cap, short, long and altered downloads; the URL rule; redirects; untrusted TLS certificate;
backup and atomic replace; new binary that does not run or reports another version; restore when the new binary fails
in place; the macOS flag; the daily, check-only tick.

## Open decisions for Josh

1. Where the release private key lives and who can sign (hardware token, offline machine).
2. Manifest location (options above) and the manifest lifetime to sign with (drafted maximum: 90 days).
3. Whether to add key rotation before the first key is pinned (cheaper now than after devices are in the field).
4. Whether Linux hosts and containers may ever apply by themselves (drafted: no, everywhere).
