import { Camera } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface ScreenshotButtonProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
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
    <Button type="button" variant="outline" size="sm" onClick={handleScreenshot} className="w-full justify-start">
      <Camera aria-hidden="true" />
      Save screenshot
    </Button>
  );
};
