import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StormWalkthrough } from "@/lib/walkthrough/use-storm-walkthrough";

const utc = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

/**
 * Staff training (GAU-229): the pilot story on a real replayed storm. The scene and readouts behind
 * it show the replay, labelled as such; the text is built from the same numbers.
 */
export function StormWalkthroughPanel({ w, onExit }: { w: StormWalkthrough; onExit: () => void }) {
  const { data, stops, stopIdx, stop, sample, ms, playing } = w;
  const start = Date.parse(data.start);
  const end = Date.parse(data.end);
  const last = stopIdx >= stops.length - 1 && ms >= end;
  return (
    <section
      aria-label="Storm walkthrough"
      className="pointer-events-auto hud-panel w-[min(22rem,calc(100vw-1.5rem))] p-3 backdrop-blur-md"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="brand-label text-[10px]">
          {String(stopIdx + 1).padStart(2, "0")}_{stop.id.toUpperCase()} · {stopIdx + 1}/{stops.length}
        </p>
        <button
          type="button"
          onClick={onExit}
          aria-label="Leave the walkthrough"
          className="-m-1 inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <h2 className="mt-1 text-base font-semibold leading-snug">{stop.title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground" aria-live="polite">
        {stop.body}
      </p>

      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-caution">
        Replay · {utc(ms)} UT · {sample.S} {sample.G} {sample.R}
      </p>

      <label className="mt-2 block">
        <span className="sr-only">Replay time</span>
        <input
          type="range"
          min={start}
          max={end}
          step={data.stepMin * 60_000}
          value={ms}
          onChange={(e) => w.scrub(Number(e.target.value))}
          className="h-6 w-full accent-[hsl(var(--foreground))]"
        />
      </label>

      <div className="mt-1 flex items-center justify-between gap-2">
        <ol className="flex items-center gap-1" aria-label="Stops">
          {stops.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => w.goToStop(i)}
                aria-label={`Stop ${i + 1}: ${s.title}`}
                aria-current={i === stopIdx ? "step" : undefined}
                className="inline-flex h-6 w-4 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={cn("h-1.5 rounded-full transition-all", i === stopIdx ? "w-4 bg-foreground" : "w-1.5 bg-charcoal")} />
              </button>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => w.goToStop(stopIdx - 1)}
            disabled={stopIdx === 0}
            aria-label="Previous stop"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-charcoal text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={playing ? w.pause : w.play}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-charcoal px-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {playing ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
            {playing ? "Pause" : last ? "Again" : "Play"}
          </button>
          <button
            type="button"
            onClick={() => w.goToStop(stopIdx + 1)}
            disabled={stopIdx >= stops.length - 1}
            aria-label="Next stop"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-charcoal text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
        {data.title}. Archived NOAA data replayed through the live Gauss pipeline; not live and not a forecast.
        Satellite and orbit are an illustration.
      </p>
    </section>
  );
}
