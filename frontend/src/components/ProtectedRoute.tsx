import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/lib/auth-client";

export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
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

  return <>{children}</>;
};
