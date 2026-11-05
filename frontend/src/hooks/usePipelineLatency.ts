import { useEffect, useState } from 'react';
import { usePolledFeed } from '@/hooks/usePolledFeed';
import { describePipeline, type PipelineView } from '@/lib/pipelineLatency';
import type { PipelineLatencySnapshot } from '@/lib/types/space-weather';

const POLL_MS = 5000; // matches the backend ingest tick

/**
 * Polls the backend pipeline timers; the view keeps ageing between polls. On the shared poller, so a 401/403 stops it:
 * CyberTiger blocks an address after 8 auth failures in 5 min, and a 5 s poll on an expired session would hit that in
 * under a minute. Failures back off and keep the last snapshot, which describePipeline ages into STALLED.
 */
export const usePipelineLatency = (): PipelineView => {
  const { data: snapshot } = usePolledFeed<{ data: PipelineLatencySnapshot; fetchedAt: number }>({
    path: '/api/system/pipeline',
    intervalMs: POLL_MS,
    maxBackoffMs: 60_000,
    parse: (json) => ({ data: json as PipelineLatencySnapshot, fetchedAt: Date.now() }),
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  return describePipeline(snapshot?.data ?? null, snapshot ? now - snapshot.fetchedAt : 0);
};
