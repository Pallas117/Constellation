import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMesh, type MeshDevice } from "@/hooks/useMesh";

const STALE_MS = 15 * 60 * 1000;

// What each Argo class means for the person reading the table.
const CLASS_HELP: Record<string, string> = {
  OK: "Connected",
  WPAD_RISK: "Works, but auto-proxy is on",
  OFFLINE: "No network",
  CAPTIVE: "Wi-Fi login page",
  DNS: "DNS failing",
  DEAD_PROXY: "Dead proxy setting",
  STALE_DAEMON: "Claude daemon stuck on dead proxy",
  TLS_INTERCEPT: "Network intercepting TLS",
  PORT_BLOCK: "Network blocking Anthropic",
  REGION: "Unsupported exit country",
};

function statusOf(d: MeshDevice): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (!d.last) return { label: "Never reported", variant: "outline" };
  if (Date.now() - Date.parse(d.last.receivedAt) > STALE_MS) return { label: `${d.last.class} (stale)`, variant: "outline" };
  if (d.last.class === "OK") return { label: "OK", variant: "default" };
  if (d.last.class === "WPAD_RISK") return { label: "WPAD_RISK", variant: "secondary" };
  return { label: d.last.class, variant: "destructive" };
}

function ago(iso?: string) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

const MeshDashboard = () => {
  const { steps, devices, canSeeTeam, error, enroll, revoke } = useMesh();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const onEnroll = async () => {
    setEnrollError(null);
    try {
      const token = await enroll(name.trim().toLowerCase());
      setIssued({ name: name.trim().toLowerCase(), token });
      setName("");
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : "Enrollment failed");
    }
  };

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-primary/80">Mesh & Network</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Team connectivity</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Each laptop runs Argo, which keeps Claude Code connected on hotspots and public Wi-Fi and reports a short status here over the
              tailnet. Exit traffic is only ever allowed through Malaysia or Singapore.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/operator">Back to operator console</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 px-4 pb-10 sm:px-8 xl:grid-cols-[1.4fr_1fr]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Devices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canSeeTeam && <p className="text-sm text-muted-foreground">Team status is visible to operators and admins.</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {canSeeTeam && devices && devices.length === 0 && (
              <p className="text-sm text-muted-foreground">No devices enrolled yet. An admin can add one below.</p>
            )}
            {canSeeTeam && devices && devices.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4">Device</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Exit</th>
                      <th className="py-2 pr-4">Tailscale</th>
                      <th className="py-2 pr-4">Last report</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => {
                      const s = statusOf(d);
                      return (
                        <tr key={d.name} className="border-t border-border/60 align-top">
                          <td className="py-3 pr-4 font-mono">{d.name}</td>
                          <td className="py-3 pr-4">
                            <Badge variant={s.variant}>{s.label}</Badge>
                            {d.last && d.last.class !== "OK" && (
                              <p className="mt-1 max-w-xs text-xs text-muted-foreground">{CLASS_HELP[d.last.class] ?? d.last.reason}</p>
                            )}
                            {d.last?.breakerOpen && <p className="mt-1 text-xs text-destructive">Auto-fix paused; needs a person</p>}
                          </td>
                          <td className="py-3 pr-4">{d.last?.loc || "—"}</td>
                          <td className="py-3 pr-4">{d.last ? (d.last.tailscale ? d.last.exitNode || "on" : "off") : "—"}</td>
                          <td className="py-3 pr-4 text-muted-foreground">{ago(d.last?.receivedAt)}</td>
                          <td className="py-3 text-right">
                            <Button size="sm" variant="ghost" onClick={() => void revoke(d.name)}>
                              Revoke
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {canSeeTeam && (
              <div className="space-y-2 border-t border-border/60 pt-4">
                <p className="text-sm font-medium">Enroll a device (admin)</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input placeholder="device name, e.g. judith" value={name} onChange={(e) => setName(e.target.value)} />
                  <Button onClick={() => void onEnroll()} disabled={!name.trim()}>
                    Create token
                  </Button>
                </div>
                {enrollError && <p className="text-sm text-destructive">{enrollError}</p>}
                {issued && (
                  <div className="space-y-2 rounded-md border border-primary/40 p-3 text-sm">
                    <p>
                      Token for <span className="font-mono">{issued.name}</span>. It is shown once. On that laptop run the command below and
                      paste the token when asked:
                    </p>
                    <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">argo enroll {window.location.protocol}//&lt;gauss-tailnet-host&gt;:3001 {issued.name}</pre>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input readOnly value={issued.token} className="font-mono text-xs" />
                      <Button variant="outline" onClick={() => void navigator.clipboard.writeText(issued.token)}>
                        Copy
                      </Button>
                      <Button variant="ghost" onClick={() => setIssued(null)}>
                        Done
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Join the mesh</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              {steps.map((step, i) => (
                <li key={step.id} className="space-y-1">
                  <p className="text-sm font-medium">
                    {i + 1}. {step.title} {step.pending && <Badge variant="outline">pending</Badge>}
                  </p>
                  {step.command && <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{step.command}</pre>}
                  <p className="text-xs text-muted-foreground">{step.detail}</p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </section>
    </main>
  );
};

export default MeshDashboard;
