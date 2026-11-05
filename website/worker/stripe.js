// Stripe: hosted Checkout for the pilot (one payment) and Fleet Integration (yearly subscription),
// invoices with 30 days to pay for accounts an admin allows them on, Stripe's hosted billing portal,
// and signed webhooks that unlock the workspace. Card details never touch lightbound.uk. The two keys live in Worker secrets
// (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET), never in config, URLs or logs.
import { getAccount, putAccount } from "./data.js";
import { readCapped } from "./body.js";
import { CURRENCY, EDU, INVOICE_DAYS, tierById } from "./tiers.js";

// STRIPE_API_BASE points at the local stand-in (dev.mjs). Honoured only for this machine, so a stray setting in
// production can never send the secret key to another host.
const LOCAL_BASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?\/[A-Za-z0-9_/-]*$/;
const api = (env) => (LOCAL_BASE.test(env.STRIPE_API_BASE ?? "") ? env.STRIPE_API_BASE : "https://api.stripe.com");
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

/** Self-serve products with their own billing record (account.edu); Gauss plans use account.billing.
 *  Gauss Argo isn't sold any more (it's included for operators and staff), so its old product id is refused below. */
export const PRODUCTS = Object.freeze([EDU.id]);
/** One Stripe customer per person, whichever product they bought first. */
export const customerOf = (account) => account?.billing?.customer ?? PRODUCTS.map((k) => account?.[k]?.customer).find(Boolean) ?? null;

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
  const description = `Gauss: ${tier.name}${tier.billing === "subscription" ? ", 12 months" : ""}`;
  return sendInvoice(env, account, { amount: account.quote, currency: CURRENCY, description, meta: { email: account.email, plan: tier.id } }, fetchImpl);
}

/** A department's yearly education licence, at the quote an admin approved, invoiced in pounds. */
export const eduInvoiceable = (account) => account?.edu?.plan === "department" && Number.isInteger(account.edu.quote) && account.edu.quote > 0;
export async function createEduInvoice(env, account, fetchImpl = fetch) {
  if (!eduInvoiceable(account)) throw new Error("No department licence quote on this account");
  return sendInvoice(env, account, { amount: account.edu.quote, currency: CURRENCY, description: `${EDU.name}: department licence, 12 months`,
    meta: { email: account.email, product: EDU.id, offer: "department" } }, fetchImpl);
}

/** Create, finalise and send one invoice (30 days to pay). Stripe emails it to the customer. */
async function sendInvoice(env, account, { amount, currency, description, meta }, fetchImpl) {
  const customer = customerOf(account) ??
    (await call(env, "customers", { email: account.email, name: account.org || account.name || undefined, metadata: meta }, fetchImpl)).id;
  const draft = await call(env, "invoices", { customer, collection_method: "send_invoice", days_until_due: INVOICE_DAYS, pending_invoice_items_behavior: "exclude", description, metadata: meta }, fetchImpl);
  await call(env, "invoiceitems", { customer, invoice: draft.id, amount, currency, description, metadata: meta }, fetchImpl);
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
    ...(customerOf(account) ? { customer: customerOf(account) } : { customer_email: account.email }),
    ...(yearly || customerOf(account) ? {} : { customer_creation: "always" }),
    metadata: meta,
    ...(yearly ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta }, invoice_creation: { enabled: true } }),
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    success_url: `${origin}/app/?checkout=success`,
    cancel_url: `${origin}/app/?checkout=cancelled`,
  }, fetchImpl);
}

/** Gauss for Education, staff and research: monthly at EDU_STAFF_PRICE. */
export const createEduCheckout = (env, account, origin, amount, fetchImpl = fetch) =>
  createSubscriptionCheckout(env, account, origin, { product: EDU.id, offer: "staff", name: `${EDU.name}: staff and research`, amount, currency: EDU.currency, interval: EDU.interval, back: "edu=started" }, fetchImpl);

/** A self-serve subscription at a fixed price, recorded on the product's own billing (metadata.product). */
async function createSubscriptionCheckout(env, account, origin, { product, offer, name, amount, currency, interval, back }, fetchImpl) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("No price set");
  const meta = { email: account.email, product, ...(offer ? { offer } : {}) };
  const customer = customerOf(account);
  return call(env, "checkout/sessions", {
    mode: "subscription",
    line_items: [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name }, recurring: { interval } } }],
    client_reference_id: account.email,
    ...(customer ? { customer } : { customer_email: account.email }),
    metadata: meta,
    subscription_data: { metadata: meta },
    consent_collection: { terms_of_service: "required" },
    tax_id_collection: { enabled: true },
    success_url: `${origin}/app/?${back}`,
    cancel_url: `${origin}/app/?checkout=cancelled`,
  }, fetchImpl);
}

/** Stripe's billing portal (cards, invoices, cancel). Returns { url }. */
export async function createPortal(env, account, origin, fetchImpl = fetch) {
  if (!customerOf(account)) throw new Error("No Stripe customer on this account");
  return call(env, "billing_portal/sessions", { customer: customerOf(account), return_url: `${origin}/app/` }, fetchImpl);
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
  // Every object we create carries metadata.email; anything without it isn't ours to act on.
  const email = String(obj.metadata?.email ?? "").toLowerCase();
  if (!email) return "ignored: no account";
  const account = await getAccount(env, email);
  if (!account) return "ignored: unknown account";
  if (PRODUCTS.includes(obj.metadata?.product)) return applyProductEvent(env, account, event, obj, obj.metadata.product);
  if (obj.metadata?.product) return "ignored: not a product we sell"; // never let another product's event touch the Gauss plan
  if (obj.metadata?.plan && obj.metadata.plan !== account.tier) return "ignored: plan has changed";
  const prev = account.billing ?? {};
  const stale = staleFor(event, obj, prev.checkout, prev);
  if (stale) return stale;
  if (prev.eventAt && event.created < prev.eventAt) return "ignored: older event";
  let next;
  switch (event.type) {
    case "checkout.session.completed":
      next = { status: obj.mode === "subscription" ? "active" : obj.payment_status === "paid" ? "paid" : "processing", customer: obj.customer ?? prev.customer, subscription: obj.subscription ?? prev.subscription,
        checkout: { ...prev.checkout, url: null } }; // used: never offered again
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

/** Self-serve products keep their own billing record (account.edu.billing), so they never touch a Gauss plan's. */
// Only the Checkout Session this account opened, and the subscription it started, can change its billing: a session
// opened before a re-quote (FRESH clears it) or anyone else's can't.
function staleFor(event, obj, checkout, prev) {
  if (event.type.startsWith("checkout.session.") && (!obj.id || obj.id !== checkout?.id)) return "ignored: not this account's checkout";
  if (event.type.startsWith("customer.subscription.") && (!obj.id || obj.id !== prev.subscription)) return "ignored: not this account's subscription";
  return null;
}

async function applyProductEvent(env, account, event, obj, key) {
  const rec = account[key] ?? {};
  const prev = rec.billing ?? {};
  const stale = staleFor(event, obj, rec.checkout, prev);
  if (stale) return stale;
  if (prev.eventAt && event.created < prev.eventAt) return "ignored: older event";
  let next;
  if (event.type === "checkout.session.completed") next = { status: "active", customer: obj.customer ?? prev.customer, subscription: obj.subscription ?? prev.subscription };
  else if (event.type.startsWith("customer.subscription."))
    next = { status: event.type.endsWith(".deleted") ? "canceled" : (SUBSCRIPTION[obj.status] ?? prev.status ?? "due"), customer: obj.customer ?? prev.customer, subscription: obj.id };
  else if (["invoice.paid", "invoice.voided", "invoice.marked_uncollectible"].includes(event.type)) {
    if (!obj.id || obj.id !== prev.invoice) return "ignored: not this account's invoice";
    next = event.type === "invoice.paid"
      ? { status: "paid", paidUntil: new Date((obj.created ?? event.created) * 1000 + YEAR_MS).toISOString() }
      : { status: "due", invoice: null, invoiceUrl: null, dueAt: null };
  } else return `ignored: ${event.type}`;
  const offer = obj.metadata?.offer;
  const used = event.type === "checkout.session.completed" ? { checkout: { ...rec.checkout, url: null } } : {};
  const updated = { ...rec, ...used, ...(offer ? { plan: offer } : {}), customer: next.customer ?? rec.customer ?? null,
    billing: { ...prev, ...next, eventAt: event.created, updatedAt: new Date().toISOString() } };
  await putAccount(env, { ...account, [key]: updated }, "stripe");
  return `${key} ${event.type} -> ${next.status}`;
}

/** POST /api/stripe/webhook: no cookies or origin here; the signature is the only proof. */
export async function handleWebhook(request, env, respond) {
  const payload = await readCapped(request, 512 * 1024);
  if (payload === null) return respond("Too large\n", 413, "text/plain; charset=utf-8");
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
