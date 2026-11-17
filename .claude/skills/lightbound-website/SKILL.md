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

## Checks
```sh
node --test website/test/site.test.mjs website/test/worker.test.mjs   # no installs needed
```
Preview (needs installed dependencies): `npm run site:dev` (full) or `RELEASE=public npm run site:dev:offline`.
