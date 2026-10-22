// In-memory stand-in for a Cloudflare KV namespace: get/put/delete/list, with metadata and expiry.
export function memoryKV() {
  const m = new Map();
  const alive = (k) => {
    const e = m.get(k);
    if (e?.exp && e.exp * 1000 <= Date.now()) m.delete(k);
    return m.get(k);
  };
  return {
    map: m,
    async get(key, opts) {
      const e = alive(key);
      return e === undefined ? null : (opts?.type ?? opts) === "json" ? JSON.parse(e.v) : e.v;
    },
    async put(key, value, opts = {}) {
      const exp = opts.expiration ?? (opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : undefined);
      m.set(key, { v: String(value), meta: opts.metadata ?? null, exp });
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
