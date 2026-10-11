import { useEffect, useState } from "react";
import { signIn, useSession } from "@/lib/auth-client";
import { landingFor, roleOf } from "@/lib/roles";
import { registerDeviceWithLogin } from "@/lib/device-auth";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Github, LogIn } from "lucide-react";
import { apiBase } from "@/lib/api/base-url";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sso, setSso] = useState<{ google: boolean; github: boolean; domain: string | null }>({
    google: false,
    github: false,
    domain: null,
  });
  const anySso = sso.google || sso.github;
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session } = useSession();

  // Deep links return to where they were going; otherwise land by role below.
  const hasFrom = Boolean(location.state?.from?.pathname);
  const fromPath = location.state?.from?.pathname || "/operator";
  const fromSearch = location.state?.from?.search || location.search || "";
  const from = `${fromPath}${fromSearch}`;

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

  // Returning from Google SSO (or already signed in): route by role.
  useEffect(() => {
    if (session?.user?.id) {
      navigate(hasFrom ? from : landingFor(roleOf(session.user)), { replace: true });
    }
  }, [session?.user, hasFrom, from, navigate]);

  useEffect(() => {
    const base = apiBase();
    fetch(`${base}/api/sso-options`)
      .then((res) => (res.ok ? res.json() : null))
      .then((options) => options && setSso({ google: Boolean(options.google), github: Boolean(options.github), domain: options.domain ?? null }))
      .catch(() => undefined);
    if (new URLSearchParams(location.search).has("error")) {
      setError("Single sign-on failed. Use your Lightbound Google Workspace account.");
    }
  }, [location.search]);

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

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-caution/50 bg-caution/10 px-3 py-2 text-sm text-caution">
            {error}
          </p>
        )}

        {anySso && (
          <>
            <div className="mt-6 space-y-2">
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

        <form onSubmit={handleLogin} className={`space-y-4 ${anySso ? "" : "mt-6"}`}>
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
          className="mt-6 block text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back to the live landing page
        </Link>
      </div>
    </main>
  );
}
