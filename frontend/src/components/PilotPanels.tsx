import { Database, ShieldCheck } from "lucide-react";
import { PilotRequestDialog } from "@/components/PilotRequestDialog";
import { Button } from "@/components/ui/button";
import type { PilotInterest } from "@/lib/api/commerce";

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

/** "Available on pilot" offers beside the open visualisation. */
export function PilotPanels() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
      {OFFERS.map(({ interest, icon: Icon, title, body, points }) => (
        <section key={interest} className="hud-panel flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {title}
            </h2>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">On pilot</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
          <ul className="space-y-1 text-sm text-foreground/85">
            {points.map((p) => (
              <li key={p} className="flex gap-2">
                <span aria-hidden="true" className="text-muted-foreground">·</span>
                {p}
              </li>
            ))}
          </ul>
          <PilotRequestDialog interest={interest}>
            <Button variant="outline" size="sm" className="mt-1 self-start">
              Request a pilot
            </Button>
          </PilotRequestDialog>
        </section>
      ))}
    </div>
  );
}
