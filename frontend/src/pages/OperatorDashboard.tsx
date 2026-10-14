import { Link } from "react-router-dom";
import { SpaceWeatherVisualization } from '@/components/SpaceWeatherVisualization';
import { useOperatorNotifications } from "@/hooks/useOperatorNotifications";
import { MeshStatusPill } from "@/components/MeshStatusPill";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function OperatorDashboard() {
  useDocumentTitle("Operator console");

  useOperatorNotifications();

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background">
      <SpaceWeatherVisualization />
      {/* Top centre, clear of the title (left) and the sensor readout (right). */}
      <div className="pointer-events-none absolute inset-x-0 top-6 z-50 flex justify-center px-4">
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
          <span
            role="status"
            className="inline-flex min-h-9 items-center gap-2 rounded-full border border-border bg-panel/85 px-3 text-xs text-muted-foreground backdrop-blur-md"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden="true" />
            Storm alerts on
          </span>
          <Link
            to="/protection"
            className="inline-flex min-h-9 items-center rounded-full border border-border bg-panel/85 px-4 text-sm text-foreground backdrop-blur-md transition-colors hover:border-foreground/40"
          >
            Protection
          </Link>
          <MeshStatusPill />
        </div>
      </div>
    </main>
  );
}
