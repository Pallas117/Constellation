import { Link } from "react-router-dom";
import { useMesh } from "@/hooks/useMesh";

const STALE_MS = 15 * 60 * 1000;

/** Live team-network summary for the operator console; hidden from viewers. */
export function MeshStatusPill() {
  const { devices, canSeeTeam } = useMesh();
  if (!canSeeTeam || !devices) return null;

  const now = Date.now();
  const healthy = devices.filter(
    (d) => d.last && now - Date.parse(d.last.receivedAt) <= STALE_MS && (d.last.class === "OK" || d.last.class === "WPAD_RISK"),
  ).length;
  const attention = devices.length - healthy;
  const label =
    devices.length === 0
      ? "Mesh: no devices yet"
      : `Mesh: ${healthy} OK${attention ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}`;

  return (
    <Link
      to="/mesh"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        attention ? "border-caution/60 text-caution" : "border-charcoal text-foreground"
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${attention ? "bg-caution" : "bg-muted-foreground"}`} />
      {label}
    </Link>
  );
}
