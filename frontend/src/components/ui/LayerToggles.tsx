import { Globe, Orbit, Waves, GitBranch, Radio, Compass } from 'lucide-react';

interface LayerVisibility {
  earth: boolean;
  belts: boolean;
  magnetosphere: boolean;
  fieldLines: boolean;
  mhdWaves: boolean;
  mmsReconnection?: boolean;
}

interface LayerTogglesProps {
  layers: LayerVisibility;
  onToggle: (layer: keyof LayerVisibility) => void;
}

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

const ToggleButton = ({ active, onClick, icon, label }: ToggleButtonProps) => (
  <button
    onClick={onClick}
    data-active={active}
    className={`toggle-button flex items-center gap-2 w-full p-1 border-b border-primary/5 hover:bg-primary/5 transition-colors ${active ? 'text-primary' : 'text-primary/40'}`}
    aria-pressed={active}
    aria-label={`${active ? 'Hide' : 'Show'} ${label} layer`}
  >
    <span aria-hidden="true">{icon}</span>
    <span className="text-[9px] font-bold uppercase tracking-widest">{label}</span>
  </button>
);

export const LayerToggles = ({ layers, onToggle }: LayerTogglesProps) => {
  return (
    <div className="hud-panel min-w-[180px] bg-black/40 border-primary/20 animate-fade-in-up">
      <div className="sql-header p-1 px-2 mb-1">
        LAYER_VISIBILITY_CTRL
      </div>
      
      <div className="space-y-0.5 p-1">
        <ToggleButton
          active={layers.earth}
          onClick={() => onToggle('earth')}
          icon={<Globe size={12} />}
          label="LYR_00_EARTH"
        />
        
        <ToggleButton
          active={layers.belts}
          onClick={() => onToggle('belts')}
          icon={<Orbit size={12} />}
          label="LYR_01_VBELT"
        />
        
        <ToggleButton
          active={layers.magnetosphere}
          onClick={() => onToggle('magnetosphere')}
          icon={<Waves size={12} />}
          label="LYR_02_MOPAUSE"
        />
        
        <ToggleButton
          active={layers.fieldLines}
          onClick={() => onToggle('fieldLines')}
          icon={<GitBranch size={12} />}
          label="LYR_03_FLINES"
        />

        <ToggleButton
          active={layers.mhdWaves}
          onClick={() => onToggle('mhdWaves')}
          icon={<Radio size={12} />}
          label="LYR_04_MHDWAV"
        />

        <ToggleButton
          active={layers.mmsReconnection !== false}
          onClick={() => onToggle('mmsReconnection')}
          icon={<Compass size={12} />}
          label="LYR_05_RECON"
        />
      </div>
      <div className="scanline" />
    </div>
  );
};
