import { Link } from "react-router-dom";
import { SpaceWeatherVisualization } from '@/components/SpaceWeatherVisualization';
import { useOperatorNotifications } from "@/hooks/useOperatorNotifications";
import { MeshStatusPill } from "@/components/MeshStatusPill";

export default function OperatorDashboard() {
  useOperatorNotifications();

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background">
      <SpaceWeatherVisualization />
      <div className="absolute top-4 right-4 z-50 flex items-center gap-3 rounded-full border border-primary/30 bg-black/70 px-4 py-2 text-sm text-primary shadow-md backdrop-blur-md">
        Operator alerts are enabled
      </div>
      <div className="absolute top-4 left-4 z-50 flex items-center gap-3">
        <Link
          to="/protection"
          className="rounded-full border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/20"
        >
          Protection Research
        </Link>
        <MeshStatusPill />
      </div>
    </main>
  );
}
