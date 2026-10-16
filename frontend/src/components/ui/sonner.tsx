import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  // One dark look (Brand Room): never follow a light OS theme.
  return (
    <Sonner
      theme="dark"
      // Top centre, under the console toolbar: clear of every corner panel.
      position="top-center"
      offset={80}
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

export { Toaster, toast };
