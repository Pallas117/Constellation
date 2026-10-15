import { useSceneHover, type HoverTarget } from "@/components/scene/scene-hover";
import type { MagnetosphereModelInfo } from "@/components/scene/Magnetosphere";
import { fmt, signed } from "./Hud";

/** Geostationary orbit radius, Re. */
export const GEO_RE = 6.6;

interface Described {
  title: string;
  value: string;
  body: string;
}

/** What the HUD says about the object under the pointer, from the model the scene drew. */
export function describeTarget(
  target: HoverTarget,
  model: MagnetosphereModelInfo | null,
  live: boolean,
  r0Range: number[] | null = null,
): Described {
  const reference = live ? null : "Reference geometry · no live reading";
  switch (target) {
    case "earth":
      return {
        title: "Earth · dipole",
        value: model ? `Dipole tilt ${signed((model.tilt * 180) / Math.PI)}°` : "—",
        body: "The magnetic axis leans off the spin axis, so its angle to the Sun (positive: north pole sunward) swings through the day and the year and warps everything around it.",
      };
    case "magnetopause":
      return {
        title: "Magnetopause",
        value:
          reference ??
          (model ? `${fmt(model.r0)} RE standoff · ${model.r0 < GEO_RE ? "inside" : "outside"} GEO` : "—"),
        body: r0Range
          ? `Where Earth's field holds off the solar wind. L1 spacecraft disagree on density, so it is ${fmt(r0Range[0])}–${fmt(r0Range[1])} RE depending on which is right.`
          : "Where Earth's field holds off the solar wind. Higher pressure and southward Bz push it inward.",
      };
    case "bowShock":
      return {
        title: "Bow shock",
        value: reference ?? (model ? `${fmt(model.bowShock)} RE at the nose` : "—"),
        body: "The supersonic solar wind slows abruptly here, upstream of the magnetopause.",
      };
    case "currentSheet":
      return {
        title: "Tail current sheet",
        value:
          reference ??
          (model?.openFraction != null ? `${Math.round(model.openFraction * 100)}% of field lines open` : "—"),
        body: "The night-side field is stretched into a long tail. Reconnection here drives substorms and the aurora.",
      };
  }
}

/** Cursor-following readout for whatever the pointer is over in the scene. */
export function SceneHoverTip({
  model,
  live,
  r0Range = null,
}: {
  model: MagnetosphereModelInfo | null;
  live: boolean;
  r0Range?: number[] | null;
}) {
  const hover = useSceneHover();
  if (!hover) return null;
  const d = describeTarget(hover.target, model, live, r0Range);
  // Keep it on screen: flip to the cursor's other side near the right or bottom edge.
  const flipX = hover.x > window.innerWidth - 300;
  const flipY = hover.y > window.innerHeight - 150;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-30 w-[260px] rounded-md border border-charcoal bg-panel/90 px-3 py-2 backdrop-blur-md"
      style={{
        left: hover.x + (flipX ? -16 : 16),
        top: hover.y + (flipY ? -16 : 16),
        transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
      }}
    >
      <p className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-signal">{d.title}</p>
      <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{d.value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{d.body}</p>
    </div>
  );
}
