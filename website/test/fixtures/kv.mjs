// In-memory stand-in for a Cloudflare KV namespace: get/put/delete/list, with metadata and expiry.
export function memoryKV() {
  const m = new Map();
  const alive = (k) => {
    const e = m.get(k);
    if (e?.exp && e.exp * 1000 <= Date.now()) m.delete(k);
    return m.get(k);
  };
  const out = (v, opts) => {
    const type = opts?.type ?? opts;
    if (type === "arrayBuffer") return typeof v === "string" ? new TextEncoder().encode(v).buffer : v.slice(0);
    return type === "json" ? JSON.parse(v) : typeof v === "string" ? v : new TextDecoder().decode(v);
  };
  return {
    map: m,
    async get(key, opts) {
      const e = alive(key);
      return e === undefined ? null : out(e.v, opts);
    },
    async getWithMetadata(key, opts) {
      const e = alive(key);
      return { value: e === undefined ? null : out(e.v, opts), metadata: e?.meta ?? null };
    },
    async put(key, value, opts = {}) {
      const exp = opts.expiration ?? (opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : undefined);
      m.set(key, { v: value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value instanceof ArrayBuffer ? value.slice(0) : String(value), meta: opts.metadata ?? null, exp });
    },
    async delete(key) {
      m.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix) && alive(k)).sort().map((name) => ({ name, metadata: m.get(name).meta }));
      return { keys, list_complete: true };
    },
  };
}
