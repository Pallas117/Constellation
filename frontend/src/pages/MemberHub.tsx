import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Globe, Sparkles, ShieldCheck } from "lucide-react";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function MemberHub() {
  useDocumentTitle("Member hub");

  return (
    <main className="min-h-screen w-full bg-background text-foreground px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <section className="rounded-lg border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="brand-label">00_MEMBER_HUB</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight [hyphens:auto] [overflow-wrap:anywhere] sm:text-4xl">Open access to magnetohydrodynamics, SDA, and network contributions.</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                Regular members keep the system funded and compute-rich. No operator credentials are required to explore our open heliophysics visualizations, see how the SDA is evolving, and join the network as a contributor.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild variant="secondary">
                <Link to="/heliophysics">Explore the live field</Link>
              </Button>
              <Button asChild>
                <Link to="/login">Operator sign-in</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Open Science</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Heliophysics and magnetohydrodynamics are kept open to the community. Contributors can visualize geomagnetic stress and support critical infrastructure without logging in.
              </p>
              <p className="flex items-center gap-2 text-primary font-medium">
                <Globe className="h-4 w-4" /> Public access to live SDA and space weather feeds
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Compute & Funding</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Regular members help scale the network by contributing compute capacity and funding model training, while operators maintain the secure mission-critical control plane.
              </p>
              <p className="flex items-center gap-2 text-primary font-medium">
                <Sparkles className="h-4 w-4" /> Easy low-latency contributions and visibility into performance.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Operator Separation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                The network preserves a stable operator login flow for mission operators. Operator access remains separate from member contributions and visualizations.
              </p>
              <p className="flex items-center gap-2 text-primary font-medium">
                <ShieldCheck className="h-4 w-4" /> Clear boundaries between open data and protected control.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
