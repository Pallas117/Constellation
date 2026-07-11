import { InterpolatedData } from '@/hooks/useSpaceWeather';

interface HUDProps {
  data: InterpolatedData;
}

const getKpStatus = (kp: number): 'normal' | 'elevated' | 'high' => {
  if (kp >= 7) return 'high';
  if (kp >= 4) return 'elevated';
  return 'normal';
};

const getBzStatus = (bz: number): 'normal' | 'elevated' | 'high' => {
  if (bz <= -10) return 'high';
  if (bz <= -5) return 'elevated';
  return 'normal';
};

const getSpeedStatus = (speed: number): 'normal' | 'elevated' | 'high' => {
  if (speed >= 600) return 'high';
  if (speed >= 450) return 'elevated';
  return 'normal';
};

const DataRow = ({ label, value, unit, status = 'normal' }: { label: string; value: string | number; unit: string; status?: string }) => (
  <div className="sql-row">
    <span className="sql-label">{label}</span>
    <span className={`sql-value ${status === 'high' ? 'text-destructive phosphor-text' : 'phosphor-text'}`}>
      {typeof value === 'number' ? value.toFixed(1) : value}
      <span className="ml-1 opacity-40 text-[9px]">{unit}</span>
    </span>
  </div>
);

export const HUD = ({ data }: HUDProps) => {
  const getStatusColor = (tier: number) => {
    switch (tier) {
      case 0: return 'text-primary';
      case 1: return 'text-primary/70';
      case 2: return 'text-cyan-400';
      case 3: return 'text-amber-500';
      default: return 'text-muted-foreground';
    }
  };

  const statusLabels = ['LIVE', 'REDUNDANT', 'SYNTHETIC', 'STALE'];
  const statusLabel = statusLabels[data.tier] || 'UNKNOWN';

  return (
    <div className="hud-panel min-w-[240px] border-primary/20 bg-black/40">
      {/* Table Header */}
      <div className="sql-header p-1 flex justify-between items-center px-2">
        <span>GAUSS // SENSOR_ARRAY</span>
        <span className={getStatusColor(data.tier)}>{statusLabel}</span>
      </div>

      <div className="sql-grid">
        <DataRow
          label="Wind_Velocity"
          value={data.solarWind.speed}
          unit="KM/S"
          status={getSpeedStatus(data.solarWind.speed)}
        />
        <DataRow
          label="Plasma_Density"
          value={data.solarWind.density}
          unit="P/CM3"
        />
        <DataRow
          label="IMF_BZ_FIELD"
          value={data.imfBz}
          unit="NT"
          status={getBzStatus(data.imfBz)}
        />
        <DataRow
          label="GEOMAG_KP"
          value={data.kpIndex}
          unit="IDX"
          status={getKpStatus(data.kpIndex)}
        />
        <DataRow
          label="PROTON_FLUX"
          value={data.protonFlux}
          unit="PFU"
        />
      </div>

      {/* Table Footer */}
      <div className="p-1 px-2 border-t border-primary/10 flex justify-between items-center opacity-40 text-[9px]">
        <span>REF_ID: 0x{data.tier.toString(16).toUpperCase()}</span>
        <span>{data.timestamp.toISOString().split('T')[1].split('.')[0]} Z</span>
      </div>
      
      <div className="scanline" />
    </div>
  );
};
