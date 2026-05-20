import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/lib/auth-client";

export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center phosphor-text font-mono text-sm tracking-widest uppercase">
        Establishing secure uplink...
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};
