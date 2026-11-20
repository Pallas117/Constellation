// Sign-in opens over the live visualisation instead of on a blank page.
//
// The router renders the page behind (the "stage") with its own location while
// /login draws on top, so the globe that was already running stays mounted:
// no second WebGL context, no warm-up, and a viewer who lands back on "/" after
// signing in never sees the scene restart. Pure helpers here; the router and
// AuthStage component use them.

/** Routes that draw as an overlay on top of a stage page. */
const OVERLAY_PATHS = new Set(["/login"]);

/**
 * Public pages a sign-in may open over. Never a protected page: rendering one
 * behind a signed-out viewer would redirect or poll routes that answer 401,
 * and CyberTiger counts those.
 */
const STAGE_PATHS = new Set(["/", "/member"]);

const DEFAULT_STAGE = "/";

export interface StageLocation {
  pathname: string;
  search: string;
  hash: string;
  state: null;
  key: string;
}

export interface OverlayState {
  backgroundLocation: { pathname: string; search: string };
}

function stage(pathname: string, search: string): StageLocation {
  // A fixed key: React Router keeps the stage's element tree whatever the overlay does.
  return { pathname, search, hash: "", state: null, key: "auth-stage" };
}

function backgroundOf(state: unknown): { pathname: string; search: string } | null {
  const bg = (state as { backgroundLocation?: unknown } | null | undefined)?.backgroundLocation;
  if (!bg || typeof bg !== "object") return null;
  const { pathname, search } = bg as { pathname?: unknown; search?: unknown };
  if (typeof pathname !== "string" || !STAGE_PATHS.has(pathname)) return null;
  // Only a plain query string; anything else is dropped rather than trusted.
  const query = typeof search === "string" && /^\?[^#]*$/.test(search) ? search : "";
  return { pathname, search: query };
}

export function isOverlayPath(pathname: string): boolean {
  return OVERLAY_PATHS.has(pathname);
}

/**
 * The page to render behind an overlay route, or null when `pathname` is a
 * normal page. A direct visit to /login (a bookmark, or a protected page's
 * redirect) gets the live landing page behind it.
 */
export function stageFor(pathname: string, state: unknown): StageLocation | null {
  if (!isOverlayPath(pathname)) return null;
  const bg = backgroundOf(state);
  return bg ? stage(bg.pathname, bg.search) : stage(DEFAULT_STAGE, "");
}

/** Whether the overlay was opened from a page in this tab (so closing can go back). */
export function openedOverStage(state: unknown): boolean {
  return backgroundOf(state) !== null;
}

/** Link state that opens an overlay over the current page, when the page may host one. */
export function overlayState(location: { pathname: string; search: string }): OverlayState | undefined {
  const bg = backgroundOf({ backgroundLocation: location });
  return bg ? { backgroundLocation: bg } : undefined;
}

/** Where closing the overlay returns to when there is no page to go back to. */
export function stageHref(state: unknown): string {
  const bg = backgroundOf(state);
  return bg ? `${bg.pathname}${bg.search}` : DEFAULT_STAGE;
}
