import { Toaster as Sonner } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const phone = useIsMobile();
  // One dark look (Brand Room): never follow a light OS theme.
  return (
    <Sonner
      theme="dark"
      // Clear of the console header and side columns: top centre below the
      // header on wide screens; at the bottom on phones, where the header wraps.
      position={phone ? "bottom-center" : "top-center"}
      offset={phone ? 16 : 112}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-panel group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          // Sonner's own button styles load later than ours: ! keeps the brand colours.
          actionButton: "!bg-foreground !text-background",
          cancelButton: "!bg-muted !text-muted-foreground",
          error: "!border-sun/60",
          warning: "!border-caution/60",
          success: "!border-signal/40",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
