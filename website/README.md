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

## Change things

| To change | Edit |
|---|---|
| Hero line, door text | `public/index.html` |
| Gauss copy (keep the claim rules; the tests enforce them) | `public/gauss/index.html` |
| Constellation copy, intel rules, join route | `public/constellation/index.html` |
| Colours, type, layout | `public/assets/site.css` (Brand Room tokens; the tests reject off-palette colours) |
| Marks, fonts, film (after the brand kit changes) | run `tools/build_assets.py` (header says how) |
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
npx wrangler@4 kv namespace create LIVE    # paste the printed id into wrangler.jsonc
npx wrangler@4 deploy                      # live at https://lightbound-site.<account>.workers.dev
```

When the workers.dev preview looks right, uncomment `routes` in `wrangler.jsonc` and deploy again
to serve `lightbound.uk`. This adds proxied A/AAAA records only; the Google Workspace MX records
stay as they are. The first visit after a deploy fetches the feeds once; after that the cron runs
every 15 minutes.

After that, every change is `npm run test:website`, then `npx wrangler@4 deploy` from `website/`.

## Not yet verified

- The Space Devs' page lists no terms for caching or redistribution. The site attributes them on
  every view; ask them before any commercial reuse.
- Launch Library 2 rate-limits by IP, and Cloudflare Workers share outbound IPs. If refreshes fail
  with HTTP 429, `/api/health` will show it. The fix is an LL2 API key (Patreon tier, costs money).
- Cloudflare's default `Cache-Control` for `site.css` and the pages (expected: revalidate every
  time). Check with `curl -I` after the first deploy.
