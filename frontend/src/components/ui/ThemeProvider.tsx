/**
 * Theme Provider Component
 * The Lightbound brand has one look (black ground, warm white type), so the
 * theme is forced to dark. Kept as a provider for next-themes consumers
 * such as the toaster.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { type ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider attribute="class" forcedTheme="dark" enableSystem={false}>
      {children}
    </NextThemesProvider>
  );
}
