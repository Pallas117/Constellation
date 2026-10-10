import { Database, ShieldCheck } from "lucide-react";
import { PilotRequestDialog } from "@/components/PilotRequestDialog";
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

/** "Available on pilot" offers under the open visualisation. */
export function PilotPanels() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-5xl mx-auto pointer-events-auto">
      {OFFERS.map(({ interest, icon: Icon, title, body, points }) => (
        <div key={interest} className="bg-white/5 border border-white/10 rounded-2xl p-5 backdrop-blur-xl flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium tracking-wide uppercase text-white/80">
              <Icon className="w-4 h-4 text-sky-300" />
              {title}
            </div>
            <span className="rounded-full border border-white/20 px-2.5 py-0.5 text-[10px] uppercase tracking-widest text-white/60">
              Available on pilot
            </span>
          </div>
          <p className="text-sm text-white/60 leading-relaxed">{body}</p>
          <ul className="text-xs text-white/50 space-y-1">
            {points.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
          <PilotRequestDialog interest={interest}>
            <button className="self-start mt-1 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 px-4 py-2 text-sm font-medium transition-colors">
              Request a pilot
            </button>
          </PilotRequestDialog>
        </div>
      ))}
    </div>
  );
}
