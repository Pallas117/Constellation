/**
 * Operator Device Fingerprinting — privacy-first, localStorage-only.
 *
 * Builds a fingerprint from hardware signals available without permissions:
 *   - GPU renderer string
 *   - CPU core count
 *   - Screen resolution + colour depth
 *   - Timezone + locale
 *   - Touch support
 *   - Camera/mic device count (enumerated without labels if no permission)
 *
 * The fingerprint is stored as a SHA-256 hex hash in localStorage.
 * Nothing is transmitted over the network.
 */

const STORAGE_KEY = "gauss_op_fingerprint";

export interface DeviceFingerprint {
  hash: string;
  buildAt: string;
  signals: Record<string, string | number>;
}

/** Build a fingerprint from available hardware signals */
export async function buildFingerprint(): Promise<DeviceFingerprint> {
  const signals: Record<string, string | number> = {};

  // GPU renderer (available without permissions)
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl") as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        signals.gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
      }
    }
  } catch { /* GPU unavailable */ }

  signals.cpu_cores = navigator.hardwareConcurrency ?? 0;
  signals.screen = `${screen.width}x${screen.height}x${screen.colorDepth}`;
  signals.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  signals.locale = navigator.language;
  signals.touch = navigator.maxTouchPoints ?? 0;
  signals.ua_platform = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.platform ?? "";

  // Device count without requesting media stream access
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    signals.video_inputs = devices.filter(d => d.kind === "videoinput").length;
    signals.audio_inputs = devices.filter(d => d.kind === "audioinput").length;
  } catch { /* no media access */ }

  // Hash the signals
  const raw = JSON.stringify(signals, Object.keys(signals).sort());
  const msgBuffer = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return { hash, buildAt: new Date().toISOString(), signals };
}

/** Returns true if the given fingerprint matches a stored trusted device */
export function verifyFingerprint(fp: DeviceFingerprint): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const record = JSON.parse(stored) as { hash: string };
    return record.hash === fp.hash;
  } catch {
    return false;
  }
}

/** Store a new trusted device fingerprint after successful authentication */
export function learnDevice(fp: DeviceFingerprint): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hash: fp.hash, learnedAt: new Date().toISOString() }));
  } catch { /* storage unavailable */ }
}

/** Remove all stored trusted device fingerprints (security wipe) */
export function forgetDevice(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable */ }
}
