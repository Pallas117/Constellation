# lightbound.uk

The Lightbound site: a black-hole landing ("Carry hope, go beyond.") with three doors, Gauss,
Constellation and Turnstone. It is one Cloudflare Worker with static assets. There is no client-side
JavaScript, no third-party requests, and no secrets.

**It launches as the public release** (GAU-178, `RELEASE: "public"`): the pages and live feeds, with an email
route instead of forms. Sign-in, payments and the members' and operators' pages below are built and tested, but
closed until `RELEASE: "full"`. See "Launch" and "Opening accounts later".

| Page | What it is |
|---|---|
| `/` | Hero: the brand kit's ray-traced black-hole film, then the descent (below). Doors show live data: Gauss shows space weather now, Constellation shows the next launch, Turnstone is classified. Three projects only (Josh, 2026-10-22); Gauss for Education is a line pointing to Constellation's outreach. |
| `/gauss/` | The GAU-12 evidence-first Gauss page. It leads with Fleet Integration and has an on-page menu. A script-free **replay demo** walks one synthetic storm through the nominal, degraded, abstain, unknown and blocked states, labelled as screening evidence. Also: claims and boundaries, plans and prices, CCSDS/XTCE/Yamcs/ONNX fit, team. Ends with the other doors. |
| `/gauss/evidence/` | A synthetic **sample evidence report**: record states, decisions, unknowns and limits, provenance. Clearly labelled; not a mission record. |
| `/constellation/` | The community: next 10 launches worldwide, space weather now, a calendar feed, intel rules, and how to join. Ends with the other doors. |
| `/turnstone/` | Mark, "Classified." and a "Request a briefing" link to Josh's 30-minute Cal.com call; nothing about what it does (secret project; `noindex`). |
| `/gauss/apply/` | Pilot brief in the sales plan's three steps (fit, readiness, pilot brief). Plan links preselect the package. |
| `/constellation/apply/` | Request an invitation. Constellation is free and invite-only; there is no payment anywhere on its side. |
| `/argo/` | Gauss Argo, the self-healing connectivity agent, "built like a spacecraft": what it catches, how it works, its security rules, where it runs, the private relay (in development, not available). Included for operators and staff, no price, `noindex`, linked only from the workspace. |
| `/education/` | Gauss for Education (prototype), part of Constellation's outreach (nav shows Constellation): what a class gets (four labs), the three plans (student free, staff and research monthly, department yearly), and who can join. Buttons follow `EDU_SALES`; the staff price is "Price TBC" until `EDU_STAFF_PRICE` is set. |
| `/education/apply/` | A department licence request, or a review for people without a university email. |
| `/app/` | Signed-in workspace: quote and payment (card, or an invoice where you allow it), billing state, pilot progress, space weather, Constellation membership, members' opportunities, and the staff link for the team. |
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
customer ── /app/ (Cloudflare Access one-time code) ─┬─ Pay now ──► Stripe Checkout (Stripe's page)
                                                     └─ Request an invoice (only if you ticked "Allow invoice")
                                                          ──► Stripe emails an invoice, 30 days to pay; billing: invoice_open
                                                                       │
Stripe ── signed webhook /api/stripe/webhook ──► billing: paid | active | past_due | canceled ──► workspace unlocks
customer ── Manage billing ──► Stripe billing portal (cards, invoices, cancel)
```

**Packages and prices** come from the sales plan ("Gauss Aurora sales feature list and onboarding
flow", Gauss Aurora repo `docs/SALES_FEATURE_LIST_AND_ONBOARDING.md`, 21 Aug 2026). They live in
`worker/tiers.js`:

| Package | Range | Paid how |
|---|---|---|
| Design-partner pilot | £20k–£40k per pilot | One Stripe payment, or one invoice if allowed |
| Fleet Integration | £60k–£125k a year | Yearly Stripe subscription, or a yearly invoice if allowed |
| Mission integration | £120k–£300k one-off | Invoiced by milestone |
| Flight Candidate Adapter (gated) | £750k–£2.5m one-off | Invoiced by milestone |

Each customer pays a fixed quote that you set inside the range when you approve them. The public
pages and the workspace don't say how payment is taken (a test checks); the privacy notice still
names Stripe as a processor. The site never offers a cheap self-serve trial: the sales plan sells a paid, bounded pilot. The Lovable tier
claims (automated mitigation, a quantum surrogate, fixed warning times) stay out, and a test checks.

**Invoices, where you allow them.** Tick "Allow invoice" when you approve a customer or on their
account row. They then see "Request an invoice" next to "Pay now". The Worker creates a Stripe
invoice for the quote (Fleet Integration: 12 months) and Stripe emails it, with 30 days to pay.
- Their workspace opens straight away ("Invoice sent").
- After the due date it locks ("Invoice overdue") until the invoice is paid.
- `invoice.paid` for that invoice marks it Paid. For Fleet Integration the paid year then runs 365 days
  from the invoice date, after which the customer sees "Renew now" (or another invoice).
- `invoice.voided` or `invoice.marked_uncollectible` puts it back to Payment due.
- Changing a customer's plan or quote drops any earlier invoice and paid year, and invoicing stays off
  unless the box is ticked.

**Constellation group calls** (members only, free):
- You schedule a call in `/app/admin/` with a title, start time in any zone, length, seats, call link and notes.
- Members see upcoming calls in `/app/` in their own time zone (set once) with UTC beside it. They book or cancel a seat and download a calendar file.
- The call link is shown only to members who booked, and appears in the calendar file only for them.
- Each booking is its own key in DATA, so two bookings never overwrite each other. KV is eventually consistent, so a busy call can go one or two over its seat limit.
- **Announcing a call** (comms are still being decided): each call in `/app/admin/` has two drafts.
  - "Draft an email" opens your mail app with every member in Bcc. Past about 1,800 characters the link leaves the addresses out for you to add.
  - "Draft a WhatsApp message" opens WhatsApp with the text; you pick the group and press send.

  Nothing is sent by the site, and no messaging service or token is involved. The text never includes the call link, which goes only to members who book.

**Friends of Constellation:** the xOrbita, Pan Galactic Corporation and Aphelion Industries logos sit on the Constellation page. They're shown as supplied, link to each site, and show their names on hover or focus (always on touch screens). They're labelled neutrally, with no partnership claim. Pallas confirmed permission to show all three (19 Oct 2026).

**Gauss Argo** (included for operators and staff; Josh, 2026-10-22). Every claim on `/argo/` comes from Argo's own
README and code on main (`tools/argo`): the fault classes, the security rules, the Mac agent and the Linux container.
The private relay is the two-hop design from the "Lightbound Private Connectivity" brief, described as in development
and not available until an outside security review and legal checks. A test keeps out grade or anonymity claims
("space grade", "mission-grade", "untraceable", "certified", "VPN"), prices and list wording. The Argo glyph in
`assets/marks/argo-glyph-provisional.svg` is provisional until the Brand Book adds Argo.

- **Who gets it:** operators (an account with a Gauss plan whose billing is unlocked: `isOperator` in
  `worker/tiers.js`) and staff (`STAFF_EMAILS`, plus admins). Nothing extra to pay; there is no Argo price, checkout,
  Stripe product or list any more. Old `/argo/apply/` links redirect to `/argo/` (`public/_redirects`).
- **The flow:** the workspace shows an "Included" card with **Request setup**. That records `account.argo.requestedAt`
  once. Admin shows "Gauss Argo setup requested by N"; email each one their install link and steps, then press **Mark
  Argo setup sent** (`sentAt`). The card then says "Setup sent".
- **Before the first operator asks:** a customer build (a signed, notarised Mac app needs an Apple Developer account,
  which costs money; a published Linux image), customer settings (today Argo is set up for Lightbound: the MY/SG
  exit-node list, Claude Code checks and tailnet-only Gauss enrolment), install, update and uninstall steps, and the
  install-link email itself.
- **Sales plan:** Argo is part of the Gauss plans, never a low-price SaaS on the site. Proposed line for the sales plan,
  for Josh to approve: *"Gauss Argo (device agent) is included with paid Gauss plans and for the Lightbound team. It is
  not sold separately."*
- **The private relay is separate.** Encryption plus anonymity needs export-control and sanctions advice before any
  launch (see the Private Connectivity brief).

**Gauss for Education** (prototype; Josh, 2026-10-20: self-serve plus department, students free, university email or review):
- **Student:** free for a year at a time. Sign in with a university email (any address ending in `.ac.xx`, `.edu` or `.edu.xx`,
  see `isAcademicEmail` in `worker/tiers.js`), tick "I'm a student", and the classroom opens. No Stripe involved.
- **Staff and research:** a monthly card subscription at `EDU_STAFF_PRICE` (US cents). While that's empty the page and
  workspace say "Price TBC" and there is no checkout. It has its own billing record (`account.edu.billing`).
- **Department:** request a licence at `/education/apply/`. In admin, enter the yearly quote in pounds and choose
  "Department licence at this yearly quote". The contact signs in and requests the invoice (30 days to pay). The
  classroom opens while the invoice is within its terms; `invoice.paid` makes the licence run 365 days.
- **No university email:** request a review at `/education/apply/`. "Approve for self-serve" in admin then lets them
  start like anyone with a university address.
- **The classroom** (`/app/edu/`, `worker/classroom.js`): four prototype labs on public data and this site's demos.
  Each lab names its source. It's open only to people with active education access, and to admins.
- **Sales plan:** this is an academic licence for non-commercial use, never a trial of the Gauss packages. It's kept
  off the Gauss page (a test checks). Proposed line for the sales plan, for Josh to approve: *"Gauss for Education is
  an academic licence (free for students, paid for staff and departments) for teaching and non-commercial research.
  It is not a trial of Gauss Aurora and is not shown in the Gauss Aurora packages or pilot flow."*
- **Before `EDU_SALES=open`:**
  - set the staff price;
  - add academic terms of use (non-commercial, students re-confirm each year) to the terms of service;
  - check the lab pack with a lecturer;
  - tax: EU consumers owe VAT from the first sale through the non-Union One Stop Shop, with no threshold
    (vat-one-stop-shop.ec.europa.eu); decide Stripe Tax or registration with the accountant (UNVERIFIED);
  - cancellation: UK consumers have 14 days to cancel digital content unless they agree to start straight away
    (Consumer Contracts Regulations 2013); counsel should word this;
  - run the department invoice once in Stripe test mode.

**Constellation events and workshops** (2026-10-20):
- **Events (05):** the Constellation page lists events from the public Luma calendar, https://luma.com/constellation
  (`cal-JlCHo35H2rXUzYN`, found from "The Overview Summit Malaysia" at luma.com/ktvyagi2). The cron reads Luma's
  public iCal feed every 3 hours and keeps only each event's title, start and end times, and public link: never
  organisers, descriptions, addresses or coordinates. Up to 6 upcoming and the 3 most recent show, with "Follow
  Constellation on Luma". If Luma is down, the section still shows the link and `/api/health` stays green.
  New events appear by themselves once they're posted on Luma.
- **Workshops (06):** ethics, resilience and tech leadership, "led by facilitators from the Constellation community;
  members join free". `/constellation/workshops/` is a team request form (organisation, workshop, format, group
  size, when). It lands in admin as "WORKSHOP · …", and "Mark contacted" creates no account.
- **Facilitators aren't named yet** (Josh, 2026-10-21: don't name who will run the workshops yet). The page says
  "facilitators from the Constellation community". This repo is public, so keep names out of commits too.

**Terms, cancelling and VAT** (Josh, 2026-10-21):
- **`/terms/`** and `/privacy/` are DRAFTS for legal review (a brief for counsel exists outside this repo). The terms say so on
  the page and aren't in force until a lawyer has read them.
  - The terms' ethical-use section follows "peaceful purposes" (Outer Space Treaty and Artemis Accords, nasa.gov/artemis-accords),
    ESA's terms for its open data ("peaceful purposes, including scientific, technical, educational, and application
    development", gssc.esa.int/tou1), and NASA's Framework for the Ethical Use of AI (NASA/TM-20210012886).
  - **Decided (Josh, 2026-10-21):** the clause barring attacks, targeting and weapons stands for every service on this
    site. No public product is offered for defence use.
- **Cancelling:**
  - Monthly plans roll month to month, with no minimum term or fee.
  - People cancel in one click from Manage billing. In Stripe's customer-portal settings, set cancellation to "at
    the end of the billing period", to match the terms.
  - "Not satisfied" refunds within 30 days of a payment are given from the Stripe Dashboard: the payment, then Refund.
  - This is more generous than the 14-day cancellation right for digital services, so no waiver wording is needed at
    Checkout (check with counsel).
- **Stripe settings:** Checkout asks every education subscriber to accept the terms, so put
  `https://lightbound.uk/terms/` in Stripe's public business details. Checkout fails until that's set.
- **UK VAT:**
  - Lightbound must register once UK taxable turnover passes £90,000 in 12 months (gov.uk, VAT Notice 700/1). Three
    Gauss pilots at £20k–£40k would do it.
  - The standard rate is 20% (gov.uk/vat-rates).
  - Prices shown to UK consumers should include VAT once registered (UNVERIFIED: check with the accountant).
  - Self-serve plans are UK-only for now: a UK seller owes EU VAT from the first sale to an EU consumer (see Gauss
    for Education, "Before `EDU_SALES=open`").
  - Enforcing "UK only" at checkout is still to do (a Stripe Radar rule, or asking for the country before checkout).
- **`USER_CAP`** (default 50, Zero Trust's free sign-in seats):
  - Once there are that many accounts, new self-serve sign-ups get "We're full for now" and are pointed to the list.
  - People who already have an account are never blocked.
  - The admin page shows "Accounts (n of 50)".
  - Members, customers and students all count, because every sign-in takes an Access seat.

**What it costs, and what to charge** (sources: Cloudflare KV and Workers pricing docs, Cloudflare Zero Trust pricing,
Stripe UK pricing; exchange rates and the Apple fee are UNVERIFIED):
- **Up to 50 users, Cloudflare is free:**
  - Zero Trust is free for up to 50 users.
  - KV's free daily limits are 100,000 reads, 1,000 writes and 1,000 lists.
  - The cron alone writes about 152 times a day: weather 96, launches 48, events 8.
  - 50 active users add perhaps 100 writes a day.
  - Lists are the tight one: each member's visit lists group calls, so expect about 4 lists per visit with 3 calls
    scheduled.
- **Upgrade at launch of paid plans:** Workers Paid is $5 a month (10M reads, 1M writes, 1M lists a month). It removes
  the daily limits and pays for itself with one subscriber.
- **Fees per £8 monthly payment on a UK card:** Stripe 1.5% + 20p, plus Billing 0.7%, comes to about £0.38, leaving
  about £7.62. Once VAT-registered it's about £6.29 (£8 includes £1.33 VAT). International cards cost 3.15% + 20p, plus
  2% for currency conversion.
- **Fixed costs:**
  - Workers Paid: $5 a month.
  - A signed Mac build of Argo (included for operators) needs an Apple Developer account (UNVERIFIED: about $99 a year).
- **Past 50 users, seats dominate:** Zero Trust Standard is about $7 per user per month (community-reported,
  UNVERIFIED), and every seat becomes billable. At £8–10 a month the margin would vanish, so keep the cap at 50, or
  price at £15 or more per user before lifting it.

**Support Constellation.** The Constellation page (Join section) and a member's workspace show a "Support
Constellation" link once `SUPPORT_URL` in `wrangler.jsonc` vars holds a Stripe Payment Link. While it's empty,
nothing shows. Only `https://buy.stripe.com/…` or `https://donate.stripe.com/…` links are accepted. To set it up:
1. In the Stripe Dashboard, create a Payment Link for a product such as "Support Constellation", with
   "Let customers choose what to pay".
2. Paste the link into `SUPPORT_URL`; it isn't a secret.
3. Deploy.

The money is income to Lightbound Limited, not a charitable donation (no Gift Aid), so the page never says
"donate". The VAT treatment of voluntary contributions is UNVERIFIED: ask the accountant. Locally, run
`SUPPORT_URL=https://buy.stripe.com/test_… npm run site:dev`.

**Constellation** is free and invite-only. People can request an invitation, or you invite them
from the admin page. Inviting creates the membership and gives you a draft email to send yourself;
nothing is sent automatically.

**Security:**
- No passwords. Cloudflare Access emails a one-time code, and the Worker verifies Access's signed
  token (key, audience, issuer, expiry).
- No card data. Payment happens on Stripe's pages (Checkout, or Stripe's hosted invoice page). The site
  only creates the Checkout session or invoice and reads Stripe's webhook.
- An invoice webhook counts only for the invoice id stored on that account, so Checkout's own
  receipts and renewal invoices never change an invoiced account.
- Webhooks are trusted only with a valid Stripe signature from the last 5 minutes. An older event
  never overwrites a newer state, and an event for a different plan is ignored.
- Only the signed-in pages may redirect a form to `checkout.stripe.com` and `billing.stripe.com`,
  via a CSP `form-action` exception. Public pages post only to the site itself.
- Stripe keys are Worker secrets, never in config, URLs, logs or git. `STRIPE_API_BASE` (the local stand-in) is
  honoured only for a localhost URL, so the key can never be sent to another host.
- Payments are tied to the account's own Checkout Session and subscription. A session opened before a re-quote
  (re-quoting clears it), or anyone else's, changes nothing, and every event must carry `metadata.email`.
  Clicking Pay again reuses the open session rather than creating more.
- Request bodies are read through a byte cap, even without a Content-Length header: 16 KB for forms and
  `/app`, 512 KB for the webhook. Upstream feeds are capped at 2 MB.
- Form rate limits count an IPv6 /64 as one sender. The workspace reads the person's own latest application
  (`appby:<email>`) instead of listing everyone's. The admin page reads full details for the newest 50 waiting
  applications only.
- A sign-in alone never creates a record (time-zone preferences need an account). After an invitation the admin
  page gets a 10-minute token, not the email, in its URL.
- The dev signing key (`ACCESS_JWKS`) is honoured only for a `*.local` team domain. An unknown key id makes the
  Worker refetch Access's keys at most once a minute, so key rotation doesn't lock people out.
- Calendar files escape every line break and limit UIDs to safe characters.

**Before going live, in dashboards (security review, 2026-10-21; the figures below are UNVERIFIED, from memory):**
1. **Access seats.** "Include: Everyone" lets anyone sign in, and every sign-in may take a Zero Trust seat; the free
   plan's seat cap is UNVERIFIED (50 from memory). Limit the policy (known customers, members, university domains),
   turn on seat expiry, or plan for paid seats before `EDU_SALES` goes `open`.
2. **Rate limits at the edge.** Add a Cloudflare rate-limiting rule for `POST /api/apply` and `POST /app/*`. The
   KV-based limit can't stop a flood spread across many addresses.
3. **KV quotas.** The free plan's daily KV write and list limits (UNVERIFIED: about 1,000 each) can be used up by a
   flood or busy sales. Move to the Workers paid plan before opening sales.
4. **Logs.** Observability is on. Check whether Workers Logs record request headers, since the Access token header
   carries the email. If they do, turn invocation logs off.
5. **Re-quoting an active subscription:** cancel the old subscription in Stripe first; its events still count.

**Locally:** `npm run site:dev`, then go to `/app/`. Pick "Approved, payment due (invoice allowed)"
and press "Pay now", or "Request an invoice" then "View invoice". A local Stripe stand-in shows a
test checkout or invoice (pay or void it) and sends a signed webhook to the real Worker code. The
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

**The descent** (landing, between the hero and the doors): as you scroll, the hero's black hole shrinks
into the aurora above Earth's pole, then the dipole field lines and the two Van Allen belts draw in,
over five captions. It's scroll-driven CSS (`animation-timeline: view()`) on an inline SVG; there's no
script, and it reuses the hero poster, so nothing new downloads. Browsers without scroll-driven
animations, and anyone with reduced motion, get the final frame beside all five captions. The page
calls it a sketch, not a model. Belt facts follow NASA Earth Observatory ("Probing the Electric Space
Around Earth", image 78985).

## Change things

| To change | Edit |
|---|---|
| Hero line, door text | `public/index.html` |
| The landing's descent (black hole → aurora → Van Allen belts) | geometry: `tools/make_descent.py` (dipole field lines, then rewrites the SVG in `public/index.html`); timing: "Descent" in `public/assets/site.css` |
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
RELEASE=public npm run site:dev:offline      # the launch: no sign-in, email routes, closed pages answer 404
RELEASE=public npm run audit:website         # contrast, tap targets, overflow, headings on the launch pages
npm run smoke:website -- http://127.0.0.1:8788   # the deployed-site smoke check, against a public preview
```

`dev.mjs` emulates Cloudflare: assets with `_headers`, trailing slashes, the 404 page and byte
ranges; the `run_worker_first` routes from `wrangler.jsonc`; an in-memory KV; and the cron.

## Members' opportunities and the staff link

**Opportunities (Constellation members only, in `/app/`).** `worker/opportunities.js` lists accelerators
(such as CDL), ESA BIC-style incubators, hackathons, grants and calls, and ranks them for each member:

- **Sources, all cached by the cron:** the programmes we track in the Gauss Funding Tracker (every 3 hours),
  UKRI's opportunities RSS filtered to space-related calls and the UK Space Agency's GOV.UK feed (both every 6
  hours, kept for 60 days), and Spaceflight News API headlines (hourly). Only titles, dates, short summaries and
  official links are kept, never article text. All four are optional: none of them can fail `/api/health`.
- **Matching** uses plain keyword rules in the Worker, and nothing is sent anywhere. Until a member saves their own
  interests, they are suggested from their Constellation application, while we hold it (180 days). The page never
  shows the application text. Saved interests are a short list of tags on the account (privacy notice:
  "Opportunities for members"). Closed programmes (deadline passed) are hidden.
- **The tracker stays private.** The Worker reads one tab only, published as CSV, holding public facts.
  It never sees owners, status, notes, investors or templates. Set it up once:
  1. In the Gauss Funding Tracker, add a tab called `Public programmes`. In A1, paste this (UK locale). It copies
     only the public columns, and only rows a person has checked (column V = Y):
     ```
     ={"Programme","Type","Organiser","Deadline","Indicative value","Who can apply","Region","What you get","Official URL";
     FILTER({Programmes!B2:B,Programmes!O2:O,Programmes!Q2:Q,ARRAYFORMULA(TEXT(Programmes!F2:F,"yyyy-mm-dd")),Programmes!M2:M,Programmes!N2:N,Programmes!P2:P,Programmes!L2:L,Programmes!Y2:Y},Programmes!B2:B<>"",Programmes!V2:V="Y")}
     ```
     Deadlines must come out as `2026-11-01`, `1 Nov 2026` or `Rolling`. Slashed dates are skipped, because 04/11
     means different days in the UK and the US.
  2. File → Share → Publish to web → choose **that tab only** → Comma-separated values (.csv) → Publish. Leave
     "Automatically republish" on.
  3. `npx wrangler@4 secret put PROGRAMMES_CSV_URL` and paste the link. Only a Google "Publish to web" CSV link is
     accepted. It is a secret, so the address isn't in this public repo.
- **Before you publish, check the tab** for anything you wouldn't want members to read: it is reachable by
  anyone who has its link. `/api/health` shows `programmes: not configured` until the secret is set.

**Staff link.** People in `STAFF_EMAILS` (and admins) see an "Operations and training" card in `/app/` that
links to `OPS_URL`: the staff site, built from the private UI-UX-Gauss repo, with its own Worker and its own
Cloudflare Access application (a staff-only email policy). Set `STAFF_EMAILS` as a secret
(`npx wrangler@4 secret put STAFF_EMAILS`, comma-separated) so the team's addresses stay out of this repo. Set
`OPS_URL` in `wrangler.jsonc` once the staff site is live (https only; the card stays hidden while it's empty).
Keep the same addresses in the staff site's Access policy and its own `STAFF_EMAILS`.

## Launch: the public release (GAU-178; Pallas runs these, they need your Cloudflare login)

lightbound.uk launches as the reduced public release Josh approved on 21 Oct 2026 (`RELEASE: "public"` in
`wrangler.jsonc`, see `worker/release.js`):

- **Open:** every public page, the live feeds, the time planner, the launch calendar and `/api/health`.
- **Email instead of forms:** the four apply pages list their questions and open a pre-filled email to
  jzwnathan@lightbound.uk. Nothing is stored. The header's pill is **Contact**.
- **Closed by the Worker (404):** `/app/*`, `/argo/`, `POST /api/apply` and `/api/stripe/webhook`. The Gauss page
  offers pilots, and shows the later plans, with their prices, as in development. Gauss for Education stays
  "opening soon", and there's no Support link. The members-only feeds aren't fetched.
- **Config:** only the LIVE namespace. No DATA, Access settings, Stripe keys or other secrets. `"full"` without a
  DATA binding stays public.

One time:

```bash
cd website
npx wrangler@4 login                       # opens Cloudflare in your browser
npx wrangler@4 kv namespace create LIVE    # done 23 Oct 2026: its id is in wrangler.jsonc (not a secret)
```

Each deploy, from a clean checkout of the exact commit whose gates passed (`npm run test:website`, and
`RELEASE=public npm run audit:website`):

```bash
cd website
npx wrangler@4 deploy --var SOURCE_SHA:$(git rev-parse HEAD)
npm run smoke:website -- https://lightbound-site.<account>.workers.dev $(git rev-parse HEAD)
```

`smoke:website` checks every public page and its security headers, the 404s, the email routes, the feeds,
and that `/api/health` names the commit you meant to deploy. The first visit after a deploy fetches the feeds
once; after that the cron runs every 15 minutes.

**Then lightbound.uk** (the DNS change, so only with Josh's go-ahead):
1. Uncomment `routes` in `wrangler.jsonc`, deploy again, and run the smoke check against `https://lightbound.uk`.
   This adds proxied A/AAAA records only; the Google Workspace MX records stay as they are.
2. In the dashboard:
   - SSL/TLS > Edge Certificates: **Always Use HTTPS** on. The smoke check tests the redirect.
   - Add no Zero Trust Access application for `/app` yet. With one, visitors would get a sign-in page
     instead of the Worker's 404.
   - Security > WAF: one rate-limiting rule on `/api/*` (the free plan's allowance is UNVERIFIED).
3. `BASE=https://lightbound.uk RELEASE=public npm run audit:website` for a last look at the real pages.

**Rollback:** `npx wrangler@4 deployments list`, then `npx wrangler@4 rollback <version-id>`. To take the
site off lightbound.uk entirely, remove the custom domain under Workers & Pages > lightbound-site >
Settings > Domains & Routes.

**Still open before go-live (GAU-178):**
- Privacy and terms are drafts written for the full site. In the public release the site itself collects
  nothing (email goes straight to Google Workspace), but they still need a lawyer's read.
- lightbound.uk has no SPF and no DKIM (GAU-177), so replies from jzwnathan@lightbound.uk may land in spam. Add
  them before sharing the link widely.

After launch, every change is `npm run test:website`, then the deploy and smoke check above.

## Opening accounts later (`RELEASE: "full"`)

All of it is still in the code, and the tests run it with `RELEASE: "full"`. To open it:
1. In `wrangler.jsonc`, set `RELEASE` to `"full"`.
   - Add the DATA namespace: `npx wrangler@4 kv namespace create DATA`, then a `{ "binding": "DATA", "id": … }` entry.
   - Add these vars: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` (`jzwnathan@lightbound.uk`),
     `GAUSS_APP_URL`, `OPS_URL`, `SUPPORT_URL`, `USER_CAP` (`"50"`).
2. Set up Stripe and sign-in as below, plus the secrets in "Members' opportunities and the staff link".
3. Put **Sign in** back in the page headers. The public release shows Contact there; Worker-run pages bring
   back their own `<!--full-->` parts by themselves.
4. Work through "Before going live, in dashboards" under "Plans, payment and sign-in".

Stripe, once (do it in test mode first, then repeat with live keys):
1. In the Dashboard, under Settings > Payment methods, enable the methods you accept. For amounts
   this size: card, Bacs Direct Debit and bank transfer.
2. Under Settings > Billing > Customer portal, allow invoices, payment-method updates and
   cancellation.
3. Under Developers > Webhooks, add `https://lightbound.uk/api/stripe/webhook` with these events:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded` and
     `checkout.session.async_payment_failed`
   - `customer.subscription.created`, `.updated` and `.deleted`
   - `invoice.paid`, `invoice.voided` and `invoice.marked_uncollectible`
4. Store the two secrets in the Worker (each prompts for the value, so nothing lands in your shell
   history):
   ```bash
   npx wrangler@4 secret put STRIPE_SECRET_KEY       # a restricted key: Checkout Sessions, Billing Portal, Customers, Invoices + Invoice Items write
   npx wrangler@4 secret put STRIPE_WEBHOOK_SECRET   # the endpoint's signing secret
   ```

Sign-in, once (Cloudflare dashboard > Zero Trust):
1. Settings > Authentication: turn on **One-time PIN**.
2. Access > Applications > Add > Self-hosted: domain `lightbound.uk`, path `app`. Policy: Allow,
   Include **Everyone**. The Worker then decides who sees what from the account records.
3. Copy the team domain (`<team>.cloudflareaccess.com`) and the application's **AUD tag** into
   `vars` in `wrangler.jsonc`. Neither is a secret.

Preview the full site locally with `npm run site:dev` (the preview defaults to `"full"`); `RELEASE=public npm run
site:dev` previews the launch.

## Not yet verified

- **VAT.** Whether the prices include or exclude VAT, and whether to turn on Stripe Tax. Decide with
  your accountant before going live; Checkout already collects billing addresses and tax IDs.
- Payment-method limits for large amounts (card and Bacs limits vary). Check them in the Stripe
  Dashboard for your account.
- Stripe API version: the site uses your account's default (set `STRIPE_API_VERSION` to pin one).
- **The invoice calls have only been run against the local stand-in**, not Stripe itself. These are:
  customers, invoices (`collection_method=send_invoice`, `days_until_due=30`), invoiceitems (`amount`,
  `currency`, `invoice`), finalize and send. Request one invoice in test mode before going live and
  check that the email arrives and that `invoice.paid` reaches the webhook.

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
