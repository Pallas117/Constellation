import { cn } from "@/lib/utils";

/**
 * Holds a status pill's place while its feed loads, at the pill's height and about its width,
 * so the console header doesn't wrap (and push every panel down) when the data arrives.
 * It says what it is doing; it never shows a value that wasn't measured.
 */
export function PillPlaceholder({ label, className }: { label: string; className?: string }) {
  return (
    <span
      role="status"
      aria-busy="true"
      data-testid="pill-placeholder"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-charcoal/70 px-2.5 py-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-charcoal" />
      {label}
    </span>
  );
}
