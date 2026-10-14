import { Camera } from 'lucide-react';
import { toast } from 'sonner';

interface ScreenshotButtonProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
}

export const ScreenshotButton = ({ canvasRef }: ScreenshotButtonProps) => {
  const handleScreenshot = async () => {
    if (!canvasRef.current) {
      toast.error('Canvas not ready');
      return;
    }

    try {
      const dataUrl = canvasRef.current.toDataURL('image/png', 1.0);
      
      const link = document.createElement('a');
      link.download = `space-weather-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
      
      toast.success('Screenshot saved');
    } catch (error) {
      toast.error('Failed to capture screenshot');
      console.error('Screenshot error:', error);
    }
  };

  return (
    <button
      onClick={handleScreenshot}
      className="hud-panel group flex min-h-9 items-center justify-center bg-panel/85 px-3 transition-colors hover:border-foreground/40"
    >
      <Camera size={14} className="text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
      <span className="ml-2 text-xs text-muted-foreground group-hover:text-foreground">Screenshot</span>
    </button>
  );
};
