# lightbound.uk

The Lightbound site: a black-hole landing ("Carry hope, go beyond.") with three doors, Gauss,
Constellation and Turnstone. It is one Cloudflare Worker with static assets. There is no client-side
JavaScript, no third-party requests, and no secrets.

| Page | What it is |
|---|---|
| `/` | Hero: the brand kit's ray-traced black-hole film. Doors show live data: Gauss shows space weather now, Constellation shows the next launch, Turnstone is classified. |
| `/gauss/` | The GAU-12 evidence-first Gauss page. It leads with Fleet Integration and has an on-page menu. A script-free **replay demo** walks one synthetic storm through the nominal, degraded, abstain, unknown and blocked states, labelled as screening evidence. Also: claims and boundaries, plans and prices, CCSDS/XTCE/Yamcs/ONNX fit, team. Ends with the other doors. |
| `/gauss/evidence/` | A synthetic **sample evidence report**: record states, decisions, unknowns and limits, provenance. Clearly labelled; not a mission record. |
| `/constellation/` | The community: next 10 launches worldwide, space weather now, a calendar feed, intel rules, and how to join. Ends with the other doors. |
| `/turnstone/` | Mark and "Classified." only (secret project; `noindex`). |
| `/gauss/apply/` | Pilot brief in the sales plan's three steps (fit, readiness, pilot brief). Plan links preselect the package. |
| `/constellation/apply/` | Request an invitation. Constellation is free and invite-only; there is no payment anywhere on its side. |
| `/app/` | Signed-in workspace: quote and Stripe payment, billing state, pilot progress, space weather, Constellation membership. |
| `/app/admin/` | For `ADMIN_EMAILS`: approve with a quote, set plan, billing, pilot step; invite Constellation members (free). |
| `/constellation/time/` | Public time-zone planner. Pick a date and up to 8 zones to see the local hour everywhere, with the hours that suit everyone outlined. A picked hour comes with a calendar file. No data is stored. |
| `/privacy/` | What is kept, why, for how long, and how to have it deleted. |
| `/pilot`, `/sales` | Redirects into the Gauss flow (the entry points named in the sales plan), via `public/_redirects`. |
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

## Plans, payment and sign-in

```
/gauss/#plans ── pilot brief ──► DATA KV app:<id> (deleted after 180 days)
                                   │
/app/admin/ ── Approve with quote (inside the published range) ──► acct:<email> { plan, quote, billing: due }
                                                                       │
customer ── /app/ (Cloudflare Access one-time code) ── Pay securely with Stripe ──► Stripe Checkout (Stripe's page)
                                                                       │
Stripe ── signed webhook /api/stripe/webhook ──► billing: paid | active | past_due | canceled ──► workspace unlocks
customer ── Manage billing ──► Stripe billing portal (cards, invoices, cancel)
```

**Packages and prices** come from the sales plan ("Gauss Aurora sales feature list and onboarding
flow", Gauss Aurora repo `docs/SALES_FEATURE_LIST_AND_ONBOARDING.md`, 21 Aug 2026). They live in
`worker/tiers.js`:

| Package | Range | Paid how |
|---|---|---|
| Design-partner pilot | £20k–£40k per pilot | One Stripe payment |
| Fleet Integration | £60k–£125k a year | Yearly Stripe subscription |
| Mission integration | £120k–£300k one-off | Invoiced by milestone |
| Flight Candidate Adapter (gated) | £750k–£2.5m one-off | Invoiced by milestone |

Each customer pays a fixed quote that you set inside the range when you approve them. The site
never offers a cheap self-serve trial: the sales plan sells a paid, bounded pilot. The Lovable tier
claims (automated mitigation, a quantum surrogate, fixed warning times) stay out, and a test checks.

**Constellation group calls** (members only, free):
- You schedule a call in `/app/admin/` with a title, start time in any zone, length, seats, call link and notes.
- Members see upcoming calls in `/app/` in their own time zone (set once) with UTC beside it. They book or cancel a seat and download a calendar file.
- The call link is shown only to members who booked, and appears in the calendar file only for them.
- Each booking is its own key in DATA, so two bookings never overwrite each other. KV is eventually consistent, so a busy call can go one or two over its seat limit.

**Friends of Constellation:** the xOrbita, Pan Galactic Corporation and Aphelion Industries logos sit on the Constellation page. They're shown as supplied, link to each site, and show their names on hover or focus (always on touch screens). They're labelled neutrally, with no partnership claim.

**Constellation** is free and invite-only. People can request an invitation, or you invite them
from the admin page. Inviting creates the membership and gives you a draft email to send yourself;
nothing is sent automatically.

**Security:**
- No passwords. Cloudflare Access emails a one-time code, and the Worker verifies Access's signed
  token (key, audience, issuer, expiry).
- No card data. Payment happens on Stripe's pages. The site only creates the Checkout session and
  reads Stripe's webhook.
- Webhooks are trusted only with a valid Stripe signature from the last 5 minutes. An older event
  never overwrites a newer state, and an event for a different plan is ignored.
- Only the signed-in pages may redirect a form to `checkout.stripe.com` and `billing.stripe.com`,
  via a CSP `form-action` exception. Public pages post only to the site itself.
- Stripe keys are Worker secrets, never in config, URLs, logs or git.

**Locally:** `npm run site:dev`, then go to `/app/`. Pick "Approved, payment due" and press Pay. A
local Stripe stand-in shows a test checkout and sends a signed webhook to the real Worker code. The
"Fleet Integration, active" account can try the billing portal, including a simulated failed
renewal and cancellation. No real keys are used.

## Brand

The Lightbound Brand Book (15 Oct 2026, with 16 and 18 Oct updates) and the Design System tokens (v3) are the rules:

- **Shared:** black ground, warm white, IBM Plex Sans and JetBrains Mono. Status colours always come with their
  word: LIVE green #4E972F, STALE amber, SIMULATED blue #318ADA (the replay's "synthetic" chips), danger #D4673B.
  Controls have 4 px corners, cards 10 px. There are no shadows or glows outside the marks and photos.
- **Lightbound and Gauss:** lime is the accent. Both use the refined flat symbols (no blur), and Gauss keeps the two-tone "GAUSS AURORA" lockup.
- **All four marks** are the Design System's refined symbols, copied unchanged into `tools/symbols/`. Lockups follow the Brand Book rule (symbol 56, 20 gap, Plex Medium caps; tracking Lightbound 24 %, Gauss 16 %, Turnstone 32 %, Constellation 20 %). The flat SVG symbols double as favicons.
- **Constellation** (`body.brand-constellation`):
  - Two colours, navy #081C4D for raised surfaces and gold #B0906F as the accent, with Plex Medium display and
    wide-caps labels.
  - The motto "Per aspera ad astra: through adversity we go beyond." and the four values appear on the page.
  - It carries no Lightbound endorsement badge; the footer only names the site operator.
  - It uses the refined vector logo and the 3-node icon as its favicon.
- **Turnstone** (`body.brand-turnstone`):
  - Mark v6 (the turnstone landing at the tide line), with the ringed badge as favicon.
  - Signal orange is its one spot colour, and earth blue is accent-2. The wordmark is tracked 32 %, with
    "Turning tides" as the kicker.
  - The page still says nothing about what Turnstone does (tests enforce it).

## Change things

| To change | Edit |
|---|---|
| Hero line, door text | `public/index.html` |
| Gauss copy (keep the claim rules; the tests enforce them) | `public/gauss/index.html` |
| Constellation copy, intel rules, join route | `public/constellation/index.html` |
| Colours, type, layout | `public/assets/site.css` (Brand Room tokens; the tests reject off-palette colours) |
| Marks, fonts, film (after the brand kit changes) | run `tools/build_assets.py`, then `tools/make_lockups.py` (headers say how) |
| Turnstone or Constellation symbols | copy the refined symbols from the Design System into `tools/symbols/` (README there), then rebuild |
| Packages, prices, what they include | `worker/tiers.js` |
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

Stripe, once (do it in test mode first, then repeat with live keys):
1. In the Dashboard, under Settings > Payment methods, enable the methods you accept. For amounts
   this size: card, Bacs Direct Debit and bank transfer.
2. Under Settings > Billing > Customer portal, allow invoices, payment-method updates and
   cancellation.
3. Under Developers > Webhooks, add `https://lightbound.uk/api/stripe/webhook` with these events:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded` and
     `checkout.session.async_payment_failed`
   - `customer.subscription.created`, `.updated` and `.deleted`
4. Store the two secrets in the Worker (each prompts for the value, so nothing lands in your shell
   history):
   ```bash
   npx wrangler@4 secret put STRIPE_SECRET_KEY       # a restricted key: Checkout Sessions + Billing Portal write
   npx wrangler@4 secret put STRIPE_WEBHOOK_SECRET   # the endpoint's signing secret
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

- **VAT.** Whether the prices include or exclude VAT, and whether to turn on Stripe Tax. Decide with
  your accountant before going live; Checkout already collects billing addresses and tax IDs.
- Payment-method limits for large amounts (card and Bacs limits vary). Check them in the Stripe
  Dashboard for your account.
- Stripe API version: the site uses your account's default (set `STRIPE_API_VERSION` to pin one).

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
