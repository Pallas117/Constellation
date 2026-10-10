import { Globe, Orbit, Waves, GitBranch, Radio, Compass } from 'lucide-react';
import type { ReactNode } from 'react';

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
  /** Section label in the brand's NN_UPPER_SNAKE form. */
  label?: string;
}

interface LayerDef {
  key: keyof LayerVisibility;
  name: string;
  hint: string;
  icon: ReactNode;
  /** Colour key matching the scene encoding. */
  swatch: string;
}

const LAYERS: LayerDef[] = [
  { key: 'earth', name: 'Earth', hint: 'Globe and atmosphere', icon: <Globe size={14} />, swatch: 'bg-earth' },
  { key: 'belts', name: 'Radiation belts', hint: 'Protons inner, electrons outer', icon: <Orbit size={14} />, swatch: 'bg-gradient-to-r from-caution to-signal' },
  { key: 'magnetosphere', name: 'Boundaries', hint: 'Magnetopause, bow shock, tail sheet', icon: <Waves size={14} />, swatch: 'bg-earth' },
  { key: 'fieldLines', name: 'Field lines', hint: 'Closed vs open to solar wind', icon: <GitBranch size={14} />, swatch: 'bg-gradient-to-r from-earth to-sun' },
  { key: 'mhdWaves', name: 'MHD waves', hint: 'Alfvén and fast-mode modes', icon: <Radio size={14} />, swatch: 'bg-muted-foreground' },
  { key: 'mmsReconnection', name: 'MMS reconnection', hint: 'Tetrahedron current vectors', icon: <Compass size={14} />, swatch: 'bg-sun' },
];

export const LayerToggles = ({ layers, onToggle, label = '00_LAYERS' }: LayerTogglesProps) => {
  return (
    <section className="hud-panel p-3" aria-labelledby="layer-toggles-label">
      <h2 id="layer-toggles-label" className="brand-label mb-2">
        {label}
      </h2>
      <ul className="space-y-1">
        {LAYERS.map((layer) => {
          const active = layer.key === 'mmsReconnection' ? layers.mmsReconnection !== false : Boolean(layers[layer.key]);
          return (
            <li key={layer.key}>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-label={`${layer.name} layer`}
                onClick={() => onToggle(layer.key)}
                className={`group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                <span aria-hidden="true" className={active ? 'text-foreground' : 'text-muted-foreground/60'}>
                  {layer.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-tight">{layer.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{layer.hint}</span>
                </span>
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-5 shrink-0 rounded-full transition-opacity ${layer.swatch} ${active ? 'opacity-100' : 'opacity-20'}`}
                />
                <span
                  aria-hidden="true"
                  className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
                    active ? 'border-signal bg-signal/20' : 'border-charcoal bg-transparent'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all ${
                      active ? 'left-3.5 bg-signal' : 'left-0.5 bg-muted-foreground'
                    }`}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
