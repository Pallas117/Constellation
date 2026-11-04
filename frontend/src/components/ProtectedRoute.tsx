import { Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useOperatorPattern, refreshOperatorPattern } from "@/hooks/useOperatorPattern";
import { useSession } from "@/lib/auth-client";
import { hasRole, roleOf, type Role } from "@/lib/roles";

function Waiting({ text }: { text: string }) {
  return (
    <div role="status" className="flex h-dvh w-screen items-center justify-center gap-2 bg-background font-mono text-sm text-muted-foreground">
      <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
      {text}
    </div>
  );
}

/**
 * `pattern`: operator and admin pages also need the operator pattern (GAU-235): set up first
 * (/setup), then drawn in this session (/pattern). The API answers 428 without it; this only
 * sends people to the right page instead of a console that can't load. The setup and pattern
 * pages themselves pass pattern={false}.
 */
export const ProtectedRoute = ({ children, minRole = "user", pattern = true }: { children: React.ReactNode; minRole?: Role; pattern?: boolean }) => {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  // better-auth's useSession data is { session, user }: the user sits beside
  // the session, not inside it, so checking session.session.user always failed.
  const user = session?.user;
  const gated = pattern && hasRole(minRole, "operator") && Boolean(user?.id) && hasRole(roleOf(user), minRole);
  const { status, error, loading } = useOperatorPattern(gated ? user?.id : null);

  if (isPending) return <Waiting text="Checking your session…" />;

  if (!user?.id) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Signed in but not allowed here: back to the public visualisation, never a
  // login loop. The API enforces the same rule; this only avoids dead pages.
  if (!hasRole(roleOf(user), minRole)) {
    return <Navigate to="/" replace />;
  }

  if (gated) {
    if (loading) return <Waiting text="Checking your pattern…" />;
    if (error || !status) {
      return (
        <div role="alert" className="flex h-dvh w-screen flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
          <p>Couldn't check your operator pattern{error ? ` (${error})` : ""}.</p>
          <Button size="sm" variant="outline" onClick={refreshOperatorPattern}>
            Try again
          </Button>
        </div>
      );
    }
    if (status.required && !status.set) return <Navigate to="/setup" state={{ from: location }} replace />;
    if (status.device === "mismatch") {
      return (
        <div role="alert" className="flex h-dvh w-screen flex-col items-center justify-center gap-2 bg-background px-6 text-center text-sm text-muted-foreground">
          <p className="text-foreground">This device isn't signed in to Tailscale as you.</p>
          <p>The operator console only opens on your own devices. Sign in to Tailscale with your account here, or use one of yours.</p>
        </div>
      );
    }
    if (status.required && (!status.passkeySession || !status.verified)) return <Navigate to="/pattern" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};
