import type { MeshDevice } from "@/hooks/useMesh";
import { Meter } from "@/components/brand/Readout";
import { StatusBadge } from "@/components/brand/StatusBadge";
import { MESH_POLL_INTERVAL_MS } from "@/lib/api/mesh";
import { ageLabel, batteryStatus, deviceRole, postureStatus, seenStatus, type CardReading } from "@/lib/mesh-device-status";
import { STAGE_HELP } from "@/lib/mesh-onboarding";
import type { ReadoutStatus } from "@/lib/readout-status";

const badgeTone = (s: ReadoutStatus) => (s.tone === "nominal" ? "neutral" : s.tone);

/** One reading inside a device card: label and status word on one line, then the number and its facts. */
function Reading({ label, reading, children, note }: { label: string; reading: CardReading; children?: React.ReactNode; note?: string }) {
  return (
    <div className="border-t border-charcoal pt-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 className="font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</h4>
        <StatusBadge tone={badgeTone(reading.status)}>{reading.status.word}</StatusBadge>
      </div>
      <div className="mt-1">
        <p className="flex items-baseline gap-1.5 font-mono tabular-nums">
          <span className="text-2xl font-medium leading-8 text-foreground">{reading.value}</span>
          {reading.unit && <span className="text-sm text-muted-foreground">{reading.unit}</span>}
        </p>
        {children}
        {reading.detail.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-sm leading-snug text-muted-foreground">
            {reading.detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {note && <p className="mt-2 text-xs leading-snug text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

function DeviceCard({ device, now, showOwner }: { device: MeshDevice; now: number; showOwner: boolean }) {
  const seen = seenStatus(device, now);
  const battery = batteryStatus(device.last?.battery);
  const posture = postureStatus(device.last?.posture);
  // A stale device's numbers are its last report, not its present state: say so on each reading.
  const lastKnown = seen.stage === "stale" || (seen.stage === "rejected" && Boolean(device.last));
  const suffix = lastKnown ? " · last known" : "";

  return (
    <li className="hud-panel min-w-0 p-4" data-testid={`device-card-${device.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h3 className="min-w-0 break-all font-mono text-base font-medium text-foreground">{device.name}</h3>
        <StatusBadge tone={badgeTone(seen.status)}>{seen.status.word}</StatusBadge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{deviceRole(device)}</p>
      {showOwner && device.owner && <p className="mt-0.5 break-all text-xs text-muted-foreground">Owner {device.owner}</p>}
      <p className="mt-2 text-sm text-foreground">
        Last report{" "}
        {device.last ? (
          <time dateTime={device.last.receivedAt} className="font-mono tabular-nums">
            {seen.age}
          </time>
        ) : (
          <span className="font-mono">—</span>
        )}
      </p>
      {seen.stage !== "reporting" && <p className="mt-1 text-xs leading-snug text-muted-foreground">{STAGE_HELP[seen.stage]}</p>}

      <div className="mt-3 space-y-3">
        <Reading label={`Battery${device.last?.battery ? suffix : ""}`} reading={battery}>
          {battery.fraction !== null && <Meter fraction={battery.fraction} tone={battery.status.tone} label={`${device.name} battery level`} />}
        </Reading>
        <Reading
          label={`Security${device.last?.posture ? suffix : ""}`}
          reading={posture}
          note={device.last?.posture ? `Checked ${ageLabel(device.last.posture.at, now)} · details: argo posture on the device` : undefined}
        />
      </div>
    </li>
  );
}

/**
 * Power and security at a glance, one card per device, for a phone. It draws only what the
 * device list the page already polls carries (no route of its own); the table below has the rest.
 */
export function DeviceStatusCards({
  devices,
  now,
  showOwner,
  feedFailing,
}: {
  devices: MeshDevice[];
  now: number;
  showOwner: boolean;
  /** The device list could not be refreshed: the cards show the last list received. */
  feedFailing: boolean;
}) {
  return (
    <section aria-labelledby="device-status-heading" className="px-4 pb-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <p className="brand-label">01_DEVICE_STATUS</p>
          <h2 id="device-status-heading" className="mt-1 text-xl font-semibold tracking-tight">
            Power and security
          </h2>
        </div>
        {feedFailing ? <StatusBadge tone="caution">Not updating</StatusBadge> : <StatusBadge tone="signal">Live</StatusBadge>}
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        From each device's last Argo report; this list refreshes every {MESH_POLL_INTERVAL_MS / 1000} s. A dash means the report did not carry
        that reading.
      </p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {devices.map((d) => (
          <DeviceCard key={d.name} device={d} now={now} showOwner={showOwner} />
        ))}
      </ul>
    </section>
  );
}
