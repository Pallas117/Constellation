import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CanonicalSpaceWeatherPoint } from '../types.js';
import type { MhdState } from '../physics/mhd-nowcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROTO_PATH = path.resolve(__dirname, '../../shared/proto/telemetry.proto');

/** Wire schema version carried in every encoded point (CanonicalPoint.schema). */
export const POINT_SCHEMA = 'sw.point/2.0.0';

/** Absent fields stay absent and empty lists stay empty, so unknown never decodes as 0 or []. */
const DECODE_OPTIONS: protobuf.IConversionOptions = { defaults: false, arrays: true };

let root: protobuf.Root | null = null;

async function getRoot() {
  if (!root) {
    root = await protobuf.load(PROTO_PATH);
  }
  return root;
}

/** null, undefined and non-finite numbers have no wire form: they are left out, which reads back as unknown. */
function known(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map(known);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const wire = known(item);
      if (wire !== undefined) out[key] = wire;
    }
    return out;
  }
  return value;
}

/** Optional lists travel inside a wrapper message, so a known-empty list is not mistaken for an unknown one. */
const LIST_WRAPPERS = { derived: 'fields', senseChecks: 'checks', noaaAlerts: 'alerts' } as const;

function toWire(point: CanonicalSpaceWeatherPoint): Record<string, unknown> {
  const wire = known(point) as Record<string, unknown>;
  for (const [field, inner] of Object.entries(LIST_WRAPPERS)) {
    if (Array.isArray(wire[field])) wire[field] = { [inner]: wire[field] };
  }
  return { ...wire, schema: POINT_SCHEMA };
}

function fromWire(wire: Record<string, unknown>): Record<string, unknown> {
  for (const [field, inner] of Object.entries(LIST_WRAPPERS)) {
    const wrapper = wire[field] as Record<string, unknown> | undefined;
    if (wrapper) wire[field] = wrapper[inner] ?? [];
  }
  return wire;
}

export async function encodeCanonicalPoint(data: CanonicalSpaceWeatherPoint): Promise<Uint8Array> {
  const r = await getRoot();
  const CanonicalPoint = r.lookupType('space.telemetry.CanonicalPoint');
  const wire = toWire(data);
  const invalid = CanonicalPoint.verify(wire);
  if (invalid) throw new Error(`canonical point does not fit ${POINT_SCHEMA}: ${invalid}`);
  return CanonicalPoint.encode(CanonicalPoint.fromObject(wire)).finish();
}

/** Decoded wire data is untrusted: callers narrow the fields they read. Absent means unknown. */
export async function decodeCanonicalPoint(buffer: Uint8Array): Promise<Record<string, unknown>> {
  const r = await getRoot();
  const CanonicalPoint = r.lookupType('space.telemetry.CanonicalPoint');
  return fromWire(CanonicalPoint.toObject(CanonicalPoint.decode(buffer), DECODE_OPTIONS));
}

export async function encodeMhdState(data: MhdState): Promise<Uint8Array> {
  const r = await getRoot();
  const MhdState = r.lookupType('space.telemetry.MhdState');
  const message = MhdState.fromObject(known(data) as Record<string, unknown>);
  return MhdState.encode(message).finish();
}

export async function decodeMhdState(buffer: Uint8Array): Promise<Record<string, unknown>> {
  const r = await getRoot();
  const MhdState = r.lookupType('space.telemetry.MhdState');
  return MhdState.toObject(MhdState.decode(buffer), DECODE_OPTIONS);
}
