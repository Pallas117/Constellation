/**
 * Release SBOM and third-party licence check (GAU-69): `npm run release:sbom`.
 *
 * Writes build/sbom/, to attach to the GitHub release (docs/RELEASE_CHECKLIST.md). Not build/release:
 * macOS disks are case-insensitive, and that is node-gyp's build/Release.
 *   sbom.cdx.json           CycloneDX 1.5 of the runtime npm dependencies (`npm sbom --omit dev`)
 *   sbom.argo.cdx.json      CycloneDX 1.5 of Gauss Argo (tools/argo): its Go toolchain and modules
 *   THIRD_PARTY_NOTICES.md  every third-party runtime package with its licence and LICENSE/NOTICE text
 *   licences.md             packages per licence class, and every finding
 * Same commit, same files: the timestamp is the commit time and the serial number derives from the SHA.
 * Exits 1 when a runtime dependency is strong copyleft, or has no recognised licence and no decision in
 * scripts/release/licence-review.json (each entry: the licence a person confirmed and where they saw it).
 * The project's own LICENSE is a founder decision (GAU-65) and is not chosen here.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyExpression, detectFromText, isLicenceFile, type LicenceClass } from "./licences.ts";

const root = path.resolve(import.meta.dirname, "../..");
const outDir = path.join(root, "build", "sbom");
const reviewPath = path.join(root, "scripts", "release", "licence-review.json");
const MAX_TEXT = 64 * 1024; // a licence file larger than this is cut, with a note

interface CdxLicence { license?: { id?: string; name?: string }; expression?: string }
interface CdxComponent {
  "bom-ref": string;
  type: string;
  name: string;
  version: string;
  purl?: string;
  licenses?: CdxLicence[];
  properties?: { name: string; value: string }[];
}
interface CdxBom {
  serialNumber?: string;
  metadata: { timestamp?: string; component?: Partial<CdxComponent> };
  components: CdxComponent[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
}
interface Review { licence: string; source: string; reviewedBy: string; date: string }

function run(cmd: string, args: string[], cwd = root): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}): ${r.stderr.trim().slice(-500)}`);
  return r.stdout;
}

// RFC 4122 shape (version 5 bits) from a hash, so the serial number is stable per commit.
function serialFor(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function declared(c: CdxComponent): string | undefined {
  const parts = (c.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name).filter(Boolean);
  return parts.length ? parts.join(" AND ") : undefined;
}

function licenceFiles(dir: string | undefined): { name: string; text: string }[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => isLicenceFile(n) && statSync(path.join(dir, n)).isFile())
    .sort()
    .map((name) => {
      const raw = readFileSync(path.join(dir, name), "utf8");
      return { name, text: raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}\n[cut at 64 KB; full text in the package]` : raw };
    });
}

// Shortest chain from the root, e.g. "@react-three/drei@9.122.0 > detect-gpu@5.0.70", for findings.
function chainTo(bom: CdxBom, target: string): string {
  const rootRef = bom.metadata.component?.["bom-ref"];
  const edges = new Map((bom.dependencies ?? []).map((d) => [d.ref, d.dependsOn ?? []]));
  const prev = new Map<string, string>();
  const queue = rootRef ? [rootRef] : [];
  while (queue.length) {
    const ref = queue.shift()!;
    if (ref === target) break;
    for (const next of edges.get(ref) ?? []) if (!prev.has(next) && next !== rootRef) { prev.set(next, ref); queue.push(next); }
  }
  const chain: string[] = [];
  for (let ref = prev.get(target); ref && ref !== rootRef; ref = prev.get(ref)) chain.unshift(ref);
  return chain.length ? `via ${chain.join(" > ")}` : "direct dependency";
}

interface Row { ref: string; licence: string; source: string; cls: LicenceClass; files: { name: string; text: string }[] }

function main(): number {
  const sha = run("git", ["rev-parse", "HEAD"]).trim();
  const dirty = run("git", ["status", "--porcelain"]).trim() !== "";
  const version = `${sha.slice(0, 7)}${dirty ? "-dirty" : ""}`;
  const timestamp = new Date(run("git", ["show", "-s", "--format=%cI", "HEAD"]).trim()).toISOString();
  if (dirty) console.warn("WARN: the working tree has changes; a release SBOM should come from a clean, tagged commit.");

  // npm: the runtime tree, as installed (run `npm ci` first so it matches the lockfile).
  const bom = JSON.parse(run("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev"])) as CdxBom;
  bom.serialNumber = serialFor(`${sha}:npm`);
  bom.metadata.timestamp = timestamp;
  if (bom.metadata.component) {
    // npm names the root after the checkout folder; the package name is the old scaffold's.
    bom.metadata.component.name = "gauss-aurora";
    bom.metadata.component.version = version;
    delete bom.metadata.component.purl;
  }
  const dirs = new Map<string, string>();
  for (const p of JSON.parse(run("npm", ["query", ".prod"])) as { _id?: string; path?: string }[]) {
    if (p._id && p.path && !dirs.has(p._id)) dirs.set(p._id, p.path);
  }

  const review = (existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")).packages : {}) as Record<string, Review>;
  const rows: Row[] = [];
  const firstParty: string[] = [];
  for (const c of bom.components) {
    const ref = c["bom-ref"];
    // A private package can't come from the registry, so it is one of our workspaces (backend, frontend, ml).
    if (c.properties?.some((p) => p.name === "cdx:npm:package:private" && p.value === "true")) { firstParty.push(ref); continue; }
    const files = licenceFiles(dirs.get(ref));
    let licence = declared(c);
    let source = "package.json";
    if (!licence) {
      const found = files.map((f) => detectFromText(f.text)).find(Boolean);
      if (found) { licence = found; source = `detected from ${files[0].name}`; }
    }
    if (classifyExpression(licence) === "unknown" && review[ref]) {
      licence = review[ref].licence;
      source = `reviewed: ${review[ref].source} (${review[ref].reviewedBy}, ${review[ref].date})`;
    }
    rows.push({ ref, licence: licence ?? "none declared", source, cls: classifyExpression(licence), files });
  }
  rows.sort((a, b) => a.ref.localeCompare(b.ref));

  // Go: Argo builds with the standard library only today; list modules anyway so a new one shows up.
  const argoDir = path.join(root, "tools", "argo");
  const goVersion = run("go", ["env", "GOVERSION"], argoDir).trim();
  const goModules = run("go", ["list", "-m", "-json", "all"], argoDir)
    .split(/\n(?=\{)/)
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s) as { Path: string; Version?: string; Main?: boolean; Dir?: string })
    .filter((m) => !m.Main);
  const goRows: Row[] = goModules.map((m) => {
    const files = licenceFiles(m.Dir);
    const licence = files.map((f) => detectFromText(f.text)).find(Boolean);
    return { ref: `${m.Path}@${m.Version}`, licence: licence ?? "none found", source: licence ? `detected from ${files[0].name}` : "no licence file", cls: classifyExpression(licence), files };
  });
  const argoBom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serialFor(`${sha}:argo`),
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: "Lightbound", name: "scripts/release/sbom.ts" }],
      component: { "bom-ref": "gauss-argo", type: "application", name: "gauss-argo", version },
    },
    components: [
      // The Go standard library is compiled into the binary; Go is BSD-3-Clause (go.dev/LICENSE).
      { "bom-ref": `golang-std@${goVersion}`, type: "library", name: "std", version: goVersion, purl: `pkg:golang/std@${goVersion.replace(/^go/, "v")}`, licenses: [{ license: { id: "BSD-3-Clause" } }] },
      ...goRows.map((r) => {
        const [name, ver] = [r.ref.slice(0, r.ref.lastIndexOf("@")), r.ref.slice(r.ref.lastIndexOf("@") + 1)];
        return { "bom-ref": r.ref, type: "library", name, version: ver, purl: `pkg:golang/${name}@${ver}`, ...(r.cls === "unknown" ? {} : { licenses: [{ license: { id: r.licence } }] }) };
      }),
    ],
  };

  const all = [...rows, ...goRows];
  const failures = all.filter((r) => r.cls === "strong-copyleft" || r.cls === "unknown");
  const warnings = all.filter((r) => r.cls === "weak-copyleft");
  const count = (cls: LicenceClass) => all.filter((r) => r.cls === cls).length;
  const finding = (r: Row) => `- ${r.ref}: ${r.licence} (${r.source}); ${goRows.includes(r) ? "Go module of tools/argo" : chainTo(bom, r.ref)}`;

  const summary = [
    `# Third-party licences: gauss-aurora ${version}`,
    "",
    `Generated by \`npm run release:sbom\` from commit ${sha} (${timestamp}).`,
    `Runtime npm packages: ${rows.length} third-party (first-party workspaces not counted: ${firstParty.join(", ") || "none"}).`,
    `Gauss Argo: Go ${goVersion} standard library (BSD-3-Clause)${goRows.length ? ` and ${goRows.length} module(s)` : ", no third-party modules"}.`,
    "Dev-only tooling (build, test, lint) is not shipped and not listed. Fonts, images and data files are not npm packages and are not covered.",
    "",
    "| Class | Packages |",
    "| --- | --- |",
    ...(["permissive", "weak-copyleft", "strong-copyleft", "unknown"] as LicenceClass[]).map((c) => `| ${c} | ${count(c)} |`),
    "",
    "## Must be resolved before release (strong copyleft, or no recognised licence)",
    "",
    ...(failures.length ? failures.map(finding) : ["None."]),
    "",
    "## Weak copyleft (ship unmodified; share changes to those files)",
    "",
    ...(warnings.length ? warnings.map(finding) : ["None."]),
    "",
    "## Licence per package",
    "",
    "| Package | Licence | Source |",
    "| --- | --- | --- |",
    ...all.map((r) => `| ${r.ref} | ${r.licence} | ${r.source} |`),
    "",
  ].join("\n");

  const notices = [
    `# Third-party notices: gauss-aurora ${version}`,
    "",
    "Gauss Aurora includes the open-source packages below. Each is listed with its licence and the licence or",
    "notice text it ships with. Generated by `npm run release:sbom`.",
    "",
    ...all.flatMap((r) => [
      `## ${r.ref}`,
      "",
      `Licence: ${r.licence}`,
      "",
      ...(r.files.length
        ? r.files.flatMap((f) => [`${f.name}:`, "", "```text", f.text.trimEnd().replace(/```/g, "'''"), "```", ""])
        : ["(No licence file in the package; the licence above is as declared.)", ""]),
    ]),
  ].join("\n");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "sbom.cdx.json"), `${JSON.stringify(bom, null, 2)}\n`);
  writeFileSync(path.join(outDir, "sbom.argo.cdx.json"), `${JSON.stringify(argoBom, null, 2)}\n`);
  writeFileSync(path.join(outDir, "licences.md"), summary);
  writeFileSync(path.join(outDir, "THIRD_PARTY_NOTICES.md"), notices);

  console.log(`SBOM: ${bom.components.length} npm components, Argo: Go ${goVersion} + ${goRows.length} module(s). Written to ${path.relative(root, outDir)}/`);
  console.log(`Licences: ${count("permissive")} permissive, ${count("weak-copyleft")} weak copyleft, ${count("strong-copyleft")} strong copyleft, ${count("unknown")} unknown`);
  // A licence read from a file rather than declared is a guess a person should glance at: show its opening.
  for (const r of all.filter((r) => r.source.startsWith("detected"))) {
    const opening = r.files[0].text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" / ");
    console.log(`NOTE ${r.ref}: no licence declared; ${r.source} as ${r.licence}: "${opening.slice(0, 120)}"`);
  }
  for (const r of warnings) console.log(`WARN ${finding(r).slice(2)}`);
  for (const r of failures) console.log(`FAIL ${finding(r).slice(2)}`);
  if (failures.length) {
    console.log(`\n${failures.length} package(s) need a decision: replace them, or record the licence a person confirmed in ${path.relative(root, reviewPath)}.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
