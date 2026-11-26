import { Link } from "react-router-dom";
import { SpaceWeatherVisualization } from '@/components/SpaceWeatherVisualization';
import { useOperatorNotifications } from "@/hooks/useOperatorNotifications";
import { L1StructuresPill } from "@/components/L1StructuresPill";
import { MeshStatusPill } from "@/components/MeshStatusPill";
import { StatusBadge } from "@/components/brand/StatusBadge";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useSession } from "@/lib/auth-client";
import { hasRole, roleOf } from "@/lib/roles";

const LINKS = [
  ["/", "Live view"],
  ["/heliophysics", "Field model"],
  ["/protection", "Protection"],
  ["/operator/evidence", "Evidence"],
  ["/account/api", "API keys"],
] as const;
// Shown to admins only: the page and its route (GET /api/admin/funding) refuse every other role.
const ADMIN_LINKS = [["/operator/funding", "Funding"]] as const;

export default function OperatorDashboard() {
  useDocumentTitle("Operator console");

  useOperatorNotifications();
  const { data: session } = useSession();
  const links = session?.user && hasRole(roleOf(session.user), "admin") ? [...LINKS, ...ADMIN_LINKS] : LINKS;

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-background text-foreground">
      <SpaceWeatherVisualization
        headerActions={
          <>
            {/* Every page an operator can open, so the console is never a dead end. */}
            <nav aria-label="Console" className="flex flex-wrap items-center gap-1">
              {links.map(([to, label]) => (
                <Button key={to} asChild variant="ghost" size="sm">
                  <Link to={to}>{label}</Link>
                </Button>
              ))}
            </nav>
            <L1StructuresPill />
            <MeshStatusPill />
            <StatusBadge tone="neutral">Alerts on</StatusBadge>
          </>
        }
      />
    </main>
  );
}
