import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status pill (Figma: "Status Badge"). `signal` is the one lime element per
 * view, usually the live-feed state. Risk keeps warm-white text: Sun on panel
 * is below AA for small type, so the Sun dot and edge carry the tone and the
 * word carries the meaning.
 */
export type BadgeTone = 'signal' | 'neutral' | 'caution' | 'risk';

const TONE: Record<BadgeTone, string> = {
  signal: 'border-signal/50 text-signal',
  neutral: 'border-charcoal text-foreground',
  caution: 'border-caution/60 text-caution',
  risk: 'border-sun bg-sun/15 text-foreground',
};

const DOT: Record<BadgeTone, string> = {
  signal: 'bg-signal',
  neutral: 'bg-muted-foreground',
  caution: 'bg-caution',
  risk: 'bg-sun',
};

export function StatusBadge({
  tone,
  children,
  pulse = false,
  className,
}: {
  tone: BadgeTone;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium uppercase leading-4 tracking-[0.08em]',
        TONE[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOT[tone], pulse && 'animate-pulse')} />
      {children}
    </span>
  );
}
