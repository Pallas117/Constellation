// Traces the magnetosphere off the main thread (20-180 ms per trace) and packs
// render-ready typed arrays that are transferred zero-copy, so a retrace never
// drops a rendering frame. Used by useTracedMagnetosphere.
import { computeMagnetosphere, type SolarWindDrivers } from './geomagnetic';
import { tracedModel, transferables, type TracedModel } from './field-render';

export interface TraceRequest {
  id: number;
  drivers: SolarWindDrivers;
  epochMs: number;
  tailLength: number;
}

export interface TraceResponse {
  id: number;
  model: TracedModel;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<TraceRequest>) => void) | null;
  postMessage: (message: TraceResponse, transfer: ArrayBuffer[]) => void;
};

ctx.onmessage = (e) => {
  const { id, drivers, epochMs, tailLength } = e.data;
  const model = tracedModel(computeMagnetosphere(drivers, epochMs, { tailLength }));
  ctx.postMessage({ id, model }, model.render ? transferables(model.render) : []);
};
