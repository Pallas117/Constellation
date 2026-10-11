import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { registerDeviceWithLogin } from "@/lib/device-auth";
import { useNavigate, useLocation } from "react-router-dom";
import { Shield, Fingerprint } from "lucide-react";
import { safeRedirectPath } from "@/lib/safe-redirect";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const location = useLocation();

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

    navigate(from, { replace: true });
  };

  return (
    <div className="h-screen w-screen bg-black flex items-center justify-center font-mono overflow-hidden relative">
      <div className="absolute inset-0 scanline opacity-30 pointer-events-none" />
      <div className="w-full max-w-sm p-8 border border-primary/30 z-10 bg-black/80 hud-panel glow-border animate-fade-in-up">
        <div className="flex flex-col items-center mb-6">
          <Shield className="w-12 h-12 text-primary mb-2 animate-pulse" />
          <h1 className="text-primary text-xl tracking-[0.3em] uppercase phosphor-text text-center">
            Gauss Operator
            <br />
            Auth Gateway
          </h1>
          <p className="mt-3 text-[10px] uppercase text-primary/50 tracking-[0.35em] text-center">
            Operator access only — regular members should use the Member Hub for open contributions and visualization.
          </p>
        </div>
        
        {error && <div className="text-amber-500 text-xs mb-4 text-center">{error}</div>}
        
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="text-primary/60 text-[10px] uppercase tracking-wider block mb-1">Operator ID (Email)</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-black border border-primary/30 text-primary p-2 text-sm focus:outline-none focus:border-primary glow-border transition-colors"
              required
            />
          </div>
          <div>
            <label className="text-primary/60 text-[10px] uppercase tracking-wider block mb-1">Passkey</label>
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
      </div>
    </div>
  );
}
