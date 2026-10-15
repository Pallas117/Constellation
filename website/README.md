# Lightbound / Gauss website (GAU-12)

A static, evidence-first site: one HTML page, one stylesheet, an SVG mark. No JavaScript, no web
fonts, no third-party requests; under 40 KB in total so it loads on slow links and low-memory phones.

Wording follows the Linear project "Product Narrative — Ground-first Mission Data Assurance": lead
with Fleet Integration (ground) sold as a 30-day replay pilot; the flight stages are gated; nothing
that simulation can't support is claimed. Anything still being built is labelled as such.

```bash
npm run test:website     # GAU-12 acceptance checks (claims, links, CSP, size budget)
open website/index.html  # preview
```

`website/site.test.mjs` fails the build if the page claims flight readiness, qualification, dose or
damage figures, customers, partnerships or A*STAR/QPIN outside the "we don't claim" box, if a link
breaks, if any script, inline style or third-party resource appears, or if the site grows past 40 KB.

## Deploying

Any static host works. `_headers` carries the security headers in the Cloudflare Pages / Netlify
format (strict CSP, HSTS, no framing). lightbound.uk has no web DNS record yet: point it at the
chosen host after review.
