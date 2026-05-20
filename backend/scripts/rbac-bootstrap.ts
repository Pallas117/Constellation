import { createClient } from "@supabase/supabase-js";

type AppRole = "viewer" | "operator" | "admin";

type RoleSpec = {
  role: AppRole;
  emailEnv: string;
  passwordEnv: string;
};

const ROLE_SPECS: RoleSpec[] = [
  { role: "viewer", emailEnv: "RBAC_VIEWER_EMAIL", passwordEnv: "RBAC_VIEWER_PASSWORD" },
  { role: "operator", emailEnv: "RBAC_OPERATOR_EMAIL", passwordEnv: "RBAC_OPERATOR_PASSWORD" },
  { role: "admin", emailEnv: "RBAC_ADMIN_EMAIL", passwordEnv: "RBAC_ADMIN_PASSWORD" },
];

const HELP_TEXT = `
RBAC bootstrap helper for Supabase Auth users.

Usage:
  npm run setup:rbac
  npm run setup:rbac -- --help

Required environment:
  SUPABASE_URL or VITE_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  RBAC_VIEWER_EMAIL / RBAC_VIEWER_PASSWORD
  RBAC_OPERATOR_EMAIL / RBAC_OPERATOR_PASSWORD
  RBAC_ADMIN_EMAIL / RBAC_ADMIN_PASSWORD

Optional:
  RBAC_FORCE_PASSWORD_UPDATE=true|false  (default: true)
  RBAC_EMAIL_CONFIRMED=true|false        (default: true)
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

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function maskEmail(email: string): string {
  const value = normalizeEmail(email);
  const at = value.indexOf("@");
  if (at <= 1) return `***${value.slice(at)}`;
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}

function truncateId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 8)}...`;
}

async function findUserByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string,
): Promise<{ id: string; app_metadata?: Record<string, unknown> } | null> {
  const target = normalizeEmail(email);
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`listUsers failed: ${error.message}`);
    }
    const users = data?.users ?? [];
    const found = users.find((user) => normalizeEmail(user.email ?? "") === target);
    if (found) {
      return {
        id: found.id,
        app_metadata: (found.app_metadata ?? {}) as Record<string, unknown>,
      };
    }
    if (users.length < perPage) {
      return null;
    }
  }

  throw new Error("listUsers pagination exceeded safety limit");
}

async function ensureRoleUser(
  supabase: ReturnType<typeof createClient>,
  roleSpec: RoleSpec,
  email: string,
  password: string,
  forcePasswordUpdate: boolean,
  emailConfirmed: boolean,
): Promise<void> {
  const existing = await findUserByEmail(supabase, email);

  if (!existing) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: emailConfirmed,
      app_metadata: { role: roleSpec.role },
    });
    if (error || !data.user) {
      throw new Error(`createUser failed for ${email}: ${error?.message ?? "unknown error"}`);
    }
    console.log(
      `[CREATE] role=${roleSpec.role} email=${maskEmail(email)} id=${truncateId(data.user.id)}`,
    );
    return;
  }

  const nextMetadata = {
    ...(existing.app_metadata ?? {}),
    role: roleSpec.role,
  };

  const updatePayload: {
    app_metadata: Record<string, unknown>;
    email_confirm?: boolean;
    password?: string;
  } = {
    app_metadata: nextMetadata,
  };

  if (emailConfirmed) {
    updatePayload.email_confirm = true;
  }
  if (forcePasswordUpdate) {
    updatePayload.password = password;
  }

  const { error } = await supabase.auth.admin.updateUserById(existing.id, updatePayload);
  if (error) {
    throw new Error(`updateUserById failed for ${email}: ${error.message}`);
  }
  console.log(
    `[UPDATE] role=${roleSpec.role} email=${maskEmail(email)} id=${truncateId(existing.id)}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(HELP_TEXT.trim());
    return;
  }

  const supabaseUrl = envValue("SUPABASE_URL", "VITE_SUPABASE_URL");
  const serviceRoleKey = envValue("SUPABASE_SERVICE_ROLE_KEY");
  const forcePasswordUpdate = envBool("RBAC_FORCE_PASSWORD_UPDATE", true);
  const emailConfirmed = envBool("RBAC_EMAIL_CONFIRMED", true);

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const resolved = ROLE_SPECS.map((spec) => {
    const email = envValue(spec.emailEnv);
    const password = envValue(spec.passwordEnv);
    return { spec, email, password };
  });

  const missing = resolved.filter((item) => !item.email || !item.password);
  if (missing.length > 0) {
    for (const item of missing) {
      console.error(`Missing ${item.spec.emailEnv} and/or ${item.spec.passwordEnv}`);
    }
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  console.log(
    `[RBAC] Bootstrapping users for ${supabaseUrl} (forcePasswordUpdate=${forcePasswordUpdate}, emailConfirmed=${emailConfirmed})`,
  );

  for (const item of resolved) {
    await ensureRoleUser(
      supabase,
      item.spec,
      item.email!,
      item.password!,
      forcePasswordUpdate,
      emailConfirmed,
    );
  }

  console.log("[RBAC] Complete.");
}

main().catch((error) => {
  console.error("[RBAC] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
