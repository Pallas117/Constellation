/**
 * Boot-time switches (GAU-228): work the backend starts on boot that a small host (an 8 GB Mac)
 * can park. Parked code still compiles and is tested; it only leaves the default boot path.
 * Read from the environment at start-up; docs/INSTALL.md lists them.
 *
 *   GAUSS_SWAP_TIMER   default on   Device swap rebalance every SWAP_BALANCE_INTERVAL_MS (45 s). Each
 *                                   tick is skipped while no device is registered.
 *   GAUSS_MMS          default on   MMS CDAWeb polling (10 min): the reconnection vectors.
 *   GAUSS_LASP         default on   MMS LASP SDC burst-window polling (60 s).
 *   GAUSS_NATIVE_MHD   default off  Load the C++ MHD kernel (build it first: npm run build:native).
 */

/** "1"/"true"/"on"/"yes" turn a switch on, "0"/"false"/"off"/"no" off; anything else keeps the default. */
export function envSwitch(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "off" || value === "no") return false;
  return fallback;
}

export interface BootSwitches {
  swapTimer: boolean;
  mms: boolean;
  lasp: boolean;
  nativeMhd: boolean;
}

export function bootSwitches(env: Record<string, string | undefined> = process.env): BootSwitches {
  return {
    swapTimer: envSwitch(env.GAUSS_SWAP_TIMER, true),
    mms: envSwitch(env.GAUSS_MMS, true),
    lasp: envSwitch(env.GAUSS_LASP, true),
    nativeMhd: envSwitch(env.GAUSS_NATIVE_MHD, false),
  };
}
