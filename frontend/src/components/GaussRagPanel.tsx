import { useEffect, useState } from 'react';
import { Database, Search, Terminal as TerminalIcon } from 'lucide-react';
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
  import.meta.env.VITE_GAUSS_RAG_INDEX_DIR || '/Users/josh/Documents/lightbound';

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
  
  // New state for Trace UI
  const [activeTrace, setActiveTrace] = useState<string | null>(null);

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
            className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-1 rounded bg-earth/20 text-foreground border border-earth/40 hover:bg-earth/30 transition-colors text-[9px] uppercase tracking-wider font-bold cursor-pointer align-middle"
            title="View Reasoning Trace"
          >
            <Database size={10} />
            TRC
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

    const handleStorm = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) {
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
    <div className="hud-panel p-4 w-[min(94vw,480px)] pointer-events-auto space-y-4 bg-panel/85 border-border backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
        <div>
          <h3 className="brand-label flex items-center gap-2">
            04_LOGIC_ENGINE
          </h3>
          {/* The index's real state, from /api/rag/status. */}
          <p className="stat-label mt-1">{chunkLabel}</p>
        </div>
        <button
          type="button"
          onClick={handleIndex}
          disabled={indexing}
          className="min-h-8 text-[9px] px-3 py-1 border border-border hover:bg-foreground/10 hover:text-foreground transition-colors disabled:opacity-30 uppercase tracking-widest font-bold inline-flex items-center gap-2"
        >
          <Database size={10} />
          {indexing ? 'INDEXING...' : 'R_INDEX_LGB'}
        </button>
      </div>

      <div className="space-y-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="[ENTER_QUERY_INPUT...]"
          className="w-full h-20 text-[10px] bg-background/60 border border-border px-3 py-2 resize-none focus:outline-none focus:border-foreground/30 text-foreground font-mono placeholder:text-muted-foreground/60"
        />
        <button
          type="button"
          onClick={handleAsk}
          disabled={asking || !question.trim()}
          className="w-full text-[10px] px-3 py-2 border border-foreground/30 bg-foreground/5 hover:bg-foreground/10 hover:text-foreground transition-colors disabled:opacity-30 font-bold uppercase tracking-[0.2em] inline-flex items-center justify-center gap-2"
        >
          <Search size={12} />
          {asking ? 'CONSULTING_GAUSS_CO_PROCESSOR...' : 'EXEC_QUERY_RAG'}
        </button>
      </div>

      {error && (
        <p className="text-[9px] text-destructive uppercase">
          ERR_STK: {error}
        </p>
      )}

      {answer && (
        <div className="mt-2 space-y-2 relative border-t border-border pt-3">
          <p className="stat-label">Answer</p>
          <div className="p-3 bg-background/60 border border-border shadow-inner">
            <p className="text-[10px] text-foreground whitespace-pre-wrap text-left leading-relaxed font-mono">
              {renderTextWithTraces(answer)}
            </p>
          </div>
          
          {/* Active Expandable Trace Panel */}
          {activeTrace && (
            <div className="mt-2 p-3 bg-foreground/5 border border-border animate-in fade-in slide-in-from-top-1">
              {/* Only what the answer actually cites: no verification is claimed that didn't run. */}
              <h4 className="stat-label mb-1 flex items-center gap-2">
                <Database size={10} aria-hidden="true" />
                Cited source
              </h4>
              <p className="font-mono text-[11px] text-foreground">{activeTrace}</p>
            </div>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <div className="mt-1 pt-2 border-t border-border">
          <p className="text-[8px] font-bold text-muted-foreground uppercase tracking-widest mb-1">
            SOURCE_ATTRIBUTION
          </p>
          <ul className="space-y-0.5 max-h-16 overflow-y-auto text-left">
            {sources.map((s, i) => (
              <li
                key={`${s.filePath}-${i}`}
                className="text-[8px] text-muted-foreground truncate font-mono"
              >
                + {s.filePath}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
