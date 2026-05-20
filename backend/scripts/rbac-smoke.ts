type RoleName = "viewer" | "operator" | "admin";

type RoleConfig = {
  role: RoleName;
  tokenEnv: string;
  emailEnv: string;
  passwordEnv: string;
  required: boolean;
};

type HttpResult = {
  status: number;
  body: unknown;
  raw: string;
};

const HELP_TEXT = `
RBAC smoke test for backend role gating.

Usage:
  npm run test:rbac
  npm run test:rbac -- --help

Environment:
  SUPABASE_URL or VITE_SUPABASE_URL               (required)
  SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY (required)
  BACKEND_BASE_URL                                (optional, default: http://127.0.0.1:3001)

  RBAC_VIEWER_TOKEN or RBAC_VIEWER_EMAIL/RBAC_VIEWER_PASSWORD       (required)
  RBAC_OPERATOR_TOKEN or RBAC_OPERATOR_EMAIL/RBAC_OPERATOR_PASSWORD (required)
  RBAC_ADMIN_TOKEN or RBAC_ADMIN_EMAIL/RBAC_ADMIN_PASSWORD          (optional unless RBAC_TEST_TRAIN=true)
  RBAC_TEST_TRAIN=true|false                                        (optional, default: false)
  RBAC_SKIP_HEALTH_CHECK=true|false                                 (optional, default: false)
`;

function envValue(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isTruthy(value: string | null | undefined): boolean {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function syntheticTestIp(): string {
  const explicit = envValue("RBAC_TEST_IP");
  if (explicit) {
    return explicit;
  }
  // TEST-NET-2 range reserved for documentation/examples.
  const tail = Math.max(1, Math.min(254, Math.floor(Math.random() * 254) + 1));
  return `198.51.100.${tail}`;
}

function formatNetworkError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const message = (error as { message?: string }).message ?? "unknown error";
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") {
    return message;
  }
  const code = (cause as { code?: string }).code ?? "unknown-code";
  const errno = (cause as { errno?: string | number }).errno ?? "unknown-errno";
  const address = (cause as { address?: string }).address ?? "unknown-address";
  const port = (cause as { port?: string | number }).port ?? "unknown-port";
  return `${message} (cause code=${code}, errno=${errno}, address=${address}, port=${port})`;
}

async function requestJson(url: string, init?: RequestInit, context = "http"): Promise<HttpResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new Error(`[${context}] fetch failed for ${url}: ${formatNetworkError(error)}`);
  }
  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: response.status, body, raw };
}

async function loginWithPassword(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<string> {
  const result = await requestJson(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
    "supabase-auth",
  );

  const token = (result.body as { access_token?: string } | null)?.access_token;
  if (result.status !== 200 || !token) {
    throw new Error(
      `Auth failed for ${email} (HTTP ${result.status}): ${
        typeof result.body === "string" ? result.body : JSON.stringify(result.body)
      }`,
    );
  }
  return token;
}

function buildInferencePayload() {
  const now = new Date().toISOString();
  return {
    horizonMinutes: 30,
    sequence: [
      {
        timestamp: now,
        source: "fusion",
        rho: 5,
        velocity: { x: -400, y: 0, z: 0, magnitude: 400 },
        magneticField: { x: 2, y: -1, z: -4, bt: 4.58 },
        electricField: { x: 0.1, y: 1.5, z: 0.2, ey: 1.5 },
        solarWind: { speed: 400, density: 5, dynamicPressure: 2.1 },
        indices: { kp: 3, dst: -20 },
        coupling: { newell: 1500, epsilon: 120000000000 },
        propagation: { l1DelaySeconds: 3600, etaEarthArrival: now },
        alerts: { stormTier: "watch", reason: "RBAC smoke test sample" },
        quality: {
          outlier: false,
          stale: false,
          interpolated: false,
          extrapolated: false,
          lowConfidence: false,
        },
        uncertainty: {
          speed: { lower: 380, upper: 420, sigma: 10 },
          density: { lower: 4.4, upper: 5.6, sigma: 0.3 },
          bz: { lower: -4.8, upper: -3.2, sigma: 0.4 },
        },
      },
    ],
  };
}

function asRole(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return "<missing>";
}

function printResult(name: string, passed: boolean, detail: string): boolean {
  const label = passed ? "PASS" : "FAIL";
  console.log(`[${label}] ${name} - ${detail}`);
  return passed;
}

async function resolveToken(
  config: RoleConfig,
  supabaseUrl: string,
  anonKey: string,
): Promise<string | null> {
  const directToken = envValue(config.tokenEnv);
  if (directToken) {
    return directToken;
  }

  const email = envValue(config.emailEnv);
  const password = envValue(config.passwordEnv);
  if (!email || !password) {
    return null;
  }
  return loginWithPassword(supabaseUrl, anonKey, email, password);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(HELP_TEXT.trim());
    return;
  }

  const supabaseUrl = envValue("SUPABASE_URL", "VITE_SUPABASE_URL");
  const anonKey = envValue("SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY");
  const backendBaseUrl = envValue("BACKEND_BASE_URL") ?? "http://127.0.0.1:3001";
  const runTrainCheck = isTruthy(envValue("RBAC_TEST_TRAIN"));
  const testIp = syntheticTestIp();
  const backendBaseHeaders: Record<string, string> = {
    "x-forwarded-for": testIp,
  };

  if (!supabaseUrl || !anonKey) {
    console.error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_ANON_KEY/VITE_SUPABASE_PUBLISHABLE_KEY.");
    process.exit(1);
  }

  const skipHealth = isTruthy(envValue("RBAC_SKIP_HEALTH_CHECK"));
  if (!skipHealth) {
    const health = await requestJson(
      `${backendBaseUrl}/health`,
      { headers: backendBaseHeaders },
      "backend-health",
    );
    if (health.status !== 200) {
      throw new Error(`[backend-health] expected HTTP 200 but got HTTP ${health.status}`);
    }
  }

  const roleConfigs: RoleConfig[] = [
    {
      role: "viewer",
      tokenEnv: "RBAC_VIEWER_TOKEN",
      emailEnv: "RBAC_VIEWER_EMAIL",
      passwordEnv: "RBAC_VIEWER_PASSWORD",
      required: true,
    },
    {
      role: "operator",
      tokenEnv: "RBAC_OPERATOR_TOKEN",
      emailEnv: "RBAC_OPERATOR_EMAIL",
      passwordEnv: "RBAC_OPERATOR_PASSWORD",
      required: true,
    },
    {
      role: "admin",
      tokenEnv: "RBAC_ADMIN_TOKEN",
      emailEnv: "RBAC_ADMIN_EMAIL",
      passwordEnv: "RBAC_ADMIN_PASSWORD",
      required: runTrainCheck,
    },
  ];

  const tokens = new Map<RoleName, string>();
  for (const config of roleConfigs) {
    const token = await resolveToken(config, supabaseUrl, anonKey);
    if (!token && config.required) {
      console.error(
        `Missing credentials for ${config.role}. Set ${config.tokenEnv} or ${config.emailEnv}/${config.passwordEnv}.`,
      );
      process.exit(1);
    }
    if (token) {
      tokens.set(config.role, token);
    }
  }

  let failures = 0;
  const samplePayload = buildInferencePayload();

  const noAuth = await requestJson(
    `${backendBaseUrl}/api/feed/sources/status`,
    { headers: backendBaseHeaders },
    "backend-rbac-noauth",
  );
  if (!printResult("No token rejected", noAuth.status === 401, `HTTP ${noAuth.status}`)) {
    failures += 1;
  }

  for (const role of ["viewer", "operator", "admin"] as RoleName[]) {
    const token = tokens.get(role);
    if (!token) {
      console.log(`[SKIP] ${role} status check - token not configured`);
      continue;
    }
    const statusRes = await requestJson(
      `${backendBaseUrl}/api/feed/sources/status`,
      {
        headers: { ...backendBaseHeaders, Authorization: `Bearer ${token}` },
      },
      `backend-status-${role}`,
    );
    const roleFromApi = asRole(
      (statusRes.body as { auth?: { role?: string } } | null)?.auth?.role,
    );
    const statusPass = statusRes.status === 200;
    const rolePass = roleFromApi === role;
    if (!printResult(`${role} can access viewer endpoint`, statusPass, `HTTP ${statusRes.status}`)) {
      failures += 1;
    }
    if (!printResult(`${role} role resolved`, rolePass, `reported=${roleFromApi}`)) {
      failures += 1;
    }
  }

  const viewerToken = tokens.get("viewer");
  if (viewerToken) {
    const viewerInfer = await requestJson(
      `${backendBaseUrl}/api/ai/nowcast/infer`,
      {
        method: "POST",
        headers: {
          ...backendBaseHeaders,
          Authorization: `Bearer ${viewerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(samplePayload),
      },
      "backend-infer-viewer",
    );
    if (
      !printResult(
        "viewer blocked from infer",
        viewerInfer.status === 403,
        `HTTP ${viewerInfer.status}`,
      )
    ) {
      failures += 1;
    }
  }

  const operatorToken = tokens.get("operator");
  if (operatorToken) {
    const operatorInfer = await requestJson(
      `${backendBaseUrl}/api/ai/nowcast/infer`,
      {
        method: "POST",
        headers: {
          ...backendBaseHeaders,
          Authorization: `Bearer ${operatorToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(samplePayload),
      },
      "backend-infer-operator",
    );
    if (
      !printResult(
        "operator allowed to infer",
        operatorInfer.status === 200,
        `HTTP ${operatorInfer.status}`,
      )
    ) {
      failures += 1;
    }

    const operatorTrain = await requestJson(
      `${backendBaseUrl}/api/ai/nowcast/train`,
      {
        method: "POST",
        headers: { ...backendBaseHeaders, Authorization: `Bearer ${operatorToken}` },
      },
      "backend-train-operator",
    );
    if (
      !printResult(
        "operator blocked from train",
        operatorTrain.status === 403,
        `HTTP ${operatorTrain.status}`,
      )
    ) {
      failures += 1;
    }
  }

  if (runTrainCheck) {
    const adminToken = tokens.get("admin");
    if (adminToken) {
      const adminTrain = await requestJson(
        `${backendBaseUrl}/api/ai/nowcast/train`,
        {
          method: "POST",
          headers: { ...backendBaseHeaders, Authorization: `Bearer ${adminToken}` },
        },
        "backend-train-admin",
      );
      const pass = adminTrain.status !== 401 && adminTrain.status !== 403;
      if (!printResult("admin not blocked from train", pass, `HTTP ${adminTrain.status}`)) {
        failures += 1;
      }
    } else {
      console.log("[SKIP] admin train check - token not configured");
    }
  } else {
    console.log("[SKIP] admin train check - set RBAC_TEST_TRAIN=true to enable");
  }

  if (failures > 0) {
    console.error(`\nRBAC smoke test failed with ${failures} issue(s).`);
    process.exit(1);
  }

  console.log(`\nRBAC smoke test passed. (testIp=${testIp})`);
}

main().catch((error) => {
  console.error("RBAC smoke test failed with an unexpected error:", error);
  process.exit(1);
});
