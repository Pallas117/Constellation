import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CanonicalSpaceWeatherPoint } from '../types.js';
import type { MhdState } from '../physics/mhd-nowcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, '../../shared/proto/telemetry.proto');

let root: protobuf.Root | null = null;

async function getRoot() {
  if (!root) {
    root = await protobuf.load(PROTO_PATH);
  }
  return root;
}

export async function encodeCanonicalPoint(data: CanonicalSpaceWeatherPoint): Promise<Uint8Array> {
  const r = await getRoot();
  const CanonicalPoint = r.lookupType('space.telemetry.CanonicalPoint');
  const message = CanonicalPoint.create(data);
  return CanonicalPoint.encode(message).finish();
}

/** Decoded wire data is untrusted: callers narrow the fields they read. */
export async function decodeCanonicalPoint(buffer: Uint8Array): Promise<Record<string, unknown>> {
  const r = await getRoot();
  const CanonicalPoint = r.lookupType('space.telemetry.CanonicalPoint');
  return CanonicalPoint.toObject(CanonicalPoint.decode(buffer));
}

export async function encodeMhdState(data: MhdState): Promise<Uint8Array> {
  const r = await getRoot();
  const MhdState = r.lookupType('space.telemetry.MhdState');
  const message = MhdState.create(data);
  return MhdState.encode(message).finish();
}

export async function decodeMhdState(buffer: Uint8Array): Promise<Record<string, unknown>> {
  const r = await getRoot();
  const MhdState = r.lookupType('space.telemetry.MhdState');
  return MhdState.toObject(MhdState.decode(buffer));
}
