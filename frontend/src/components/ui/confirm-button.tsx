import { useEffect, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";

type Props = Omit<ComponentProps<typeof Button>, "onClick" | "children"> & {
  /** The action; the button shows `pendingLabel` until it settles. */
  onConfirm: () => Promise<unknown> | void;
  label: string;
  /** Second-click wording, e.g. "Revoke key?". */
  confirmLabel: string;
  pendingLabel: string;
};

/**
 * Two-step button for actions that can't be undone: the first click arms it, the second acts. It disarms by itself
 * after 4 s, and it can't be pressed twice while the request is in flight.
 */
export function ConfirmButton({ onConfirm, label, confirmLabel, pendingLabel, disabled, variant, ...rest }: Props) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const click = async () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      {...rest}
      variant={armed ? "destructive" : variant}
      disabled={disabled || pending}
      aria-live="polite"
      onClick={() => void click()}
    >
      {pending ? pendingLabel : armed ? confirmLabel : label}
    </Button>
  );
}
