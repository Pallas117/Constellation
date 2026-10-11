import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import { hasRole, roleOf, type Role } from "@/lib/roles";

export const ProtectedRoute = ({ children, minRole = "user" }: { children: React.ReactNode; minRole?: Role }) => {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  // better-auth's useSession data is { session, user }: the user sits beside
  // the session, not inside it, so checking session.session.user always failed.
  const user = session?.user;

  if (isPending) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center phosphor-text font-mono text-sm tracking-widest uppercase">
        Establishing secure uplink...
      </div>
    );
  }

  if (!user?.id) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Signed in but not allowed here: back to the public visualisation, never a
  // login loop. The API enforces the same rule; this only avoids dead pages.
  if (!hasRole(roleOf(user), minRole)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};
