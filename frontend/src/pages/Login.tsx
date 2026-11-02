import { useEffect, useState } from "react";
import { authClient, passkeyCredentialOf, passkeyTouch, signIn, useSession } from "@/lib/auth-client";
import { landingFor, roleOf } from "@/lib/roles";
import { registerDeviceWithLogin } from "@/lib/device-auth";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Fingerprint, Github, LogIn } from "lucide-react";
import { OperatorGeometryFigure } from "@/components/OperatorGeometryFigure";
import type { PasskeyRow } from "@/hooks/useOperatorGeometry";
import { geometryForPublicKey, type OperatorGeometry } from "@/lib/operator-geometry";
import { passkeySupport, type PasskeySupport } from "@/lib/passkey-support";
import { apiBase } from "@/lib/api/base-url";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

const SSO_FAILED_MESSAGE = "Single sign-on failed. Use your Lightbound Google Workspace account.";
const SIGNED_OUT_MESSAGE = { idle: "Signed out after a stretch with no activity.", user: "Signed out." } as const;
/** How long the operator's geometry shows after a passkey sign-in before the console opens. */
const WELCOME_MS = 900;

function browserPasskeySupport(rpId: string | null): PasskeySupport {
  return passkeySupport({
    rpId,
    location: window.location,
    secure: window.isSecureContext,
    webauthn: typeof window.PublicKeyCredential === "function",
  });
}

/** The geometry of the passkey that just signed in (public data; a recognition cue only). */
async function signedInGeometry(session: unknown): Promise<OperatorGeometry | null> {
  const { data } = await authClient.passkey.listUserPasskeys();
  const passkeys = (data ?? []) as PasskeyRow[];
  const used = passkeys.find((p) => p.credentialID === passkeyCredentialOf(session));
  return used ? geometryForPublicKey(used.publicKey) : null;
}

export default function Login() {
  useDocumentTitle("Sign in");

  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // A failed SSO round trip lands back here with ?error.
  const [error, setError] = useState(() =>
    new URLSearchParams(location.search).has("error") ? SSO_FAILED_MESSAGE : "",
  );
  const [sso, setSso] = useState<{ google: boolean; github: boolean; domain: string | null }>({
    google: false,
    github: false,
    domain: null,
  });
  // Passkeys: where the server allows them (/api/sso-options) and this page can use them.
  const [passkey, setPasskey] = useState<PasskeySupport | null>(null);
  const [touching, setTouching] = useState(false);
  const [welcome, setWelcome] = useState<OperatorGeometry | null>(null);
  const signedOut = location.state?.signedOut as keyof typeof SIGNED_OUT_MESSAGE | undefined;
  const anySso = sso.google || sso.github;
  const navigate = useNavigate();
  const { data: session } = useSession();

  // Deep links return to where they were going; otherwise land by role below.
  const hasFrom = Boolean(location.state?.from?.pathname);
  const fromPath = location.state?.from?.pathname || "/operator";
  const fromSearch = location.state?.from?.search || location.search || "";
  const from = safeRedirectPath(`${fromPath}${fromSearch}`, "/operator");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { data, error: err } = await signIn.email({ email, password });
    if (err) {
      setError(err.message || "Invalid credentials. Access denied.");
      return;
    }

    try {
      await registerDeviceWithLogin();
    } catch (deviceError) {
      console.warn("Device registration failed", deviceError);
    }

    // Operators run the console, staff start on Mesh & Network to get their
    // laptop onto the tailnet, users go back to the live visualisation.
    navigate(hasFrom ? from : landingFor(roleOf(data?.user)), { replace: true });
  };

  // One touch: the device checks the biometric, the server checks the signature.
  // The operator's geometry then resolves for a moment before the console opens.
  const handlePasskey = async () => {
    setError("");
    setTouching(true);
    const result = await passkeyTouch();
    if ("error" in result) {
      setTouching(false);
      setError(result.error);
      return;
    }
    const geometry = await signedInGeometry(result.session).catch(() => null);
    setWelcome(geometry);
    window.setTimeout(() => navigate(hasFrom ? from : landingFor(roleOf(result.user)), { replace: true }), geometry ? WELCOME_MS : 0);
  };

  // Returning from Google SSO (or already signed in): route by role. A passkey
  // sign-in in progress routes itself after showing the geometry.
  useEffect(() => {
    if (session?.user?.id && !touching) {
      navigate(hasFrom ? from : landingFor(roleOf(session.user)), { replace: true });
    }
  }, [session?.user, hasFrom, from, navigate, touching]);

  useEffect(() => {
    const base = apiBase();
    fetch(`${base}/api/sso-options`)
      .then((res) => (res.ok ? res.json() : null))
      .then((options) => {
        if (!options) return;
        setSso({ google: Boolean(options.google), github: Boolean(options.github), domain: options.domain ?? null });
        const support = browserPasskeySupport(typeof options.passkey?.rpId === "string" ? options.passkey.rpId : null);
        setPasskey(support.ok || support.reason !== "off" ? support : null);
      })
      .catch(() => undefined);
  }, []);

  const handleSso = async (provider: "google" | "github") => {
    setError("");
    const back = `${window.location.origin}/login`;
    await signIn.social({ provider, callbackURL: back, errorCallbackURL: back });
  };

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="hud-panel w-full max-w-sm p-8">
        <p className="brand-label">00_SIGN_IN · GAUSS AURORA</p>
        <h1 className="mt-2 text-2xl font-semibold leading-tight">Sign in to Gauss.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Accounts get the full heliophysics view; staff, operators and admins also get their team tools. The landing
          page stays open to everyone.
        </p>

        {signedOut && SIGNED_OUT_MESSAGE[signedOut] && !error && (
          <p role="status" className="mt-4 rounded-md border border-charcoal px-3 py-2 text-sm text-muted-foreground">
            {SIGNED_OUT_MESSAGE[signedOut]}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-caution/50 bg-caution/10 px-3 py-2 text-sm text-caution">
            {error}
          </p>
        )}

        {passkey && (
          <section aria-label="Passkey sign-in" className="mt-6 flex flex-col items-center">
            <OperatorGeometryFigure geometry={welcome} size={140} />
            {welcome ? (
              <p role="status" className="mt-2 font-mono text-xs text-muted-foreground">
                Welcome back · {welcome.code}
              </p>
            ) : passkey.ok ? (
              <>
                <button
                  type="button"
                  onClick={() => void handlePasskey()}
                  disabled={touching}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-charcoal bg-panel px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <Fingerprint className="h-4 w-4" aria-hidden="true" />
                  {touching ? "Waiting for your passkey…" : "Sign in with passkey"}
                </button>
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  One touch with Touch ID, Face ID or your fingerprint. It never leaves your device. No passkey yet? Sign in
                  below, then add one from the console header.
                </p>
              </>
            ) : (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {passkey.hint}{" "}
                {passkey.href && (
                  <a href={passkey.href} className="underline underline-offset-2 hover:text-foreground">
                    Open it there
                  </a>
                )}
              </p>
            )}
            <div className="my-5 flex w-full items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="h-px flex-1 bg-charcoal" />
              or
              <span className="h-px flex-1 bg-charcoal" />
            </div>
          </section>
        )}

        {anySso && (
          <>
            <div className={`${passkey ? "" : "mt-6 "}space-y-2`}>
              {sso.google && (
                <button
                  type="button"
                  onClick={() => void handleSso("google")}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-charcoal bg-panel px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Continue with Google Workspace
                </button>
              )}
              {sso.github && (
                <button
                  type="button"
                  onClick={() => void handleSso("github")}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-charcoal bg-panel px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Github className="h-4 w-4" aria-hidden="true" />
                  Continue with GitHub
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              New accounts: verified @{sso.domain} email
            </p>
            <div className="my-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="h-px flex-1 bg-charcoal" />
              or email
              <span className="h-px flex-1 bg-charcoal" />
            </div>
          </>
        )}

        <form onSubmit={handleLogin} className={`space-y-4 ${anySso || passkey ? "" : "mt-6"}`}>
          <div>
            <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-charcoal bg-black px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-signal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              required
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-charcoal bg-black px-3 py-2 text-sm text-foreground focus-visible:border-signal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              required
            />
          </div>
          <button
            type="submit"
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-signal px-3 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Sign in
          </button>
        </form>

        <Link
          to="/"
          className="mt-4 block py-2 text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back to the live landing page
        </Link>
      </div>
    </main>
  );
}
