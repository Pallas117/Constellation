/**
 * Step-up for admin actions (GAU-235). The backend answers 428
 * STEP_UP_REQUIRED (backend/rbac.ts) when an admin change arrives without a
 * passkey touch in the last 5 minutes; this asks for the touch and retries
 * once. 428 is used instead of 401/403 so it never counts toward CyberTiger's
 * auth-failure block.
 */

export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

export class StepUpCancelled extends Error {
  constructor() {
    super("Passkey confirmation was cancelled.");
    this.name = "StepUpCancelled";
  }
}

export async function isStepUpRequired(res: Response): Promise<boolean> {
  if (res.status !== 428) return false;
  const body = (await res.clone().json().catch(() => null)) as { code?: unknown } | null;
  return body?.code === STEP_UP_REQUIRED;
}

/**
 * fetch(), but a STEP_UP_REQUIRED answer runs `stepUp` (a passkey touch) and
 * retries the same request once. `init.body` must be re-sendable (a string).
 */
export async function fetchWithStepUp(
  input: string,
  init: RequestInit,
  stepUp: () => Promise<boolean>,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = (i, n) => fetch(i, n),
): Promise<Response> {
  const first = await fetcher(input, init);
  if (!(await isStepUpRequired(first))) return first;
  if (!(await stepUp())) throw new StepUpCancelled();
  return fetcher(input, init);
}
