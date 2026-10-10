import { useEffect, useState } from "react";
import { signIn, useSession } from "@/lib/auth-client";
import { landingFor, roleOf } from "@/lib/roles";
import { registerDeviceWithLogin } from "@/lib/device-auth";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Shield, Fingerprint } from "lucide-react";
import { apiBase } from "@/lib/api/base-url";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sso, setSso] = useState<{ google: boolean; domain: string | null }>({ google: false, domain: null });
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
      .then((options) => options && setSso(options))
      .catch(() => undefined);
    if (new URLSearchParams(location.search).has("error")) {
      setError("Single sign-on failed. Use your Lightbound Google Workspace account.");
    }
  }, [location.search]);

  const handleGoogle = async () => {
    setError("");
    const back = `${window.location.origin}/login`;
    await signIn.social({ provider: "google", callbackURL: back, errorCallbackURL: back });
  };

  return (
    <div className="h-screen w-screen bg-black flex items-center justify-center font-mono overflow-hidden relative">
      <div className="absolute inset-0 scanline opacity-30 pointer-events-none" />
      <div className="w-full max-w-sm p-8 border border-primary/30 z-10 bg-black/80 hud-panel glow-border animate-fade-in-up">
        <div className="flex flex-col items-center mb-6">
          <Shield className="w-12 h-12 text-primary mb-2 animate-pulse" />
          <h1 className="text-primary text-xl tracking-[0.3em] uppercase phosphor-text text-center">
            Gauss
            <br />
            Auth Gateway
          </h1>
          <p className="mt-3 text-[10px] uppercase text-primary/50 tracking-[0.35em] text-center">
            Team sign-in for staff, operators and admins. The live visualisation is open to everyone.
          </p>
        </div>
        
        {error && <div className="text-amber-500 text-xs mb-4 text-center">{error}</div>}

        {sso.google && (
          <>
            <button
              type="button"
              onClick={() => void handleGoogle()}
              className="w-full border border-primary/60 text-primary hover:bg-primary/20 transition-all p-3 text-xs tracking-[0.2em] uppercase flex items-center justify-center gap-2"
            >
              Sign in with Google Workspace
            </button>
            <p className="mt-2 text-center text-[10px] text-primary/50">@{sso.domain} accounts</p>
            <div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-widest text-primary/40">
              <span className="h-px flex-1 bg-primary/20" />
              or email
              <span className="h-px flex-1 bg-primary/20" />
            </div>
          </>
        )}
        
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="text-primary/60 text-[10px] uppercase tracking-wider block mb-1">Email</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-black border border-primary/30 text-primary p-2 text-sm focus:outline-none focus:border-primary glow-border transition-colors"
              required
            />
          </div>
          <div>
            <label className="text-primary/60 text-[10px] uppercase tracking-wider block mb-1">Password</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-black border border-primary/30 text-primary p-2 text-sm focus:outline-none focus:border-primary glow-border transition-colors tracking-widest"
              required
            />
          </div>
          <button 
            type="submit"
            className="w-full bg-primary/10 border border-primary text-primary hover:bg-primary/20 hover:phosphor-text transition-all p-3 text-xs tracking-[0.2em] uppercase mt-4 flex items-center justify-center gap-2"
          >
            <Fingerprint className="w-4 h-4" />
            Authenticate
          </button>
        </form>
        <Link to="/" className="mt-6 block text-center text-[10px] uppercase tracking-widest text-primary/50 hover:text-primary">
          ← Live visualisation
        </Link>
      </div>
    </div>
  );
}
