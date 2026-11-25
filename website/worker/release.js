// What this deploy serves: RELEASE in wrangler.jsonc (GAU-178, reduced public release approved 21 Oct 2026).
// - "public", the default and what lightbound.space launches with: the pages, the live feeds, the time planner and
//   an email route. The Worker answers 404 for sign-in and the workspace (/app/*), the operators' Argo page, form
//   posts and the Stripe webhook; the apply pages show the email route instead of a form; and the members-only
//   feeds aren't fetched. Hiding links alone wouldn't close them, so the routes themselves are shut.
// - "full": everything. It also needs the DATA namespace bound, so a half-configured deploy stays public.
export const isFull = (env) => env?.RELEASE === "full" && !!env?.DATA;

export const CONTACT = "hello@lightbound.uk";

// The header pill: Contact in the public release, Sign in once accounts open. tools/release.mjs switches the static
// pages and wrangler.jsonc together; the Worker also puts Contact back on the pages it serves whenever accounts aren't
// really open (say RELEASE "full" without DATA), so no header links to a sign-in that answers 404.
export const CONTACT_PILL = `<a href="mailto:${CONTACT}" class="signin">Contact</a>`;
export const SIGN_IN_PILL = '<a href="/app/" class="signin">Sign in</a>';

/** Parts of a page marked <!--full-->…<!--/full--> show only when accounts are open. */
export const forRelease = (html, env) =>
  isFull(env) ? html : html.replace(/<!--full-->[\s\S]*?<!--\/full-->/g, "").replace(SIGN_IN_PILL, CONTACT_PILL);
