import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PilotRequestDialog } from "@/components/PilotRequestDialog";
import { BACKEND_URL, commerceApi, type Org, type Usage } from "@/lib/api/commerce";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function OrgKeys({ org, onChange }: { org: Org; onChange: () => void }) {
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    commerceApi.usage(org.id).then(setUsage).catch(() => setUsage(null));
  }, [org.id, org.keys.length]);

  const create = async () => {
    setError(null);
    try {
      const { key } = await commerceApi.createKey(org.id, name.trim() || "API key");
      setIssued(key);
      setName("");
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create key");
    }
  };

  const revoke = async (keyId: string) => {
    setError(null);
    try {
      await commerceApi.revokeKey(org.id, keyId);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke key");
    }
  };

  const byEndpoint = new Map<string, number>();
  for (const r of usage?.rows ?? []) byEndpoint.set(r.endpoint, (byEndpoint.get(r.endpoint) ?? 0) + r.count);
  const active = org.keys.filter((k) => !k.revokedAt);

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{org.name}</CardTitle>
        <Badge variant={org.limits.api ? "default" : "outline"} className="uppercase">
          {org.plan}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {org.limits.api ? (
          <p className="text-sm text-muted-foreground">
            {org.limits.requestsPerMinute} requests/minute per key · {org.limits.requestsPerDay.toLocaleString()} requests/day for the
            organisation · up to {Math.round(org.limits.maxLookbackMs / 3_600_000)}h of history per request
          </p>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>The {org.plan} plan doesn't include API access.</p>
            <PilotRequestDialog interest="data-api">
              <Button size="sm" variant="outline">
                Request a pilot
              </Button>
            </PilotRequestDialog>
          </div>
        )}

        {org.keys.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Key</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Last used</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {org.keys.map((k) => (
                  <tr key={k.id} className="border-t border-border/60">
                    <td className="py-2 pr-4">{k.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{k.prefix}_…</td>
                    <td className="py-2 pr-4 text-muted-foreground">{fmt(k.createdAt)}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{fmt(k.lastUsedAt)}</td>
                    <td className="py-2 text-right">
                      {k.revokedAt ? (
                        <Badge variant="outline">Revoked</Badge>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => void revoke(k.id)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {org.limits.api && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-sm font-medium">Create a key</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input placeholder="what it's for, e.g. ground-station ingest" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              <Button onClick={() => void create()}>Create key</Button>
            </div>
            {issued && (
              <div className="space-y-2 rounded-md border border-primary/40 p-3 text-sm">
                <p>This key is shown once. Store it in your secret manager; Gauss keeps only a hash.</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input readOnly value={issued} className="font-mono text-xs" />
                  <Button variant="outline" onClick={() => void navigator.clipboard.writeText(issued)}>
                    Copy
                  </Button>
                  <Button variant="ghost" onClick={() => setIssued(null)}>
                    Done
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{`curl -H "Authorization: Bearer $GAUSS_API_KEY" \\
  ${BACKEND_URL}/api/v1/data/space-weather/latest`}</pre>
              </div>
            )}
          </div>
        )}

        {usage && (
          <div className="space-y-1 border-t border-border/60 pt-4 text-sm">
            <p className="font-medium">
              Usage {usage.from} to {usage.to}: {usage.total.toLocaleString()} requests
              {active.length === 0 && org.limits.api ? " · no active keys" : ""}
            </p>
            {[...byEndpoint].map(([endpoint, n]) => (
              <p key={endpoint} className="font-mono text-xs text-muted-foreground">
                {n.toLocaleString().padStart(8)} {endpoint}
              </p>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** API keys and usage for the organisations the signed-in user belongs to. */
const ApiKeys = () => {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    commerceApi
      .myOrgs()
      .then((o) => {
        setOrgs(o);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load organisations"));
  }, []);
  useEffect(load, [load]);

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-primary/80">Data API</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">API keys</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Keys let your systems read Gauss's refined feeds from <span className="font-mono">/api/v1/data</span>. Every call is counted
              for your organisation's usage report.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/">Live visualisation</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 px-4 pb-10 sm:px-8 xl:grid-cols-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {orgs && orgs.length === 0 && (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>No organisation yet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>API access comes with a Fleet Integration pilot. Once your organisation is set up, its keys appear here.</p>
              <PilotRequestDialog interest="data-api">
                <Button>Request a pilot</Button>
              </PilotRequestDialog>
            </CardContent>
          </Card>
        )}
        {orgs?.map((org) => <OrgKeys key={org.id} org={org} onChange={load} />)}
      </section>
    </main>
  );
};

export default ApiKeys;
