import { Link } from "react-router-dom";
import { SpaceWeatherVisualization } from '@/components/SpaceWeatherVisualization';
import { useOperatorNotifications } from "@/hooks/useOperatorNotifications";
import { MeshStatusPill } from "@/components/MeshStatusPill";
import { StatusBadge } from "@/components/brand/StatusBadge";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function OperatorDashboard() {
  useDocumentTitle("Operator console");

  useOperatorNotifications();

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-background text-foreground">
      <SpaceWeatherVisualization
        headerActions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/protection">Protection research</Link>
            </Button>
            <MeshStatusPill />
            <StatusBadge tone="neutral">Alerts on</StatusBadge>
          </>
        }
      />
    </main>
  );
}
