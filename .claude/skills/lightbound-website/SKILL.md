---
name: lightbound-website
description: Map, release modes, tests and copy rules for the lightbound.space Cloudflare Worker (website/): public pages, pilot briefs, Cloudflare Access sign-in, /app workspace, /app/admin, Stripe. Use before changing website pages, worker routes, client onboarding links or website tests.
---

# lightbound.space

## Map
| What | Path |
|---|---|
| Pages (static) | `website/public/` (`/`, `/gauss/`, `/gauss/apply/`, `/gauss/evidence/`, `/constellation/`, `/argo/`, `/education/`, `/app/`, `/privacy/`, `/terms/`) |
| Worker entry, API routes | `website/worker/index.js` (`/api/apply`, `/api/stripe/webhook`, health) |
| Release gate | `website/worker/release.js`; `RELEASE` in `website/wrangler.jsonc` (`"public"` live; `"full"` opens sign-in, forms, payments) |
| Signed-in side | `website/worker/app.js` (workspace + admin), `auth.js` (Cloudflare Access token), `tiers.js`, `stripe.js`, `forms.js` |
| Live data on pages | `website/worker/feeds.js`, `data.js` |
| Tests | `website/test/site.test.mjs`, `website/test/worker.test.mjs` (`npm run test:website`: runs both releases) |
| Audit | `website/tools/audit.mjs` (`npm run audit:website`; needs a running preview) |
| Full docs | `website/README.md` ("Launch", "Opening accounts later") |

## Rules
- No client-side JavaScript, no third-party requests, no secrets in `wrangler.jsonc`; secrets are Worker secrets.
- Both releases must pass the tests. Pages that only exist in full are marked `<!--full-->` / closed in public.
- Copy: honest, no untrue claims, never "compliant", "certified", "space-qualified" or "post-quantum". Never say how payment is taken. Turnstone: mark + "Classified." only.
- Deploys are Josh's (Cloudflare login). Agents build, test and give a preview command.

## Security self-check (before handing back; report each item as pass / n/a / fixed)
Built from the 17 Nov review of #289 and #290, where both needed fixes after hand-back.
1. **Who:** every `/app` and `/app/admin` path checks the Access identity on the request, and reads the account from that email, never from a form field, query or path. Admin actions also check the admin list.
2. **Writes:** every POST passes `sameOrigin`. No state changes on GET.
3. **Overwrites:** forms that save a record don't silently wipe fields they didn't post. Re-adding an existing record is refused or merges, and a test proves it.
4. **Platform budgets:** no KV `list()` (or other metered call) on every page load or per row of a list. Keep a count on the record, and call only when it's needed. A failing KV call degrades the page, never 500s it for everyone.
5. **Files:** uploads are admin-only with a hard streamed byte cap, an allowlist of types checked by content (magic bytes or parse), names rebuilt to `[A-Za-z0-9._-]`, and a per-account count cap. Downloads build the key from the signed-in identity and send `Content-Disposition: attachment`, `nosniff`, a fixed content type and `no-store`.
6. **Output:** every value from users, admins, Stripe or the query passes `esc()`. Links pass `linkable()` (no `//` or `/\` host tricks). Query values are allowlisted.
7. **Releases:** new pages and routes are closed (404) in `RELEASE: "public"`, and a test asserts it.
8. **Data:** anything stored about a person has a stated retention, or a note that Josh must decide one. No email, token or file content in logs.
9. **Races:** read-modify-write on the same KV key from two paths (webhook vs admin) is either re-read just before the put, or named as accepted risk in the PR.
10. **Tests:** each item that applies has a test in `website/test/`, and the PR body lists the self-check results.

## Checks
```sh
node --test website/test/site.test.mjs website/test/worker.test.mjs   # no installs needed
```
Preview (needs installed dependencies): `npm run site:dev` (full) or `RELEASE=public npm run site:dev:offline`.
