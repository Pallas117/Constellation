// Traces the magnetosphere off the main thread (20-90 ms per trace), so a
// retrace never drops a rendering frame. Used by useTracedMagnetosphere.
import { computeMagnetosphere, type MagnetosphereState, type SolarWindDrivers } from './geomagnetic';

export interface TraceRequest {
  id: number;
  drivers: SolarWindDrivers;
  epochMs: number;
  tailLength: number;
}

export interface TraceResponse {
  id: number;
  state: MagnetosphereState;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<TraceRequest>) => void) | null;
  postMessage: (message: TraceResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, drivers, epochMs, tailLength } = e.data;
  ctx.postMessage({ id, state: computeMagnetosphere(drivers, epochMs, { tailLength }) });
};
