/**
 * ThemeContext — Gauss-domain design tokens layered on top of next-themes.
 *
 * Provides app-specific colours, intensities, and semantic labels so that
 * child components never hard-code visual values.  The existing ThemeProvider
 * (next-themes wrapper) remains untouched; this context augments it.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTheme } from 'next-themes';

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------

export interface GaussThemeTokens {
    /** Current next-themes mode: 'light' | 'dark' | 'system' */
    mode: string | undefined;
    /** Primary accent colour (CSS variable reference) */
    accentPrimary: string;
    /** HUD panel border colour */
    hudBorderColor: string;
    /** Scanline overlay opacity 0–1 */
    scanlineOpacity: number;
    /** Glow intensity multiplier for text / badges */
    glowIntensity: number;
    /** Whether the resolved theme is dark */
    isDark: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const GaussThemeContext = createContext<GaussThemeTokens | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface GaussThemeProviderProps {
    children: ReactNode;
}

export function GaussThemeProvider({ children }: GaussThemeProviderProps) {
    const { theme, resolvedTheme } = useTheme();
    const isDark = resolvedTheme === 'dark';

    const tokens = useMemo<GaussThemeTokens>(
        () => ({
            mode: theme,
            accentPrimary: isDark
                ? 'hsl(var(--primary))'
                : 'hsl(var(--primary))',
            hudBorderColor: isDark
                ? 'hsl(var(--border) / 0.45)'
                : 'hsl(var(--border) / 0.25)',
            scanlineOpacity: isDark ? 0.06 : 0.03,
            glowIntensity: isDark ? 1.0 : 0.5,
            isDark,
        }),
        [theme, isDark],
    );

    return (
        <GaussThemeContext.Provider value={tokens}>
            {children}
        </GaussThemeContext.Provider>
    );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGaussTheme(): GaussThemeTokens {
    const ctx = useContext(GaussThemeContext);
    if (!ctx) {
        throw new Error(
            'useGaussTheme must be used within a <GaussThemeProvider>',
        );
    }
    return ctx;
}
