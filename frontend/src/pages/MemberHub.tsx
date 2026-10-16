import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Globe, Sparkles, ShieldCheck } from "lucide-react";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

const PILLARS = [
  {
    title: "Open Science",
    body: "Heliophysics and magnetohydrodynamics are kept open to the community. With a member account, contributors can visualise geomagnetic stress and support critical infrastructure.",
    icon: Globe,
    point: "Live space weather on the open landing page",
  },
  {
    title: "Compute & Funding",
    body: "Regular members help scale the network by contributing compute capacity and funding model training, while operators maintain the secure mission-critical control plane.",
    icon: Sparkles,
    point: "Easy low-latency contributions and visibility into performance",
  },
  {
    title: "Operator Separation",
    body: "The network preserves a stable operator login flow for mission operators. Operator access remains separate from member contributions and visualisations.",
    icon: ShieldCheck,
    point: "Clear boundaries between open data and protected control",
  },
];

export default function MemberHub() {
  useDocumentTitle("Member hub");

  return (
    <main className="min-h-dvh w-full bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="hud-panel p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="brand-label">00_MEMBER_HUB</p>
              <h1 className="mt-2 max-w-3xl text-2xl font-semibold leading-tight [overflow-wrap:anywhere] sm:text-4xl">
                Open access to magnetohydrodynamics, SDA, and network contributions.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                Regular members keep the system funded and compute-rich. No operator credentials are required: a member
                account opens the heliophysics visualisations, shows how the SDA is evolving, and lets you join the
                network as a contributor.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild variant="outline">
                <Link to="/heliophysics">Explore magnetohydrodynamics</Link>
              </Button>
              <Button asChild>
                <Link to="/login">Sign in</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {PILLARS.map(({ title, body, icon: Icon, point }) => (
            <Card key={title} className="shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">{title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>{body}</p>
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> {point}
                </p>
              </CardContent>
            </Card>
          ))}
        </section>

        <Link to="/" className="inline-block py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← Back to the live landing page
        </Link>
      </div>
    </main>
  );
}
