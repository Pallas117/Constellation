import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { commerceApi, type PilotInterest } from "@/lib/api/commerce";

const INTERESTS: Array<{ value: PilotInterest; label: string }> = [
  { value: "data-api", label: "Refined Data API" },
  { value: "connectivity", label: "Assured Connectivity for our ops team" },
  { value: "both", label: "Both" },
];

/** "Request a pilot" form. Submissions are stored for the Gauss team to follow up; nothing is sent automatically. */
export function PilotRequestDialog({ interest = "both", children }: { interest?: PilotInterest; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", company: "", interest, useCase: "", website: "" });
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setState("sending");
    try {
      await commerceApi.requestPilot(form);
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setState("idle");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setForm((f) => ({ ...f, interest }));
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {state === "sent" ? (
          <DialogHeader>
            <DialogTitle>Thanks, we have your request</DialogTitle>
            <DialogDescription>
              The Gauss team will reply to {form.email} to scope a 30-day replay pilot on your own data.
            </DialogDescription>
          </DialogHeader>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Request a pilot</DialogTitle>
              <DialogDescription>
                A 30-day pilot on your own mission data: refined feeds with source and freshness metadata through the Gauss API, and assured
                connectivity for your operations team.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pilot-name">Name</Label>
                <Input id="pilot-name" value={form.name} onChange={set("name")} required maxLength={120} autoComplete="name" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pilot-email">Work email</Label>
                <Input id="pilot-email" type="email" value={form.email} onChange={set("email")} required maxLength={254} autoComplete="email" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pilot-company">Organisation</Label>
              <Input id="pilot-company" value={form.company} onChange={set("company")} required maxLength={160} autoComplete="organization" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pilot-interest">Interested in</Label>
              <select
                id="pilot-interest"
                value={form.interest}
                onChange={set("interest")}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {INTERESTS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pilot-usecase">What would you use it for? (optional)</Label>
              <Textarea id="pilot-usecase" value={form.useCase} onChange={set("useCase")} maxLength={2000} rows={3} />
            </div>
            {/* Honeypot: hidden from people, filled by bots. */}
            <input type="text" name="website" value={form.website} onChange={set("website")} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Request a pilot"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
