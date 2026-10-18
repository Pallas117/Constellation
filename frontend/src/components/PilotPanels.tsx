import { Database, ShieldCheck } from "lucide-react";
import { PilotRequestDialog } from "@/components/PilotRequestDialog";
import type { PilotInterest } from "@/lib/api/commerce";
import { HudButton, HudCluster } from "@/components/hud/Hud";

const OFFERS: Array<{ interest: PilotInterest; icon: typeof Database; title: string; body: string; points: string[] }> = [
  {
    interest: "data-api",
    icon: Database,
    title: "Refined Data API",
    body: "The feeds behind this view, delivered to your systems with source and freshness metadata.",
    points: ["Keys per organisation, revocable", "Latest values and 24h history", "Usage reporting for your team"],
  },
  {
    interest: "connectivity",
    icon: ShieldCheck,
    title: "Assured Connectivity",
    body: "Keep a distributed operations team reachable on hotspots and public Wi-Fi, inside an approved-country policy.",
    points: ["Argo agent on each laptop", "Team status in the operator console", "Alerts when a network breaks"],
  },
];

/** "Available on pilot" offers, as a compact HUD cluster over the open visualisation. */
export function PilotPanels({ className }: { className?: string }) {
  return (
    <HudCluster label="Available on pilot" className={className}>
      <p className="px-2.5 pt-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        Available on pilot
      </p>
      <div className="flex flex-wrap gap-1.5 p-1.5">
        {OFFERS.map(({ interest, icon: Icon, title, body, points }) => (
          <PilotRequestDialog key={interest} interest={interest}>
            <HudButton
              label={`Request a pilot: ${title}`}
              side="top"
              hint={
                <>
                  <span className="block font-medium text-foreground">{title}</span>
                  <span className="mt-1 block text-muted-foreground">{body}</span>
                  <span className="mt-1 block text-muted-foreground">{points.join(" · ")}</span>
                  <span className="mt-1 block text-signal">Click to request a pilot</span>
                </>
              }
              className="text-foreground"
            >
              <Icon size={14} aria-hidden="true" />
              {title}
            </HudButton>
          </PilotRequestDialog>
        ))}
      </div>
    </HudCluster>
  );
}
