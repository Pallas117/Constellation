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
      className={`inline-flex min-h-9 items-center rounded-full border px-4 text-sm backdrop-blur-md transition-colors ${
        attention
          ? "border-sun/60 bg-sun/15 text-sun hover:bg-sun/25"
          : "border-border bg-panel/85 text-foreground hover:border-foreground/40"
      }`}
    >
      {label}
    </Link>
  );
}
