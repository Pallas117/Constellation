import { useEffect, useState } from 'react';
import { Database, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/brand/StatusBadge';
import { apiBase } from "@/lib/api/base-url";

type RagStatus = {
  ok: boolean;
  chunkCount?: number;
  error?: string;
};

type RagQueryResponse = {
  ok: boolean;
  answer?: string;
  sources?: { filePath: string; score: number }[];
  error?: string;
};

const RAG_BASE =
  import.meta.env.VITE_GAUSS_RAG_URL || apiBase();

const DEFAULT_INDEX_DIR =
  import.meta.env.VITE_GAUSS_RAG_INDEX_DIR || '';

const MOCK_AI_TEXT = `[URGENT] SYSTEM ANOMALY DETECTED

Context: LSTM Time-Series forecasting on edge node has detected a massive deviation in solar wind velocity (currently exceeding 850 km/s) and a persistent southward IMF (Bz = -18nT). [Trace: DSCOVR Real-Time Solar Wind Data] 

Analysis: We are entering the initial phase of a G4-class severe geomagnetic storm. 

Immediate Orbital Impacts (Based on 3D Overlay Mapping):
- LEO (400km): Proton flux has spiked to 50,000 pfu. Warning: High risk of Single Event Upsets (SEUs) for star trackers and avionics. Atmospheric drag is calculated to increase by 45% over the next 12 hours. [Trace: GraphDB Multi-Hop Path: Anomaly->Drag->LEO_Asset]
- GEO (35,786km): Relativistic electron flux has crossed the critical threshold (>110,000 electrons/cm²/s/sr). Warning: High probability of deep dielectric charging on satellite solar panels. [Trace: "Space Weather Impacts on GEO" NotebookLM]

Tactical Recommendation: 
1. Initiate "Safe Mode" protocols for critical trailing-edge GEO assets. 
2. Delay planned orbital raising maneuvers for LEO constellations until the Kp index drops below 5. 
3. Monitor the magnetopause compression index; it is currently running at 0.5 (Highly Compressed).

*Confidence Interval: 94.2% (Bayesian Deep Learning Engine)*`;

export function GaussRagPanel() {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<{ filePath: string; score: number }[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Source chip the user expanded
  const [activeTrace, setActiveTrace] = useState<string | null>(null);
  // True while the answer is the scripted storm narration, not a model reply
  const [simulated, setSimulated] = useState(false);

  // Helper to parse text and render citation badges
  const renderTextWithTraces = (text: string) => {
    // Regex matches [Trace: Any Source Name]
    const parts = text.split(/(\[Trace:.*?\])/g);
    return parts.map((part, i) => {
      if (part.startsWith('[Trace:')) {
        const sourceName = part.replace('[Trace: ', '').replace(']', '');
        return (
          <button
            key={i}
            onClick={() => setActiveTrace(activeTrace === sourceName ? null : sourceName)}
            className="mx-1 inline-flex items-center gap-1 rounded border border-charcoal px-1.5 py-0.5 align-middle font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-expanded={activeTrace === sourceName}
            title={`Source: ${sourceName}`}
          >
            <Database size={10} aria-hidden="true" />
            Source
          </button>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  useEffect(() => {
    let intervalId: number | null = null;
    let currentIndex = 0;

    const clearStormInterval = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleStorm = (e: any) => {
      if (e.detail) {
        setSimulated(true);
        setAnswer("");
        setSources([]);
        currentIndex = 0;
        if (intervalId !== null) {
          return;
        }

        intervalId = window.setInterval(() => {
          if (currentIndex >= MOCK_AI_TEXT.length) {
            clearStormInterval();
            return;
          }

          setAnswer((prev) => (prev || "") + MOCK_AI_TEXT[currentIndex]);
          currentIndex += 1;
        }, 15);
      } else {
        setSimulated(false);
        setAnswer(null);
        clearStormInterval();
      }
    };

    window.addEventListener('simulate-g4-storm', handleStorm);
    return () => {
      window.removeEventListener('simulate-g4-storm', handleStorm);
      clearStormInterval();
    };
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch(`${RAG_BASE}/api/rag/status`);
      const json = (await res.json()) as RagStatus;
      setStatus(json);
    } catch (e) {
      setStatus({ ok: false, error: 'Gauss RAG server not reachable' });
    }
  }

  useEffect(() => {
    void fetchStatus();
  }, []);

  async function handleIndex() {
    setIndexing(true);
    setError(null);
    try {
      const res = await fetch(`${RAG_BASE}/api/rag/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: DEFAULT_INDEX_DIR }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || 'Indexing failed');
      }
      await fetchStatus();
    } catch (e) {
      setError('Could not reach Gauss RAG server');
    } finally {
      setIndexing(false);
    }
  }

  async function handleAsk() {
    if (!question.trim()) return;
    setAsking(true);
    setError(null);
    setSimulated(false);
    setAnswer(null);
    setSources([]);
    try {
      const res = await fetch(`${RAG_BASE}/api/rag/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question }),
      });
      const json = (await res.json()) as RagQueryResponse;
      if (!json.ok) {
        setError(json.error || 'Query failed');
      } else {
        setAnswer(json.answer || '');
        setSources(json.sources || []);
      }
    } catch (e) {
      setError('Could not reach Gauss RAG server');
    } finally {
      setAsking(false);
    }
  }

  const chunkLabel =
    status?.ok && typeof status.chunkCount === 'number'
      ? `${status.chunkCount} knowledge chunks`
      : 'No index yet';
  return (
    <section aria-labelledby="rag-title" className="hud-panel w-full space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="rag-title" className="brand-label">06_LOGIC_ENGINE</h2>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{chunkLabel}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleIndex} disabled={indexing}>
          <Database aria-hidden="true" />
          {indexing ? 'Indexing…' : 'Rebuild index'}
        </Button>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAsk();
        }}
      >
        <label htmlFor="rag-question" className="sr-only">
          Question for the knowledge base
        </label>
        <textarea
          id="rag-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about current conditions…"
          className="h-20 w-full resize-none rounded-md border border-charcoal bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-signal focus-visible:outline-none"
        />
        <Button type="submit" variant="secondary" className="w-full" disabled={asking || !question.trim()}>
          <Search aria-hidden="true" />
          {asking ? 'Searching the knowledge base…' : 'Ask'}
        </Button>
      </form>

      {error && (
        <p role="alert" className="rounded-md border border-caution/50 px-3 py-2 text-sm text-caution">
          {error}
        </p>
      )}

      {answer && (
        <div className="space-y-2 border-t border-charcoal pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Answer</span>
            {simulated && <StatusBadge tone="caution">Simulated scenario</StatusBadge>}
          </div>
          <p className="max-h-60 overflow-y-auto whitespace-pre-wrap text-left text-sm leading-relaxed text-foreground">
            {renderTextWithTraces(answer)}
          </p>
          {activeTrace && (
            <p className="rounded-md border border-charcoal px-3 py-2 font-mono text-xs text-muted-foreground">
              Cited source: <span className="text-foreground">{activeTrace}</span>
            </p>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <div className="border-t border-charcoal pt-2">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Sources</p>
          <ul className="max-h-16 space-y-0.5 overflow-y-auto text-left">
            {sources.map((s, i) => (
              <li key={`${s.filePath}-${i}`} className="truncate font-mono text-xs text-muted-foreground">
                {s.filePath}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
