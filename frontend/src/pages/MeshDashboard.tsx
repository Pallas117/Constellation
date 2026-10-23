import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMesh, type MeshDevice, type MeshNet, WARNING_CLASSES } from "@/hooks/useMesh";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { batteryLabel, copyText, deviceStage, enrollCommand, guardLine, STAGE_HELP, STALE_MS } from "@/lib/mesh-onboarding";
const PLATFORM_LABEL: Record<string, string> = { macos: "macOS", linux: "Linux", windows: "Windows", ios: "iPhone", android: "Android" };
// Mirrors hostingVerdict in backend/mesh/store.ts.
const HOSTING_LABEL: Record<string, string> = {
  agents: "Agents + memory",
  light: "Light work",
  no: "No spare capacity",
  unknown: "Unknown",
};

// What each Argo class means for the person reading the table.
const CLASS_HELP: Record<string, string> = {
  OK: "Connected",
  WPAD_RISK: "Works, but auto-proxy is on",
  WIFI_RISK: "Works, but the Wi-Fi is weak or this device is open to it",
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
  const stage = deviceStage(d, Date.now());
  if (stage === "rejected") return { label: "Report refused", variant: "destructive" };
  if (!d.last) return { label: stage === "silent" ? "No report yet" : "Waiting for first report", variant: "outline" };
  if (Date.now() - Date.parse(d.last.receivedAt) > STALE_MS) return { label: `${d.last.class} (stale)`, variant: "outline" };
  if (d.last.class === "OK") return { label: "OK", variant: "default" };
  if (WARNING_CLASSES.has(d.last.class)) return { label: d.last.class, variant: "secondary" };
  return { label: d.last.class, variant: "destructive" };
}

// Scores come from Argo's own measurements (tools/argo/netscore.go); every lost privacy point is listed.
function NetCell({ net }: { net: MeshNet }) {
  const privacyVariant = net.privacy < 0 ? "outline" : net.privacy >= 80 ? "default" : net.privacy >= 50 ? "secondary" : "destructive";
  const snr = net.rssi !== undefined && net.noise !== undefined ? ` (SNR ${net.rssi - net.noise} dB)` : "";
  return (
    <div className="space-y-1 text-xs">
      <Badge variant={privacyVariant}>{net.privacy < 0 ? "Privacy not measured" : `Privacy ${net.privacy}/100`}</Badge>
      {net.privacyWhy.length > 0 && (
        <ul className="max-w-xs text-muted-foreground">
          {net.privacyWhy.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <p>
        Speed {net.speed}
        {net.rttMs >= 0 ? ` (${net.rttMs} ms)` : ""}
      </p>
      <p>
        Signal {net.signal}
        {snr}
      </p>
    </div>
  );
}

function ago(iso?: string) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

const MeshDashboard = () => {
  useDocumentTitle("Mesh");

  const { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error, stopped, enroll, revoke } = useMesh();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const issuedDevice = issued ? devices?.find((d) => d.name === issued.name) : undefined;
  const command = issued ? enrollCommand(window.location, issued.name) : null;

  const onCopy = async (token: string) => {
    if ((await copyText(token, navigator.clipboard)) === "copied") {
      setCopyNote("Copied.");
      return;
    }
    // Plain-http tailnet pages have no clipboard API: select it for the person to copy.
    tokenRef.current?.focus();
    tokenRef.current?.select();
    setCopyNote("Selected: press ⌘C (or Ctrl+C) to copy.");
  };

  const onEnroll = async () => {
    setEnrollError(null);
    try {
      const token = await enroll(name.trim().toLowerCase());
      setIssued({ name: name.trim().toLowerCase(), token });
      setCopyNote(null);
      setName("");
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : "Enrollment failed");
    }
  };

  const [revokeError, setRevokeError] = useState<string | null>(null);

  const onRevoke = async (deviceName: string) => {
    setRevokeError(null);
    try {
      await revoke(deviceName);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Couldn't revoke the device");
    }
  };

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="brand-label">00_MESH_NETWORK</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Team connectivity</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Each laptop runs Argo, which keeps Claude Code connected on hotspots and public Wi-Fi and reports a short status here over the
              tailnet. Exit traffic is only ever allowed through Malaysia or Singapore.
            </p>
          </div>
          <Button asChild variant="outline">
            {canSeeTeam ? <Link to="/operator">Back to operator console</Link> : <Link to="/">Live visualisation</Link>}
          </Button>
        </div>
      </section>

      <section className="grid gap-6 px-4 pb-10 sm:px-8 xl:grid-cols-[1.4fr_1fr]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{canSeeTeam ? "Team devices" : "Your devices"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canEnroll && !canSeeTeam && (
              <p className="text-sm text-muted-foreground">You see the devices you enrolled. Operators see the whole team.</p>
            )}
            {error && (
              <p className="text-sm text-destructive">
                {error}
                {stopped && " Updates are paused so the security monitor doesn't block your address; reload after signing in."}
              </p>
            )}
            {revokeError && (
              <p role="alert" className="text-sm text-destructive">
                {revokeError}
              </p>
            )}
            {canEnroll && devices && devices.length === 0 && (
              <p className="text-sm text-muted-foreground">No devices yet. Enroll this laptop below.</p>
            )}
            {canEnroll && devices && devices.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4">Device</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Exit</th>
                      <th className="py-2 pr-4">Tailscale</th>
                      <th className="py-2 pr-4">Network</th>
                      <th className="py-2 pr-4">Can host</th>
                      <th className="py-2 pr-4">Last report</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => {
                      const s = statusOf(d);
                      return (
                        <tr key={d.name} className="border-t border-border/60 align-top">
                          <td className="py-3 pr-4">
                            <span className="font-mono">{d.name}</span>
                            {(d.last?.platform || d.last?.battery) && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {d.last.platform ? PLATFORM_LABEL[d.last.platform] : ""}
                                {d.last.battery ? `${d.last.platform ? " · " : ""}${batteryLabel(d.last.battery)}` : ""}
                              </p>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <Badge variant={s.variant}>{s.label}</Badge>
                            {(!d.last || deviceStage(d, Date.now()) === "rejected") && (
                              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                                {STAGE_HELP[deviceStage(d, Date.now()) as keyof typeof STAGE_HELP]}
                              </p>
                            )}
                            {d.last && d.last.class !== "OK" && (
                              <p className="mt-1 max-w-xs text-xs text-muted-foreground">{CLASS_HELP[d.last.class] ?? d.last.reason}</p>
                            )}
                            {d.last?.breakerOpen && <p className="mt-1 text-xs text-destructive">Auto-fix paused; needs a person</p>}
                          </td>
                          <td className="py-3 pr-4">{d.last?.loc || "—"}</td>
                          <td className="py-3 pr-4">{d.last ? (d.last.tailscale ? d.last.exitNode || "on" : "off") : "—"}</td>
                          <td className="py-3 pr-4">
                            {d.last?.net ? <NetCell net={d.last.net} /> : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-3 pr-4">
                            <Badge variant={d.hosting === "agents" ? "default" : d.hosting === "light" ? "secondary" : "outline"}>
                              {d.last?.platform === "ios" || d.last?.platform === "android" ? "Phone: status only" : HOSTING_LABEL[d.hosting ?? "unknown"]}
                            </Badge>
                            {d.last?.host && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {d.last.host.ramGB} GB RAM · {d.last.host.diskFreeGB} GB free
                                {d.last.host.pressure && d.last.host.pressure !== "normal" ? ` · memory ${d.last.host.pressure}` : ""}
                              </p>
                            )}
                            {d.last?.guard && <p className="mt-1 text-xs text-muted-foreground">{guardLine(d.last.guard)}</p>}
                            {d.hostingWhy && d.hostingWhy.length > 0 && d.hosting !== "agents" && (
                              <ul className="mt-1 max-w-xs list-disc pl-4 text-xs text-muted-foreground">
                                {d.hostingWhy.map((w) => (
                                  <li key={w}>{w}</li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-muted-foreground">{ago(d.last?.receivedAt)}</td>
                          <td className="py-3 text-right">
                            {(canRevokeAny || d.owner === me) && (
                              <Button size="sm" variant="ghost" onClick={() => void onRevoke(d.name)}>
                                Revoke
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {canEnroll && (
              <div className="space-y-2 border-t border-border/60 pt-4">
                <p className="text-sm font-medium">Enroll a device</p>
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
                    <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{command?.command}</pre>
                    {command && !command.exact && (
                      <p className="text-xs text-muted-foreground">
                        Use this Gauss's tailnet name (open this page over the tailnet and the command fills it in). Argo refuses any other
                        address.
                      </p>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input ref={tokenRef} readOnly value={issued.token} aria-label="Device token" className="font-mono text-xs" />
                      <Button variant="outline" onClick={() => void onCopy(issued.token)}>
                        Copy
                      </Button>
                      <Button variant="ghost" onClick={() => setIssued(null)}>
                        Done
                      </Button>
                    </div>
                    {copyNote && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {copyNote}
                      </p>
                    )}
                    <p role="status" className="text-xs">
                      {issuedDevice?.last
                        ? `First report received: ${statusOf(issuedDevice).label}, can host: ${HOSTING_LABEL[issuedDevice.hosting ?? "unknown"]}. You can close this.`
                        : issuedDevice && deviceStage(issuedDevice, Date.now()) !== "waiting"
                          ? STAGE_HELP[deviceStage(issuedDevice, Date.now()) as keyof typeof STAGE_HELP]
                          : "Waiting for the first report from the device…"}
                    </p>
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
