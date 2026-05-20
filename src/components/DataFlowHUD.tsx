import React, { useEffect, useState } from 'react';
import { Shield, Cpu, Activity, Zap, Server, Database, Wifi } from 'lucide-react';
import { useConnectivity } from '@/hooks/useConnectivity';

interface DataFlowHUDProps {
  tier?: number;
}

const StatusNode = ({ label, value, active = true }: { label: string; value: string; active?: boolean }) => (
  <div className={`flex justify-between items-center py-1 border-b border-primary/10 ${!active && 'opacity-30'}`}>
    <span className="text-[9px] uppercase tracking-tighter text-primary/60">{label}</span>
    <span className={`text-[10px] font-bold ${active ? 'phosphor-text' : 'text-muted-foreground'}`}>{value}</span>
  </div>
);

export const DataFlowHUD: React.FC<DataFlowHUDProps> = ({ tier = 0 }) => {
  const [timestamp, setTimestamp] = useState(new Date());
  const { mode, latencyMs } = useConnectivity();

  useEffect(() => {
    const interval = setInterval(() => setTimestamp(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const getTierLabel = (t: number) => {
    switch (t) {
      case 0: return 'LIVE_FEED_DIRECT';
      case 1: return 'REDUNDANT_BUFFER_A';
      case 2: return 'SYNTH_INFER_V2';
      case 3: return 'EMERGENCY_STALE';
      default: return 'UNKNOWN';
    }
  };

  return (
    <div className="absolute bottom-6 right-6 z-40 pointer-events-none hidden xl:block">
      <div className="hud-panel p-3 min-w-[300px] border-primary/20 bg-black/60 pointer-events-auto overflow-hidden animate-fade-in-up">
        {/* Diagnostic Header */}
        <div className="flex items-center justify-between mb-3 border-b border-primary/30 pb-1">
          <div className="flex items-center gap-2">
            <Activity className="w-3 h-3 text-primary animate-pulse" />
            <h3 className="text-[10px] font-bold tracking-[0.3em] uppercase phosphor-text">
              DIAG // DATA_FLOW_LAYER
            </h3>
          </div>
          <div className="text-[8px] opacity-40 font-mono">
            T_SYNC: {timestamp.toLocaleTimeString()}
          </div>
        </div>

        {/* Operational Grid */}
        <div className="space-y-0.5">
          <StatusNode label="Primary_Sensors" value={tier === 0 ? "STRE_01_OK" : "NO_SIG"} active={tier === 0} />
          <StatusNode label="Logic_Ckt_State" value={getTierLabel(tier)} />
          <StatusNode label="Link_Topology" value={mode} active={mode !== 'AIRGAP'} />
          <StatusNode label="Link_Latency" value={latencyMs >= 0 ? `${latencyMs}ms` : '---'} active={mode === 'CLOUD'} />
          <StatusNode label="Persistent_Log" value="BEDROCK_ACTIVE" />
        </div>

        {/* Flow Indicators */}
        <div className="mt-4 flex items-center justify-between text-[8px] font-mono tracking-widest text-primary/40">
          <span>SENS {">>"}</span>
          <span className="animate-pulse">{">>>>"}</span>
          <span>ML_CORE {">>"}</span>
          <span className="animate-pulse">{">>>>"}</span>
          <span>DISP_01</span>
        </div>

        {/* Resilience Footer */}
        <div className="mt-4 pt-2 border-t border-primary/10 grid grid-cols-2 gap-4">
          <div>
            <div className="text-[7px] text-primary/40 uppercase">Sys_Resilience</div>
            <div className={`text-[10px] font-bold ${tier < 3 ? 'text-primary' : 'text-amber-500'}`}>
              TIER_{3 - tier}_READY
            </div>
          </div>
          <div className="text-right">
            <div className="text-[7px] text-primary/40 uppercase">Flux_Throughput</div>
            <div className="text-[10px] font-bold phosphor-text">2.4 MB/S</div>
          </div>
        </div>

        <div className="scanline" />
      </div>
    </div>
  );
};
