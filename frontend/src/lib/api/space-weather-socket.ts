import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";

/**
 * One shared push connection to /ws/feed/space-weather for every hook on the page. It opens on
 * the first subscriber, reconnects with backoff, and closes when the last one leaves. The session
 * cookie authenticates the upgrade; credentials never go in the URL.
 */

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

export interface SpaceWeatherSocketListener {
  onPoint?: (point: CanonicalSpaceWeatherPoint) => void;
  onStatus?: (open: boolean) => void;
}

const listeners = new Set<SpaceWeatherSocketListener>();
let ws: WebSocket | null = null;
let open = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Push is the default; set VITE_HELIO_WS_ENABLED=false to poll only. */
export function spaceWeatherSocketEnabled(): boolean {
  return String(import.meta.env.VITE_HELIO_WS_ENABLED ?? "true") !== "false";
}

function baseUrl(): string {
  return (import.meta.env.VITE_HELIO_PROXY_URL ?? "http://127.0.0.1:3001").replace(/^http/i, "ws");
}

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const l of listeners) l.onStatus?.(next);
}

function connect(): void {
  retryTimer = null;
  if (listeners.size === 0 || ws) return;
  const socket = new WebSocket(`${baseUrl()}/ws/feed/space-weather`);
  ws = socket;

  socket.onopen = () => {
    attempt = 0;
    setOpen(true);
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as { topic?: string; payload?: CanonicalSpaceWeatherPoint };
      if (message.topic !== "space-weather" || !message.payload) return;
      for (const l of listeners) l.onPoint?.(message.payload);
    } catch {
      // Ignore malformed websocket payloads.
    }
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    setOpen(false);
    if (listeners.size === 0) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  };
}

/** Subscribe to pushed points; returns the unsubscribe function. */
export function subscribeSpaceWeather(listener: SpaceWeatherSocketListener): () => void {
  if (!spaceWeatherSocketEnabled()) return () => {};
  listeners.add(listener);
  if (open) listener.onStatus?.(true);
  if (!ws && !retryTimer) connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    attempt = 0;
    if (ws) {
      const socket = ws;
      ws = null;
      socket.onclose = null;
      socket.close();
    }
    open = false;
  };
}

export function spaceWeatherSocketOpen(): boolean {
  return open;
}
