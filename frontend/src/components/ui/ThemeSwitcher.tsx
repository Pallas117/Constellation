/**
 * Theme Switcher Component
 * Allows users to switch between light, dark, and system themes
 */

import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="hud-panel p-1 bg-black/40 border-primary/20 group">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="w-8 h-8 flex items-center justify-center hover:bg-primary/20 text-primary transition-colors focus:outline-none"
            aria-label={`Current theme: ${theme}. Click to change theme.`}
          >
            {theme === 'light' ? (
              <Sun className="h-4 w-4 phosphor-text" aria-hidden="true" />
            ) : theme === 'dark' ? (
              <Moon className="h-4 w-4 phosphor-text" aria-hidden="true" />
            ) : (
              <Monitor className="h-4 w-4 phosphor-text" aria-hidden="true" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent 
          align="start" 
          className="bg-black/90 backdrop-blur-md border border-primary/20 rounded-none min-w-[120px]"
        >
          <DropdownMenuItem
            onClick={() => setTheme('light')}
            className="focus:bg-primary/20 focus:text-primary rounded-none cursor-crosshair px-2 py-1.5"
          >
            <Sun className="mr-2 h-3 w-3" />
            <span className="text-[9px] font-bold uppercase tracking-widest">MODE_LIT</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setTheme('dark')}
            className="focus:bg-primary/20 focus:text-primary rounded-none cursor-crosshair px-2 py-1.5"
          >
            <Moon className="mr-2 h-3 w-3" />
            <span className="text-[9px] font-bold uppercase tracking-widest">MODE_DRK</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setTheme('system')}
            className="focus:bg-primary/20 focus:text-primary rounded-none cursor-crosshair px-2 py-1.5"
          >
            <Monitor className="mr-2 h-3 w-3" />
            <span className="text-[9px] font-bold uppercase tracking-widest">MODE_SYS</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="scanline" />
    </div>
  );
}

