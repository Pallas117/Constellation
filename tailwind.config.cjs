/**
 * Root Tailwind config to ensure PostCSS/Tailwind finds `content` and theme
 * when running Vite from workspace root (Playwright dev server). This mirrors
 * `frontend/tailwind.config.ts` but is plain JS so PostCSS can load it reliably.
 */
module.exports = {
  darkMode: ['class'],
  content: [
    './frontend/index.html',
    './frontend/src/**/*.{ts,tsx,js,jsx,html}',
    './frontend/components/**/*.{ts,tsx,js,jsx}',
    './frontend/pages/**/*.{ts,tsx,js,jsx}',
    './frontend/app/**/*.{ts,tsx,js,jsx}',
    './frontend/**/*.{html,js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      // Lightbound Brand Room: IBM Plex Sans for headlines/body, JetBrains Mono for labels and telemetry.
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      colors: {
        signal: 'hsl(var(--signal))',
        caution: 'hsl(var(--amber))',
        sun: 'hsl(var(--sun))',
        earth: 'hsl(var(--earth))',
        charcoal: 'hsl(var(--charcoal))',
        panel: 'hsl(var(--panel))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        space: {
          deep: 'hsl(var(--space-deep))',
          nebula: 'hsl(var(--space-nebula))',
        },
        belt: {
          inner: 'hsl(var(--belt-inner))',
          outer: 'hsl(var(--belt-outer))',
        },
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
};
