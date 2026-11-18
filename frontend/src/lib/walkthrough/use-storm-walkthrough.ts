import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildStops,
  sampleIndexAt,
  stopIndexAt,
  teachingOrbit,
  type WalkthroughData,
  type WalkthroughSample,
  type WalkthroughStop,
} from './storm-walkthrough';

/** Replay seconds per real second: 5 minutes of storm every second. */
export const PLAY_SPEED = 300;

export interface StormWalkthrough {
  data: WalkthroughData;
  stops: WalkthroughStop[];
  ms: number;
  sample: WalkthroughSample;
  stopIdx: number;
  stop: WalkthroughStop;
  playing: boolean;
  /** Changes whenever the camera should move to the current stop. */
  cameraRequest: number;
  orbit: ReturnType<typeof teachingOrbit>;
  play: () => void;
  pause: () => void;
  goToStop: (i: number) => void;
  scrub: (ms: number) => void;
}

/**
 * Walkthrough clock. Playing runs the replay forward and pauses at each stop, so staff read it
 * before continuing; the slider scrubs freely. Nothing here touches the live feed.
 */
export function useStormWalkthrough(data: WalkthroughData | null): StormWalkthrough | null {
  const stops = useMemo(() => (data ? buildStops(data) : null), [data]);
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [cameraRequest, setCameraRequest] = useState(0);
  const msRef = useRef(0);

  // Start at the first stop whenever a new storm loads. The state is reset while rendering (React's
  // pattern for "reset when an input changes"), so there is no extra render from an effect; the ref
  // the clock reads is set in an effect, because refs are not written during render.
  const [loaded, setLoaded] = useState<WalkthroughStop[] | null>(null);
  if (stops && stops !== loaded) {
    setLoaded(stops);
    setMs(stops[0].atMs);
    setPlaying(false);
    setCameraRequest((n) => n + 1);
  }
  useEffect(() => {
    if (stops) msRef.current = stops[0].atMs;
  }, [stops]);

  useEffect(() => {
    if (!playing || !data || !stops) return;
    const end = Date.parse(data.end);
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const next = msRef.current + (now - last) * PLAY_SPEED;
      last = now;
      const from = stopIndexAt(stops, msRef.current);
      const upcoming = stops[from + 1];
      if (upcoming && upcoming.atMs <= next) {
        msRef.current = upcoming.atMs;
        setMs(upcoming.atMs);
        setCameraRequest((n) => n + 1);
        setPlaying(false);
        return;
      }
      if (next >= end) {
        msRef.current = end;
        setMs(end);
        setPlaying(false);
        return;
      }
      msRef.current = next;
      setMs(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, data, stops]);

  const play = useCallback(() => {
    if (!data || !stops) return;
    // From the end, start over.
    if (msRef.current >= Date.parse(data.end)) {
      msRef.current = stops[0].atMs;
      setMs(stops[0].atMs);
      setCameraRequest((n) => n + 1);
    }
    setPlaying(true);
  }, [data, stops]);
  const pause = useCallback(() => setPlaying(false), []);
  const goToStop = useCallback(
    (i: number) => {
      if (!stops) return;
      const stop = stops[Math.max(0, Math.min(stops.length - 1, i))];
      msRef.current = stop.atMs;
      setMs(stop.atMs);
      setPlaying(false);
      setCameraRequest((n) => n + 1);
    },
    [stops],
  );
  const scrub = useCallback((value: number) => {
    msRef.current = value;
    setMs(value);
    setPlaying(false);
  }, []);

  if (!data || !stops) return null;
  const stopIdx = stopIndexAt(stops, ms);
  return {
    data,
    stops,
    ms,
    sample: data.samples[sampleIndexAt(data, ms)],
    stopIdx,
    stop: stops[stopIdx],
    playing,
    cameraRequest,
    orbit: teachingOrbit(data),
    play,
    pause,
    goToStop,
    scrub,
  };
}
