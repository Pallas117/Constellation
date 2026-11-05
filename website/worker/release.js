// What this deploy serves: RELEASE in wrangler.jsonc (GAU-178, reduced public release approved 21 Oct 2026).
// - "public", the default and what lightbound.uk launches with: the pages, the live feeds, the time planner and
//   an email route. The Worker answers 404 for sign-in and the workspace (/app/*), the operators' Argo page, form
//   posts and the Stripe webhook; the apply pages show the email route instead of a form; and the members-only
//   feeds aren't fetched. Hiding links alone wouldn't close them, so the routes themselves are shut.
// - "full": everything. It also needs the DATA namespace bound, so a half-configured deploy stays public.
export const isFull = (env) => env?.RELEASE === "full" && !!env?.DATA;

export const CONTACT = "jzwnathan@lightbound.uk";

/** Parts of a page marked <!--full-->…<!--/full--> show only when accounts are open. */
export const forRelease = (html, env) => (isFull(env) ? html : html.replace(/<!--full-->[\s\S]*?<!--\/full-->/g, ""));
