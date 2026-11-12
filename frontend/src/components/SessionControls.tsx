import { useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { OperatorGeometryFigure } from "@/components/OperatorGeometryFigure";
import { Button } from "@/components/ui/button";
import { useIdleSignOut } from "@/hooks/useIdleSignOut";
import { useOperatorGeometry } from "@/hooks/useOperatorGeometry";
import { signOut, useSession } from "@/lib/auth-client";
import { describeGeometry } from "@/lib/operator-geometry";
import { hasRole, roleOf } from "@/lib/roles";

export type SignedOutReason = "idle" | "user";

/**
 * Header controls for a signed-in session (GAU-235): the operator's geometry
 * (links to passkeys and account security) and one-click sign-out. Operator
 * and admin sessions also sign out after a stretch of no input.
 */
export function SessionControls() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const { geometry } = useOperatorGeometry();
  const signedIn = Boolean(session?.user?.id);

  const end = useCallback(
    async (reason: SignedOutReason) => {
      // The server deletes the session; the cookie goes with it.
      await signOut().catch(() => undefined);
      navigate("/login", { replace: true, state: { signedOut: reason } });
    },
    [navigate],
  );
  useIdleSignOut(signedIn && hasRole(roleOf(session?.user), "operator"), () => void end("idle"));

  if (!signedIn) return null;
  return (
    <div className="flex items-center gap-1">
      <Link
        to="/account/security"
        title={geometry ? `${describeGeometry(geometry)}. Passkeys and sign-in` : "Add a passkey for one-touch sign-in"}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-charcoal transition-colors hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <OperatorGeometryFigure geometry={geometry} size={30} variant="mark" />
        <span className="sr-only">Passkeys and account security</span>
      </Link>
      <Button variant="ghost" size="sm" onClick={() => void end("user")}>
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );
}
