import { useCallback, useEffect, useRef, useState } from 'react';
import { computeMagnetosphere, type SolarWindDrivers } from '@/lib/physics/geomagnetic';
import { DriverAverager, shouldRetrace } from '@/lib/physics/driver-smoothing';
import { fieldScalars, tracedModel, type TracedModel } from '@/lib/physics/field-render';
import type { TraceRequest, TraceResponse } from '@/lib/physics/magnetosphere.worker';

const EPOCH_BUCKET_MS = 10 * 60_000; // dipole tilt changes < 2.5° in 10 min
const RESAMPLE_MS = 30_000; // the averaging window slides even when values don't change

export interface TracedMagnetosphere {
  /** Field model being shown; a new one crossfades in (see FieldLinePool). */
  current: TracedModel;
  /** Increments on every new trace. */
  version: number;
  /** Drivers the current model used (averaged when smoothing is on). */
  drivers: SolarWindDrivers;
  /** When the current field lines were traced; null before the first trace. */
  tracedAt: number | null;
}

interface Options {
  /** Average drivers over 5 min (live data). Off for simulations, which change on purpose. */
  smooth: boolean;
  tailLength: number;
}

const bucket = (epochMs: number) => Math.floor(epochMs / EPOCH_BUCKET_MS) * EPOCH_BUCKET_MS;

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../../lib/physics/magnetosphere.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/**
 * Stable, off-main-thread field-line tracing for live data:
 * drivers -> 5-min running mean -> hysteresis -> Web Worker trace
 * (transferred typed arrays) -> crossfade.
 */
export function useTracedMagnetosphere(drivers: SolarWindDrivers, epochMs: number, { smooth, tailLength }: Options): TracedMagnetosphere {
  const averager = useRef(new DriverAverager());
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const inFlight = useRef<{ id: number; drivers: SolarWindDrivers } | null>(null);
  const queued = useRef<{ drivers: SolarWindDrivers; epoch: number } | null>(null);
  const traced = useRef<{ drivers: SolarWindDrivers; epoch: number } | null>(null);

  // First frame: boundaries from cheap closed-form scalars; field lines arrive
  // from the worker a moment later and fade in. Nothing blocks the first paint.
  const [model, setModel] = useState(() => ({
    current: { ...fieldScalars(drivers, bucket(epochMs)), openFraction: null, render: null } as TracedModel,
    version: 0,
    drivers,
    tracedAt: null as number | null,
  }));

  const accept = useCallback((next: TracedModel, used: SolarWindDrivers) => {
    setModel((m) => ({ current: next, version: m.version + 1, drivers: used, tracedAt: Date.now() }));
  }, []);

  const dispatch = useCallback(
    (target: SolarWindDrivers, epoch: number) => {
      traced.current = { drivers: target, epoch };
      const worker = workerRef.current;
      if (!worker) {
        // No worker (old browser / tests): trace after this render instead of during it.
        setTimeout(() => accept(tracedModel(computeMagnetosphere(target, epoch, { tailLength })), target), 0);
        return;
      }
      if (inFlight.current) {
        queued.current = { drivers: target, epoch }; // coalesce: only the latest request matters
        return;
      }
      const id = ++requestId.current;
      inFlight.current = { id, drivers: target };
      const msg: TraceRequest = { id, drivers: target, epochMs: epoch, tailLength };
      worker.postMessage(msg);
    },
    [accept, tailLength],
  );

  // Worker lifecycle (declared before the effects that dispatch, so it exists first).
  useEffect(() => {
    const worker = createWorker();
    workerRef.current = worker;
    if (!worker) return;
    worker.onmessage = (e: MessageEvent<TraceResponse>) => {
      const flight = inFlight.current;
      if (!flight || e.data.id !== flight.id) return;
      inFlight.current = null;
      accept(e.data.model, flight.drivers);
      const next = queued.current;
      queued.current = null;
      if (next) dispatch(next.drivers, next.epoch);
    };
    worker.onerror = () => {
      // Fall back to main-thread tracing rather than freezing the scene.
      worker.terminate();
      workerRef.current = null;
      const pending = inFlight.current;
      inFlight.current = null;
      if (pending && traced.current) dispatch(traced.current.drivers, traced.current.epoch);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      inFlight.current = null;
    };
  }, [accept, dispatch]);

  // Retrace when the (averaged) drivers move meaningfully, or the tilt bucket changes.
  const evaluate = useCallback(
    (now: number) => {
      const target = smooth ? averager.current.mean(now) : drivers;
      if (!target) return;
      const epoch = bucket(epochMs);
      const last = traced.current;
      if (!last || last.epoch !== epoch || shouldRetrace(last.drivers, target)) dispatch(target, epoch);
    },
    [smooth, drivers, epochMs, dispatch],
  );

  useEffect(() => {
    if (!smooth) averager.current.reset();
  }, [smooth]);

  // `drivers` keeps its identity while the values are unchanged (the caller
  // memoises it), so this runs once per new reading.
  useEffect(() => {
    const now = Date.now();
    if (smooth) averager.current.push(now, drivers);
    evaluate(now);
  }, [drivers, smooth, evaluate]);

  useEffect(() => {
    if (!smooth) return;
    const id = window.setInterval(() => evaluate(Date.now()), RESAMPLE_MS);
    return () => window.clearInterval(id);
  }, [smooth, evaluate]);

  return model;
}
