import { useMemo } from "react";
import { motion } from "framer-motion";
import { encode } from "uqr";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * A QR code drawn as one SVG path (uqr: zero dependencies, encoded in the browser, nothing
 * sent anywhere). Dark modules on white, as phone cameras expect; it opens from the centre.
 */
export function QrCode({ value, size = 208, label }: { value: string; size?: number; label: string }) {
  const still = usePrefersReducedMotion();
  const { d, n } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let path = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, n: qr.size };
  }, [value]);

  return (
    <motion.svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
      initial={still ? false : { clipPath: "circle(0% at 50% 50%)", opacity: 0.4 }}
      animate={{ clipPath: "circle(75% at 50% 50%)", opacity: 1 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#0b0d12" />
    </motion.svg>
  );
}
