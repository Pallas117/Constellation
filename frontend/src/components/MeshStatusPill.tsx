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
      className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
        attention
          ? "border-destructive/60 bg-destructive/15 text-destructive hover:bg-destructive/25"
          : "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20"
      }`}
    >
      {label}
    </Link>
  );
}
