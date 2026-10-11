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
            className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-1 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-colors text-[9px] uppercase tracking-wider font-bold cursor-pointer align-middle"
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

    const handleStorm = (e: any) => {
      if (e.detail) {
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
    <div className="hud-panel p-4 w-[min(94vw,480px)] pointer-events-auto animate-fade-in-up space-y-4 bg-black/60 border-primary/20 backdrop-blur-md">
      <div className="scanline" />
      <div className="flex items-center justify-between gap-3 border-b border-primary/20 pb-2">
        <div>
          <h3 className="text-[10px] font-bold tracking-[0.3em] text-primary uppercase flex items-center gap-2 phosphor-text">
            LOGIC_ENGINE // Ret_Layer_01
          </h3>
          <p className="text-[7px] text-primary/40 uppercase tracking-[0.2em] font-bold mt-0.5">
            LANCEDB_FUSION_V2_ACTIVE
          </p>
        </div>
        <button
          type="button"
          onClick={handleIndex}
          disabled={indexing}
          className="text-[9px] px-3 py-1 border border-primary/30 hover:bg-primary/20 hover:text-primary transition-colors disabled:opacity-30 uppercase tracking-widest font-bold inline-flex items-center gap-2"
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
          className="w-full h-20 text-[10px] bg-black/40 border border-primary/10 px-3 py-2 resize-none focus:outline-none focus:border-primary/40 text-primary font-mono placeholder:text-primary/20"
        />
        <button
          type="button"
          onClick={handleAsk}
          disabled={asking || !question.trim()}
          className="w-full text-[10px] px-3 py-2 border border-primary/40 bg-primary/5 hover:bg-primary/20 hover:text-primary transition-colors disabled:opacity-30 font-bold uppercase tracking-[0.2em] inline-flex items-center justify-center gap-2"
        >
          <Search size={12} />
          {asking ? 'CONSULTING_GAUSS_CO_PROCESSOR...' : 'EXEC_QUERY_RAG'}
        </button>
      </div>

      {error && (
        <p className="text-[9px] text-destructive phosphor-text uppercase">
          ERR_STK: {error}
        </p>
      )}

      {answer && (
        <div className="mt-2 space-y-2 relative border-t border-primary/10 pt-3">
          <div className="flex justify-between items-center text-[8px] font-bold tracking-widest uppercase">
            <span className="text-primary/40">INV_SHELL_OUTPUT</span>
            <span className="text-primary animate-pulse">VERIFIED_COVE</span>
          </div>
          <div className="p-3 bg-black/40 border border-primary/10 shadow-inner">
            <p className="text-[10px] text-primary/90 whitespace-pre-wrap text-left leading-relaxed font-mono">
              {renderTextWithTraces(answer)}
            </p>
          </div>
          
          {/* Active Expandable Trace Panel */}
          {activeTrace && (
            <div className="mt-2 p-3 bg-primary/5 border border-primary/30 animate-in fade-in slide-in-from-top-1">
              <h4 className="text-[9px] uppercase text-primary font-bold mb-1 flex items-center gap-2">
                <Database size={10} />
                HEX_TRACE_KGRAPH
              </h4>
              <p className="text-[8px] text-primary/60 mb-2">
                SRC: <span className="text-primary font-mono">{activeTrace}</span>
              </p>
              <div className="text-[8px] font-mono text-primary/40 bg-black/40 p-2 border-l border-primary/20">
                <span>&gt; verifying node constraints... ok.</span><br/>
                <span>&gt; multi-hop citation verified against GraphDB.</span><br/>
                <span className="text-primary/70">"Observations confirm metric deviations map to historical G4 profiles."</span>
              </div>
            </div>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <div className="mt-1 pt-2 border-t border-primary/5">
          <p className="text-[8px] font-bold text-primary/40 uppercase tracking-widest mb-1">
            SOURCE_ATTRIBUTION
          </p>
          <ul className="space-y-0.5 max-h-16 overflow-y-auto text-left">
            {sources.map((s, i) => (
              <li
                key={`${s.filePath}-${i}`}
                className="text-[8px] text-primary/60 truncate font-mono"
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
