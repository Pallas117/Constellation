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
      className="hud-panel p-1.5 flex items-center justify-center hover:bg-primary/20 transition-colors border-primary/20 animate-fade-in-up"
      title="Export Screenshot"
    >
      <Camera size={14} className="text-primary phosphor-text" />
      <span className="text-[9px] font-bold uppercase ml-2 tracking-widest text-primary/60 group-hover:text-primary">
        SEC_CAP
      </span>
      <div className="scanline" />
    </button>
  );
};
