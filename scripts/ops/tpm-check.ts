/**
 * TPM check against a running backend (GAU-122): `npm run tpm [-- --url http://127.0.0.1:3001]`.
 * Reads the public /health summary (status and red measure ids only). Exit codes: 0 green or
 * insufficient, 1 amber (warning), 2 red, 3 backend unreachable. For services checks and alerts.
 */
const i = process.argv.indexOf("--url");
const base = (i >= 0 ? process.argv[i + 1] : process.env.GAUSS_BACKEND_URL) ?? "http://127.0.0.1:3001";

try {
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  const body = (await res.json()) as { ok?: boolean; tpm?: { status: string; red: string[] } };
  const status = body.tpm?.status ?? "unknown";
  const red = body.tpm?.red ?? [];
  console.log(`TPM ${status.toUpperCase()}${red.length ? `: red ${red.join(", ")}` : ""} (${base})`);
  if (status !== "unknown" && !body.tpm) console.log("backend predates TPMs (GAU-122)");
  process.exit(status === "red" ? 2 : status === "amber" ? 1 : 0);
} catch (error) {
  console.log(`TPM UNKNOWN: backend unreachable at ${base} (${error instanceof Error ? error.name : "error"})`);
  process.exit(3);
}
