import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useL1Structures } from "@/hooks/useL1Structures";
import { useNow } from "@/hooks/useNow";
import { structureItems, structuresSummary } from "@/lib/l1-structures-summary";

const CONFIDENCE_TONE = { high: "text-foreground", medium: "text-foreground", low: "text-muted-foreground" } as const;

/**
 * L1 structure candidates for the operator console (GAU-154): shocks, ICMEs, sustained southward
 * driving and a compressed magnetopause, found by heuristic detectors over the last 24 h (GAU-139).
 * Each is a candidate with a confidence, never a confirmed event.
 */
export function L1StructuresPill() {
  const { data } = useL1Structures();
  const now = useNow(60_000);
  if (!data) return null;

  if (data.structures === null) {
    return (
      <span className="inline-flex items-center rounded-full border border-charcoal px-2.5 py-1 text-xs text-muted-foreground">
        L1: no data yet
      </span>
    );
  }

  const items = structureItems(data.structures);
  const { label, attention } = structuresSummary(items, now);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            attention ? "border-caution/60 text-caution" : "border-charcoal text-foreground"
          }`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${attention ? "bg-caution" : "bg-muted-foreground"}`} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3 text-sm">
        <div>
          <p className="font-medium">L1 structure candidates, last 24 h</p>
          <p className="text-xs text-muted-foreground">
            {data.spacecraft}, {data.from.slice(11, 16)}–{data.to.slice(11, 16)} UTC
          </p>
        </div>
        {items.length === 0 ? (
          <p className="text-muted-foreground">No candidates in the last 24 h.</p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {items.map((item) => (
              <li key={`${item.title}-${item.at}`} className={CONFIDENCE_TONE[item.confidence]}>
                <p>
                  <span className="font-medium">{item.title}</span> · {item.at.slice(11, 16)} UTC · {item.confidence} confidence
                </p>
                <p className="text-xs text-muted-foreground">{item.detail}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-border/60 pt-2 text-xs text-muted-foreground">
          Candidates from heuristic detectors, not confirmed events: check them before acting. On a 2025 holdout,
          shocks were found 6 of 8 times, within 6 min of the arrival at Earth; ICMEs 4 of 9, with no false alarms.
        </p>
      </PopoverContent>
    </Popover>
  );
}
