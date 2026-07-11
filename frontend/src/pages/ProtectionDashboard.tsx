import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDeviceSwapPlan } from "@/hooks/useDeviceSwapPlan";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";

const ProtectionDashboard = () => {
  const { plan, loading, error, lastUpdated, rebalanceMessage, rebalance } = useDeviceSwapPlan();
  const solarWind = useSolarWind5s();
  const latest = solarWind.latest;

  const assignmentSummary = useMemo(() => {
    if (!plan) return { total: 0, critical: 0, high: 0, medium: 0, low: 0, averageScore: 0 };

    const total = plan.assignments.length;
    const bucket = plan.assignments.reduce(
      (acc, assignment) => {
        if (assignment.tier >= 3) acc.critical += 1;
        else if (assignment.tier === 2) acc.high += 1;
        else if (assignment.tier === 1) acc.medium += 1;
        else acc.low += 1;
        acc.averageScore += assignment.score;
        return acc;
      },
      { total, critical: 0, high: 0, medium: 0, low: 0, averageScore: 0 },
    );

    return {
      ...bucket,
      averageScore: total > 0 ? Math.round(bucket.averageScore / total) : 0,
    };
  }, [plan]);

  const weatherRisk = useMemo(() => {
    if (!latest) {
      return { label: "Unknown", description: "No solar wind feed available yet.", score: 0 };
    }

    const speed = latest.solarWind.speed ?? 400;
    const kp = latest.indices?.kp ?? 2;
    const bz = latest.magneticField?.z ?? 0;
    const score = Math.min(100, Math.max(0, Math.round((kp * 9) + Math.abs(bz) * 3 + ((speed - 300) / 15))));

    let label = "Stable";
    let description = "Current conditions are below the threshold for operational impact.";

    if (score > 80) {
      label = "Severe Storm";
      description = "Strong solar wind pressure and southward IMF make device protection critical now.";
    } else if (score > 50) {
      label = "Active Warning";
      description = "Geomagnetic activity is rising. Prioritize thermal and load redistribution across SWAP tiers.";
    } else if (score > 25) {
      label = "Moderate Risk";
      description = "Transitions in the magnetosphere can begin to influence sensitive routing and power budgets.";
    }

    return { label, description, score };
  }, [latest]);

  const impactNarrative = useMemo(() => {
    if (!plan || !latest) return "Awaiting device telemetry and space weather data to build correlation signals.";

    const protectedCount = plan.assignments.filter((assignment) => assignment.tier >= 2).length;
    const underPressure = assignmentSummary.critical + assignmentSummary.high;
    const researchSignal = Math.round((assignmentSummary.averageScore / 2) + weatherRisk.score / 10 + underPressure * 3);

    return `Protecting ${protectedCount} of ${assignmentSummary.total} connected devices using SWAP tiering. Current heliophysics stress: ${weatherRisk.label}. This summary is a live signal for research into how space weather cascades through power, compute, and thermal systems, with a performance signal of ${researchSignal}.`;
  }, [plan, assignmentSummary, weatherRisk]);

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-primary/80">Protection Intelligence</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Device SWAP Resilience & Heliophysics Research</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Correlate current magnetospheric stress with operational device health. Use adaptive SWAP load management to protect critical infrastructure and capture impact signals for civilization-scale resilience research.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={rebalance} disabled={loading}>
              Trigger SWAP Rebalance
            </Button>
            <Link to="/operator" className="inline-flex items-center justify-center rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/10">
              Back to Operator
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 px-4 pb-6 sm:px-8 lg:grid-cols-[minmax(360px,1fr)_minmax(420px,1fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Heliophysics Threat Assessment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-muted p-4">
                <p className="text-xs uppercase text-muted-foreground">Risk Level</p>
                <p className="mt-2 text-2xl font-semibold">{weatherRisk.label}</p>
              </div>
              <div className="rounded-xl border border-border bg-muted p-4">
                <p className="text-xs uppercase text-muted-foreground">Threat Score</p>
                <p className="mt-2 text-2xl font-semibold">{weatherRisk.score}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-muted p-4">
                <p className="text-xs uppercase text-muted-foreground">IMF Bz</p>
                <p className="mt-2 text-lg font-semibold">{latest?.magneticField?.z?.toFixed(1) ?? "n/a"} nT</p>
              </div>
              <div className="rounded-xl border border-border bg-muted p-4">
                <p className="text-xs uppercase text-muted-foreground">Kp Index</p>
                <p className="mt-2 text-lg font-semibold">{latest?.indices?.kp ?? "n/a"}</p>
              </div>
            </div>

            <p className="text-sm leading-6 text-muted-foreground">{weatherRisk.description}</p>
            <p className="text-xs text-muted-foreground">Feed source: {solarWind.source} · Updated {lastUpdated ? lastUpdated.toLocaleTimeString() : "soon"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>SWAP Device Network Health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {loading ? (
              <p>Loading current SWAP plan...</p>
            ) : error ? (
              <p className="text-destructive">{error}</p>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-border bg-muted p-4">
                    <p className="text-xs uppercase text-muted-foreground">Devices tracked</p>
                    <p className="mt-2 text-2xl font-semibold">{assignmentSummary.total}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted p-4">
                    <p className="text-xs uppercase text-muted-foreground">Mean health score</p>
                    <p className="mt-2 text-2xl font-semibold">{assignmentSummary.averageScore}</p>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-border bg-muted p-4">
                    <p className="text-xs uppercase text-muted-foreground">Critical tiers</p>
                    <p className="mt-2 text-xl font-semibold">{assignmentSummary.critical}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted p-4">
                    <p className="text-xs uppercase text-muted-foreground">High tiers</p>
                    <p className="mt-2 text-xl font-semibold">{assignmentSummary.high}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted p-4">
                    <p className="text-xs uppercase text-muted-foreground">Low tiers</p>
                    <p className="mt-2 text-xl font-semibold">{assignmentSummary.low}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-muted p-4">
                  <p className="text-xs uppercase text-muted-foreground">Plan summary</p>
                  <pre className="mt-2 text-xs text-[0.78rem] leading-5 text-foreground overflow-x-auto">{JSON.stringify(plan?.summary ?? {}, null, 2)}</pre>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="px-4 pb-12 sm:px-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Research signal & operational narrative</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-6">
            <p>{impactNarrative}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-muted p-4">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground mb-2">Protection margin</div>
                <div className="text-xl font-semibold">{assignmentSummary.high + assignmentSummary.critical}</div>
                <div className="text-xs text-muted-foreground">devices at elevated tiers</div>
              </div>
              <div className="rounded-xl border border-border bg-muted p-4">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground mb-2">Storm pressure</div>
                <div className="text-xl font-semibold">{latest?.solarWind?.dynamicPressure?.toFixed(2) ?? "n/a"} nPa</div>
                <div className="text-xs text-muted-foreground">dynamic pressure</div>
              </div>
              <div className="rounded-xl border border-border bg-muted p-4">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground mb-2">Rebalance status</div>
                <div className="text-xl font-semibold">{rebalanceMessage ? "Updated" : "Idle"}</div>
                <div className="text-xs text-muted-foreground">{rebalanceMessage ?? "No recent rebalance"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
};

export default ProtectionDashboard;
