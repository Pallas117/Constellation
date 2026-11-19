import { Link } from "react-router-dom";
import { useMesh, WARNING_CLASSES } from "@/hooks/useMesh";
import { useNow } from "@/hooks/useNow";
import { PillPlaceholder } from "@/components/ui/pill-placeholder";

const STALE_MS = 15 * 60 * 1000;

/** Live team-network summary for the operator console; hidden from viewers. */
export function MeshStatusPill() {
  const { devices, canSeeTeam, loading } = useMesh();
  const now = useNow(60_000);
  // Loading: hold the pill's place so the console header doesn't reflow when the list arrives.
  if (loading) return <PillPlaceholder label="Mesh: checking…" className="min-w-[11.5rem]" />;
  if (!canSeeTeam || !devices) return null;

  const healthy = devices.filter(
    (d) => d.last && now - Date.parse(d.last.receivedAt) <= STALE_MS && (d.last.class === "OK" || WARNING_CLASSES.has(d.last.class)),
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
