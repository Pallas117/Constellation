/**
 * HUD primitives laid over the full-screen magnetosphere: small translucent
 * clusters at the edges, numbers first, explanations on hover or focus.
 * Touch devices get the same detail from the page's details drawer.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FeedMode } from "@/lib/physics/live-drivers";
import { cn } from "@/lib/utils";

export const fmt = (v: number | null | undefined, digits = 1) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
export const signed = (v: number | null | undefined, digits = 1) =>
  typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(digits)}` : "—";

export type Tone = "default" | "caution" | "risk" | "signal";
const TONE: Record<Tone, string> = {
  default: "text-foreground",
  caution: "text-caution",
  risk: "text-sun",
  signal: "text-signal",
};

/** Translucent edge cluster: readable over the scene without boxing it in. */
export function HudCluster({ className, children, label }: { className?: string; children: ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className={cn("pointer-events-auto rounded-md border border-charcoal/70 bg-black/55 backdrop-blur-md", className)}
    >
      {children}
    </section>
  );
}

const TOOLTIP_CLASS = "max-w-[280px] border-charcoal bg-panel/95 text-xs leading-relaxed text-foreground backdrop-blur";

/** One number with its label; hover or focus explains it. */
export function HudStat({
  label,
  value,
  unit,
  tone = "default",
  detail,
  size = "md",
  className,
}: {
  label: string;
  value: string;
  unit?: ReactNode;
  tone?: Tone;
  detail?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  const body = (
    <div
      tabIndex={detail ? 0 : undefined}
      className={cn(
        "rounded px-2 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        detail && "cursor-help hover:bg-white/5",
        className,
      )}
    >
      <dt className="font-mono text-[9px] font-bold uppercase leading-none tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 whitespace-nowrap font-mono font-semibold leading-none tabular-nums",
          size === "lg" ? "text-[28px]" : "text-[15px]",
          TONE[tone],
        )}
      >
        {value}
        {unit && value !== "—" && (
          <span className={cn("ml-1 font-normal text-muted-foreground", size === "lg" ? "text-xs" : "text-[10px]")}>
            {unit}
          </span>
        )}
      </dd>
    </div>
  );
  if (!detail) return body;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="top" className={TOOLTIP_CLASS}>
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}

type HudButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Accessible name and hover label. */
  label: string;
  /** Hover text when it should say more than the label. */
  hint?: ReactNode;
  active?: boolean;
  tone?: "default" | "sun";
  side?: "top" | "bottom" | "left" | "right";
};

/**
 * Compact HUD control. Forwards ref and props so it can be a Radix trigger
 * (`<PopoverTrigger asChild>`), with its own hover label.
 */
export const HudButton = forwardRef<HTMLButtonElement, HudButtonProps>(function HudButton(
  { label, hint, active, tone = "default", side = "bottom", className, children, ...props },
  ref,
) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={typeof children === "string" ? undefined : label}
          className={cn(
            "inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone === "sun" && active
              ? "border-sun/80 bg-sun/20 text-sun hover:bg-sun/30"
              : active
                ? "border-foreground/40 bg-white/10 text-foreground"
                : "border-charcoal/70 bg-black/55 text-muted-foreground hover:bg-white/10 hover:text-foreground",
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className={TOOLTIP_CLASS}>
        {hint ?? label}
      </TooltipContent>
    </Tooltip>
  );
});

const FEED_STYLES: Record<FeedMode, { label: string; className: string; dot: string; hint: string }> = {
  live: {
    label: "Live",
    className: "text-foreground",
    dot: "bg-signal animate-pulse",
    hint: "Solar wind measured at L1, about 1.5 million km sunward, roughly an hour before it reaches Earth.",
  },
  stale: {
    label: "Stale",
    className: "text-caution",
    dot: "bg-caution",
    hint: "The last L1 reading is old. The scene shows it, but conditions may have changed.",
  },
  none: {
    label: "No live data",
    className: "text-caution",
    dot: "bg-caution",
    hint: "No L1 reading: the scene shows reference geometry and the readouts show —.",
  },
  simulated: {
    label: "Simulated G4",
    className: "text-sun",
    dot: "bg-sun",
    hint: "A severe (G4) storm: Bz −20 nT, 15 nPa, Kp 8. Not a measurement.",
  },
};

export function FeedStatus({ mode, ageMin, className }: { mode: FeedMode; ageMin: number | null; className?: string }) {
  const style = FEED_STYLES[mode];
  const age = ageMin === null ? "" : ` · ${ageMin < 1 ? "<1" : Math.round(ageMin)} min`;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <div
          role="status"
          aria-live="polite"
          tabIndex={0}
          className={cn(
            "pointer-events-auto inline-flex h-7 cursor-help items-center gap-2 rounded-full border border-charcoal/70 bg-black/55 px-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] outline-none backdrop-blur-md focus-visible:ring-2 focus-visible:ring-ring",
            style.className,
            className,
          )}
        >
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
          {style.label}
          {age}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={TOOLTIP_CLASS}>
        {style.hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** Colour key for the scene, shown in a popover. */
export const SCENE_KEY: { label: string; swatch: string }[] = [
  { label: "Closed field line", swatch: "bg-gradient-to-r from-foreground to-earth" },
  { label: "Open to solar wind", swatch: "bg-gradient-to-r from-caution to-sun" },
  { label: "Magnetopause", swatch: "bg-earth" },
  { label: "Inner belt · protons", swatch: "bg-caution" },
  { label: "Outer belt · electrons, aurora", swatch: "bg-signal" },
];

export function SceneKey() {
  return (
    <ul className="space-y-1.5">
      {SCENE_KEY.map((i) => (
        <li key={i.label} className="flex items-center gap-2 text-xs text-foreground/90">
          <span aria-hidden="true" className={cn("h-1 w-5 rounded-full", i.swatch)} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
