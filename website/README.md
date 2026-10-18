# lightbound.uk

The Lightbound site: a black-hole landing ("Carry hope, go beyond.") with three doors, Gauss,
Constellation and Turnstone. It is one Cloudflare Worker with static assets. There is no client-side
JavaScript, no third-party requests, and no secrets.

| Page | What it is |
|---|---|
| `/` | Hero: the brand kit's ray-traced black-hole film. Doors show live data: Gauss shows space weather now, Constellation shows the next launch, Turnstone is classified. |
| `/gauss/` | The GAU-12 evidence-first Gauss page (replay pilot, claims and boundaries). Ends with the other doors (Constellation shows the next launch). |
| `/constellation/` | The community: next 10 launches worldwide, space weather now, a calendar feed, intel rules, and how to join. Ends with the other doors. |
| `/turnstone/` | Mark and "Classified." only (secret project; `noindex`). |
| `/gauss/apply/`, `/constellation/apply/` | Application forms (plain HTML, no JavaScript). Plan links preselect the plan. |
| `/app/` | Signed-in Gauss workspace: the customer's plan, pilot progress, space weather, what the next plan adds. |
| `/app/admin/` | For `ADMIN_EMAILS`: approve or decline applications, set each account's plan, pilot step and membership. |
| `/privacy/` | What is kept, why, for how long, and how to have it deleted. |
| `/api/launches`, `/api/launches.ics`, `/api/space-weather`, `/api/health` | JSON, a calendar feed and a health check. |

Flow, all in CSS:
- The header sticks on every page. On the landing page it starts clear over the film and turns solid
  as you scroll.
- A door's mark flies into the page it opens (native view transitions). There are none when the
  visitor asks for reduced motion, and older browsers just load the page.
- On phones the doors go compact (mark left, words right), so all three fit in about one screen.

## How it runs itself

```
cron every 15 min ──► worker/feeds.js ──► KV (feed:launches, feed:weather)
                       │  Launch Library 2 (every 30 min)          ▲
                       │  NOAA SWPC scales, Kp, solar wind         │ read only
visitor ──► Cloudflare ─┬─ static file (free, no Worker run) ──────┘
                        └─ /, /gauss/, /constellation/, /api/* ──► worker/index.js fills the live sections
```

- **No visitor ever triggers an upstream call.** Pages only read KV. Launch Library 2 allows 15
  anonymous calls an hour ([thespacedevs.com/llapi](https://thespacedevs.com/llapi)); the cron makes 2.
- **Failures are safe.** If a feed fails, the last good data stays up. After 45 minutes (weather) or
  2 hours (launches), the page labels it "Stale · as of …". With no data at all, the section says
  so plainly. Nothing is ever invented.
- **One URL to watch:** `https://lightbound.uk/api/health` returns 200 when both feeds are fresh and
  503 otherwise, with each feed's age and last error. Point any uptime monitor at it. Worker logs are
  in the Cloudflare dashboard (observability is on).
- **Day to day there is nothing to do.** No servers, no database, no keys to rotate.

### Free-plan usage (Cloudflare docs, checked 2026-10-17)

| Limit (Free plan) | This site |
|---|---|
| Static asset requests: free and unlimited ([billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)) | Every image, font, film and CSS file |
| Worker requests: 100,000 a day ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | One per view of `/`, `/gauss/` or `/constellation/`, plus API calls |
| Cron triggers: 5 per account | 1 |
| KV: 100,000 reads and 1,000 writes a day ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)) | 2 reads per live page view; at most 192 writes a day |

## Applications, sign-in and plans

```
apply form ──POST /api/apply──► DATA KV  app:<id>  (deleted automatically after 180 days)
                                   │
admin /app/admin/ ── Approve ──────┴──► DATA KV  acct:<email>  { plan, pilot step, membership }
                                                     │
customer ── /app/ ── Cloudflare Access (email one-time code) ──► Worker verifies the signed JWT,
                                                     └────────── reads acct:<email>, shows the workspace
```

- **Plans** live in `worker/tiers.js`: Tactical Fleet (now), Active Mission Defense and Sovereign
  Shield (gated). The names come from the Lovable build. What each plan includes follows the gated
  roadmap; the Lovable feature claims (automated mitigation, a quantum surrogate, fixed warning
  times) are left out, and a test keeps them out. **List prices are hidden** (`SHOW_PRICES = false`)
  until you approve them (GAU-65).
- **No passwords anywhere.** Cloudflare Access proves who someone is by emailing a one-time code.
  The Worker checks Access's signed token (key, audience, issuer, expiry) and never trusts a plain
  email header. The account record decides what they see; unknown emails get the "apply" page.
- **Forms are hardened:**
  - Same-origin posts only.
  - A hidden honeypot field drops bots.
  - At most 5 applications an hour per connection, counted against a hashed IP address (never the
    raw one).
  - The server validates every field and escapes all output.
  - Post/redirect/get, so refreshing never resubmits.
- **Locally:** `npm run site:dev`, then open `/app/`. A local key pair stands in for Access, and you
  can sign in as the admin, a demo pilot customer, or a signed-in visitor with no plan.

## Change things

| To change | Edit |
|---|---|
| Hero line, door text | `public/index.html` |
| Gauss copy (keep the claim rules; the tests enforce them) | `public/gauss/index.html` |
| Constellation copy, intel rules, join route | `public/constellation/index.html` |
| Colours, type, layout | `public/assets/site.css` (Brand Room tokens; the tests reject off-palette colours) |
| Marks, fonts, film (after the brand kit changes) | run `tools/build_assets.py` (header says how) |
| Plans, what they include, prices on/off | `worker/tiers.js` |
| Application questions | `worker/forms.js`, then `npm run site:forms` (copies them into the static pages) |
| Feed sources or refresh timing | `worker/feeds.js` (`SOURCES`, `FEEDS`) |
| How live sections look | `worker/render.js` |
| Security headers | `worker/headers.js` **and** `public/_headers` (a test keeps them identical) |

## Preview and test locally

```bash
npm run site:dev            # http://127.0.0.1:8788, live feeds, the real Worker code
npm run site:dev:offline    # same, with recorded feed data (no network)
npm run test:website        # pages, claims, Turnstone secrecy, headers, budgets, feeds, routes
```

`dev.mjs` emulates Cloudflare: assets with `_headers`, trailing slashes, the 404 page and byte
ranges; the `run_worker_first` routes from `wrangler.jsonc`; an in-memory KV; and the cron.

## Deploy (Pallas runs these; they need your Cloudflare login)

One time:

```bash
cd website
npx wrangler@4 login
npx wrangler@4 kv namespace create LIVE    # feed cache: paste the id into wrangler.jsonc
npx wrangler@4 kv namespace create DATA    # applications and accounts: paste the id too
npx wrangler@4 deploy                      # live at https://lightbound-site.<account>.workers.dev
```

Sign-in, once (Cloudflare dashboard > Zero Trust):
1. Settings > Authentication: turn on **One-time PIN**.
2. Access > Applications > Add > Self-hosted: domain `lightbound.uk`, path `app`. Policy: Allow,
   Include **Everyone**. The Worker then decides who sees what from the account records.
3. Copy the team domain (`<team>.cloudflareaccess.com`) and the application's **AUD tag** into
   `vars` in `wrangler.jsonc`. Neither is a secret.

When the workers.dev preview looks right, uncomment `routes` in `wrangler.jsonc` and deploy again
to serve `lightbound.uk`. This adds proxied A/AAAA records only; the Google Workspace MX records
stay as they are. The first visit after a deploy fetches the feeds once; after that the cron runs
every 15 minutes.

After that, every change is `npm run test:website`, then `npx wrangler@4 deploy` from `website/`.

## Not yet verified

- That an Access policy of "Include: Everyone" sends one-time codes to any address. The OTP page says
  codes go only to emails a policy allows. Test it with a non-customer address. If it doesn't, add
  each approved email to the policy by hand.
- The Zero Trust Free plan's user limit (expected 50). Each person who signs in counts.
- Whether the Access path `app` also covers `/app/...`. The Worker refuses anything without a valid
  token either way.

- The Space Devs' page lists no terms for caching or redistribution. The site attributes them on
  every view; ask them before any commercial reuse.
- Launch Library 2 rate-limits by IP, and Cloudflare Workers share outbound IPs. If refreshes fail
  with HTTP 429, `/api/health` will show it. The fix is an LL2 API key (Patreon tier, costs money).
- Cloudflare's default `Cache-Control` for `site.css` and the pages (expected: revalidate every
  time). Check with `curl -I` after the first deploy.
