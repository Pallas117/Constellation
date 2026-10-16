import { useEffect, useState, type RefObject } from "react";

/**
 * True once the element comes within `rootMargin` of the viewport, and stays true.
 * Used to load below-the-fold sections only when someone scrolls toward them.
 */
export function useNearViewport(ref: RefObject<Element>, rootMargin = "300px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, near]);
  return near;
}
