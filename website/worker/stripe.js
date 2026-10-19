// Stripe: hosted Checkout for the pilot (one payment) and Fleet Integration (yearly subscription),
// invoices with 30 days to pay for accounts an admin allows them on, Stripe's hosted billing portal,
// and signed webhooks that unlock the workspace. Card details never touch lightbound.uk. The two keys live in Worker secrets
// (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET), never in config, URLs or logs.
import { getAccount, putAccount } from "./data.js";
import { CURRENCY, INVOICE_DAYS, tierById } from "./tiers.js";

const api = (env) => env.STRIPE_API_BASE || "https://api.stripe.com"; // STRIPE_API_BASE: local stand-in only
const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Stripe's form encoding: { a: { b: 1 }, c: [{ d: 2 }] } -> a[b]=1&c[0][d]=2 */
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}

async function call(env, path, params, fetchImpl) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured");
  const res = await fetchImpl(`${api(env)}/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(env.STRIPE_API_VERSION ? { "stripe-version": env.STRIPE_API_VERSION } : {}),
    },
    body: formEncode(params),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${path}: HTTP ${res.status}${body?.error?.code ? ` (${body.error.code})` : ""}`);
  return body;
}

export const payable = (account) => {
  const tier = tierById(account?.tier);
  return !!tier && ["payment", "subscription"].includes(tier.billing) && Number.isInteger(account.quote) && account.quote > 0;
};

/** An admin has allowed this account to pay its quote by invoice. */
export const invoiceable = (account) => payable(account) && account.invoice === true;

/** An invoice for the account's quote (one year, for Fleet Integration), which Stripe emails to the customer. Returns the sent invoice. */
export async function createInvoice(env, account, fetchImpl = fetch) {
  if (!invoiceable(account)) throw new Error("Invoicing is not allowed on this account");
  const tier = tierById(account.tier);
  const meta = { email: account.email, plan: tier.id };
  const description = `Gauss: ${tier.name}${tier.billing === "subscription" ? ", 12 months" : ""}`;
  const customer = account.billing?.customer ??
    (await call(env, "customers", { email: account.email, name: account.org || account.name || undefined, metadata: meta }, fetchImpl)).id;
  const draft = await call(env, "invoices", { customer, collection_method: "send_invoice", days_until_due: INVOICE_DAYS, pending_invoice_items_behavior: "exclude", description, metadata: meta }, fetchImpl);
  await call(env, "invoiceitems", { customer, invoice: draft.id, amount: account.quote, currency: CURRENCY, description, metadata: meta }, fetchImpl);
  await call(env, `invoices/${draft.id}/finalize`, {}, fetchImpl);
  return call(env, `invoices/${draft.id}/send`, {}, fetchImpl);
}

/** A Checkout Session for the account's approved plan and quote. Returns { id, url }. */
export async function createCheckout(env, account, origin, fetchImpl = fetch) {
  if (!payable(account)) throw new Error("No payable quote on this account");
  const tier = tierById(account.tier);
  const yearly = tier.billing === "subscription";
  const meta = { email: account.email, plan: tier.id };
  return call(env, "checkout/sessions", {
    mode: yearly ? "subscription" : "payment",
    line_items: [{
      quantity: 1,
      price_data: { currency: CURRENCY, unit_amount: account.quote, product_data: { name: `Gauss: ${tier.name}` }, ...(yearly ? { recurring: { interval: "year" } } : {}) },
    }],
    client_reference_id: account.email,
    ...(account.billing?.customer ? { customer: account.billing.customer } : { customer_email: account.email }),
    ...(yearly || account.billing?.customer ? {} : { customer_creation: "always" }),
    metadata: meta,
    ...(yearly ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta }, invoice_creation: { enabled: true } }),
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    success_url: `${origin}/app/?checkout=success`,
    cancel_url: `${origin}/app/?checkout=cancelled`,
  }, fetchImpl);
}

/** Stripe's billing portal (cards, invoices, cancel). Returns { url }. */
export async function createPortal(env, account, origin, fetchImpl = fetch) {
  if (!account?.billing?.customer) throw new Error("No Stripe customer on this account");
  return call(env, "billing_portal/sessions", { customer: account.billing.customer, return_url: `${origin}/app/` }, fetchImpl);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.payload">; rejected outside a 5-minute window. */
export async function verifySignature(secret, payload, header, now = Date.now(), toleranceSec = 300) {
  if (!secret || !header) return false;
  let t = NaN;
  const sigs = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc(`${t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function signPayload(secret, payload, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", key, enc(`${t}.${payload}`)))}`;
}

const YEAR_MS = 365 * 86_400_000;
const SUBSCRIPTION = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", paused: "past_due", canceled: "canceled", incomplete: "due", incomplete_expired: "canceled" };

/** Apply one verified event to the account it names. Safe to repeat; older events never overwrite newer ones. */
export async function applyEvent(env, event) {
  const obj = event?.data?.object ?? {};
  const email = String(obj.metadata?.email ?? obj.client_reference_id ?? "").toLowerCase();
  if (!email) return "ignored: no account";
  const account = await getAccount(env, email);
  if (!account) return "ignored: unknown account";
  if (obj.metadata?.plan && obj.metadata.plan !== account.tier) return "ignored: plan has changed";
  const prev = account.billing ?? {};
  if (prev.eventAt && event.created < prev.eventAt) return "ignored: older event";
  let next;
  switch (event.type) {
    case "checkout.session.completed":
      next = { status: obj.mode === "subscription" ? "active" : obj.payment_status === "paid" ? "paid" : "processing", customer: obj.customer ?? prev.customer, subscription: obj.subscription ?? prev.subscription };
      break;
    case "checkout.session.async_payment_succeeded":
      next = { status: "paid", customer: obj.customer ?? prev.customer };
      break;
    case "checkout.session.async_payment_failed":
      next = { status: "due" };
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      next = { status: event.type.endsWith(".deleted") ? "canceled" : (SUBSCRIPTION[obj.status] ?? prev.status ?? "due"), customer: obj.customer ?? prev.customer, subscription: obj.id };
      break;
    case "invoice.paid":
    case "invoice.voided":
    case "invoice.marked_uncollectible":
      // Only the invoice this account asked for; Checkout's own receipts and renewals are handled above.
      if (!obj.id || obj.id !== prev.invoice) return "ignored: not this account's invoice";
      next = event.type === "invoice.paid"
        ? { status: "paid", ...(tierById(account.tier)?.billing === "subscription" ? { paidUntil: new Date((obj.created ?? event.created) * 1000 + YEAR_MS).toISOString() } : {}) }
        : { status: "due", invoice: null, invoiceUrl: null, dueAt: null };
      break;
    default:
      return `ignored: ${event.type}`;
  }
  await putAccount(env, { ...account, billing: { ...prev, ...next, eventAt: event.created, updatedAt: new Date().toISOString() } }, "stripe");
  return `${event.type} -> ${next.status}`;
}

/** POST /api/stripe/webhook: no cookies or origin here; the signature is the only proof. */
export async function handleWebhook(request, env, respond) {
  const payload = await request.text();
  if (payload.length > 512 * 1024) return respond("Too large\n", 413, "text/plain; charset=utf-8");
  if (!(await verifySignature(env.STRIPE_WEBHOOK_SECRET, payload, request.headers.get("stripe-signature"))))
    return respond("Bad signature\n", 400, "text/plain; charset=utf-8");
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return respond("Bad JSON\n", 400, "text/plain; charset=utf-8");
  }
  const result = await applyEvent(env, event);
  console.log(`stripe ${event.type}: ${result.split(" -> ")[1] ?? result}`); // no personal data in logs
  return respond(JSON.stringify({ received: true }), 200, "application/json; charset=utf-8", { "cache-control": "no-store" });
}
