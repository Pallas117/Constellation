type EnvRequirement = {
  key: string;
  required: boolean;
  description: string;
};

const requirements: EnvRequirement[] = [
  { key: "SUPABASE_URL", required: true, description: "Supabase project URL" },
  { key: "SUPABASE_ANON_KEY", required: true, description: "Supabase anon/public key" },
  { key: "SUPABASE_SERVICE_ROLE_KEY", required: true, description: "Supabase service role key" },
  { key: "PROXY_PORT", required: false, description: "Backend HTTP port (default 3001)" },
  { key: "PROXY_HOST", required: false, description: "Backend bind host (default 127.0.0.1)" },
  { key: "ALLOWED_ORIGINS", required: false, description: "CSV list for CORS allowlist" },
  { key: "AUTH_REQUIRED", required: false, description: "Set false only for local bypass" },
  { key: "CYBERTIGER_ENABLED", required: false, description: "Enable/disable CyberTiger daemon" },
  { key: "CYBERTIGER_RATE_LIMIT_WINDOW_MS", required: false, description: "Rate limit window in ms" },
  { key: "CYBERTIGER_RATE_LIMIT_MAX", required: false, description: "Max requests per IP per window" },
  { key: "CYBERTIGER_AUTH_FAILURE_WINDOW_MS", required: false, description: "Auth failure rolling window in ms" },
  { key: "CYBERTIGER_AUTH_FAILURE_THRESHOLD", required: false, description: "Auth failures before auto-block" },
  { key: "CYBERTIGER_AUTO_BLOCK_SECONDS", required: false, description: "Auto-block duration in seconds" },
  { key: "CYBERTIGER_MAX_EVENTS", required: false, description: "In-memory security event cap" },
  { key: "LOCAL_INFER_URL", required: false, description: "ML inference service URL" },
  { key: "TRAINING_SCRIPT_PATH", required: false, description: "Model training script path" },
];

function maskSecret(value: string): string {
  if (value.length <= 10) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

let hasMissingRequired = false;

console.log("[backend-env] Checking backend configuration:");
for (const item of requirements) {
  const raw = process.env[item.key];
  const present = typeof raw === "string" && raw.trim().length > 0;
  const marker = present ? "OK " : item.required ? "ERR" : "WARN";

  let valuePreview = "<missing>";
  if (present) {
    const value = raw!.trim();
    const looksSecret =
      item.key.includes("KEY") || item.key.includes("TOKEN") || item.key.includes("SECRET");
    valuePreview = looksSecret ? maskSecret(value) : value;
  }

  console.log(`${marker} ${item.key}=${valuePreview}  (${item.description})`);

  if (item.required && !present) {
    hasMissingRequired = true;
  }
}

if (hasMissingRequired) {
  console.error("[backend-env] Missing required vars. See .env.example and your local .env.");
  process.exit(1);
}

console.log("[backend-env] Ready.");
