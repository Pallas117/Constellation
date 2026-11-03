import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Fingerprint, LogOut } from "lucide-react";
import { OperatorGeometryFigure } from "@/components/OperatorGeometryFigure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { refreshOperatorGeometry, useOperatorGeometry, type PasskeyRow } from "@/hooks/useOperatorGeometry";
import { apiBase } from "@/lib/api/base-url";
import { authClient, passkeyTouch, signOut, useSession } from "@/lib/auth-client";
import { passkeyErrorMessage, passkeySupport, type PasskeySupport } from "@/lib/passkey-support";
import { hasRole, roleOf, type Role } from "@/lib/roles";
import { fetchWithStepUp, StepUpCancelled } from "@/lib/step-up";

const ROLES: Role[] = ["user", "staff", "operator", "admin"];

function fmt(value: PasskeyRow["createdAt"]): string {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : "—";
}

function usePasskeySupport(): PasskeySupport | null {
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  useEffect(() => {
    fetch(`${apiBase()}/api/sso-options`)
      .then((res) => (res.ok ? res.json() : null))
      .then((options) =>
        setSupport(
          passkeySupport({
            rpId: typeof options?.passkey?.rpId === "string" ? options.passkey.rpId : null,
            location: window.location,
            secure: window.isSecureContext,
            webauthn: typeof window.PublicKeyCredential === "function",
          }),
        ),
      )
      .catch(() => undefined);
  }, []);
  return support;
}

/** Passkeys on this account: add one for this device, remove old ones. */
function PasskeysCard({ passkeys, support }: { passkeys: PasskeyRow[] | null; support: PasskeySupport | null }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setMessage(null);
    const { error } = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
    setBusy(false);
    if (error) {
      const fresh = /fresh|session/i.test(error.message ?? "");
      setMessage(fresh ? "Sign out and in again, then add the passkey: adding one needs a recent sign-in." : passkeyErrorMessage(error, "add"));
      return;
    }
    setName("");
    setMessage("Passkey added. Next time, sign in with one touch.");
    refreshOperatorGeometry();
  };

  const remove = async (id: string) => {
    setConfirming(null);
    const { error } = await authClient.passkey.deletePasskey({ id });
    setMessage(error ? error.message || "Could not remove the passkey." : "Passkey removed.");
    refreshOperatorGeometry();
  };

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          A passkey signs you in with one touch: Touch ID on a Mac, Face ID or a fingerprint on a phone, or the device's PIN when
          those aren't set up. Your fingerprint or face never leaves the device; Gauss stores the passkey's public key only.
        </p>
        {passkeys && passkeys.length > 0 && (
          <ul className="divide-y divide-border/60">
            {passkeys.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name || "Passkey"}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {fmt(p.createdAt)}
                    {p.backedUp ? " · synced across your devices" : " · this device only"}
                  </p>
                </div>
                {confirming === p.id ? (
                  <div className="flex gap-1">
                    <Button size="sm" variant="destructive" onClick={() => void remove(p.id)}>
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(p.id)}>
                    Remove…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {passkeys && passkeys.length === 0 && <p>No passkeys yet.</p>}
        {support?.ok ? (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row">
            <Input placeholder="name, e.g. work MacBook" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <Button onClick={() => void add()} disabled={busy}>
              <Fingerprint className="h-4 w-4" aria-hidden="true" />
              {busy ? "Waiting for your touch…" : "Add a passkey"}
            </Button>
          </div>
        ) : (
          support && (
            <p className="border-t border-border/60 pt-4 text-muted-foreground">
              {support.hint}{" "}
              {support.href && (
                <a href={support.href} className="underline underline-offset-2 hover:text-foreground">
                  Open this page there
                </a>
              )}
            </p>
          )
        )}
        {message && <p role="status">{message}</p>}
      </CardContent>
    </Card>
  );
}

interface AdminUser {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  passkeys: number;
}

/** Admins only: change roles. Each change needs a fresh passkey touch (step-up). */
function RolesCard({ selfId, hasPasskey }: { selfId: string; hasPasskey: boolean }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`${apiBase()}/api/admin/users`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { users: AdminUser[] }) => setUsers(body.users))
      .catch((err) => setMessage(err instanceof Error ? `Could not load users (${err.message}).` : "Could not load users."));
  }, []);
  useEffect(load, [load]);

  const change = async (user: AdminUser, role: Role) => {
    setMessage(null);
    const stepUp = async () => {
      const touch = await passkeyTouch("confirm");
      if ("error" in touch) {
        setMessage(touch.error);
        return false;
      }
      return touch.userId === selfId;
    };
    try {
      const res = await fetchWithStepUp(
        `${apiBase()}/api/admin/users/${encodeURIComponent(user.id)}/role`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) },
        stepUp,
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMessage(res.ok ? `${user.email ?? user.id} is now ${role}.` : body.error ?? `Could not change the role (HTTP ${res.status}).`);
      load();
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) setMessage("Could not change the role.");
    }
  };

  return (
    <Card className="min-w-0 xl:col-span-2">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Roles</CardTitle>
        <Badge variant="outline">admin</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Each change asks for your passkey (a touch in the last 5 minutes counts). Nobody changes their own role here, and the last
          admin stays an admin.
        </p>
        {!hasPasskey && <p className="text-caution">Add a passkey first: role changes need a fresh touch.</p>}
        {users && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Account</th>
                  <th className="py-2 pr-4">Passkeys</th>
                  <th className="py-2">Role</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-border/60">
                    <td className="py-2 pr-4">
                      <p>{u.name || "—"}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">{u.passkeys}</td>
                    <td className="py-2">
                      <select
                        aria-label={`Role for ${u.email ?? u.id}`}
                        value={u.role}
                        disabled={u.id === selfId || !hasPasskey}
                        onChange={(e) => void change(u, e.target.value as Role)}
                        className="rounded-md border border-charcoal bg-black px-2 py-1 text-sm disabled:opacity-60"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {message && <p role="status">{message}</p>}
      </CardContent>
    </Card>
  );
}

/** Passkeys, the operator's geometry and sign-out for the signed-in account (GAU-235). */
const AccountSecurity = () => {
  useDocumentTitle("Passkeys and sign-in");
  const { data: session } = useSession();
  const navigate = useNavigate();
  const { passkeys, geometry } = useOperatorGeometry();
  const support = usePasskeySupport();
  const role = roleOf(session?.user);
  const selfId = session?.user?.id ?? "";

  const end = async (everywhere: boolean) => {
    if (everywhere) await authClient.revokeSessions().catch(() => undefined);
    await signOut().catch(() => undefined);
    navigate("/login", { replace: true, state: { signedOut: "user" } });
  };

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="brand-label">00_ACCOUNT_SECURITY</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Passkeys and sign-in</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Sign in with one touch, confirm admin changes with another, and sign out in one click. Operator sessions also end after a
              stretch with no activity.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to={hasRole(role, "operator") ? "/operator" : "/"}>Back to the console</Link>
          </Button>
        </div>
      </section>
      <section className="grid gap-6 px-4 pb-10 sm:px-8 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Your operator geometry</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4 text-sm sm:flex-row sm:items-start">
            <OperatorGeometryFigure geometry={geometry} size={180} />
            <div className="space-y-2 text-muted-foreground">
              {geometry ? (
                <p className="font-mono text-foreground">
                  {geometry.colourName} · {geometry.code}
                </p>
              ) : (
                <p className="text-foreground">Add a passkey to get your geometry.</p>
              )}
              <p>
                Your passkey gives you your own rotating tesseract: which vertices are marked, which edges are lit, its colour and spin.
                It opens at a new angle each time but is always yours, so you can tell at a glance whose session is open.
              </p>
              <p>
                It is a recognition cue, not a lock: it is drawn from your passkey's public key, which is not secret. The passkey touch
                is what signs you in.
              </p>
            </div>
          </CardContent>
        </Card>
        <PasskeysCard passkeys={passkeys} support={support} />
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void end(false)}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sign out
            </Button>
            <Button variant="ghost" onClick={() => void end(true)}>
              Sign out everywhere
            </Button>
          </CardContent>
        </Card>
        {role === "admin" && selfId && <RolesCard selfId={selfId} hasPasskey={(passkeys?.length ?? 0) > 0} />}
      </section>
    </main>
  );
};

export default AccountSecurity;
