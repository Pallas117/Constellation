import { useEffect, useState } from 'react';
import { fetchPipelineLatency } from '@/lib/api/heliophysics-proxy';
import { describePipeline, type PipelineView } from '@/lib/pipelineLatency';
import type { PipelineLatencySnapshot } from '@/lib/types/space-weather';

const POLL_MS = 5000; // matches the backend ingest tick

/** Polls the backend pipeline timers; the view keeps ageing between polls. */
export const usePipelineLatency = (): PipelineView => {
  const [snapshot, setSnapshot] = useState<{ data: PipelineLatencySnapshot; fetchedAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchPipelineLatency();
        if (!cancelled) setSnapshot({ data, fetchedAt: Date.now() });
      } catch {
        // Keep the last snapshot; describePipeline ages it into STALLED if polling keeps failing.
      }
    };
    void poll();
    const pollTimer = setInterval(poll, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(clock);
    };
  }, []);

  return describePipeline(snapshot?.data ?? null, snapshot ? now - snapshot.fetchedAt : 0);
};
