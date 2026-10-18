// Security headers for every response the Worker builds. Static assets get the same set from
// public/_headers (Cloudflare does not apply _headers to Worker responses); a test keeps them identical.
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
});

// Signed-in pages post to /app/checkout and /app/billing, which redirect to Stripe's hosted pages.
// Browsers apply form-action to that redirect too, so these two Stripe origins are allowed there only.
export const APP_CSP = SECURITY_HEADERS["Content-Security-Policy"].replace(
  "form-action 'self'", "form-action 'self' https://checkout.stripe.com https://billing.stripe.com");

export function withSecurity(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}
