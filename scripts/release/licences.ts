/**
 * Licence classification for the release SBOM (GAU-69). Pure functions; sbom.ts does the I/O.
 *
 * A customer's procurement or security review asks whether any shipped dependency puts copyleft or
 * unknown terms on the product, so each SPDX expression is reduced to one class:
 *   permissive       keep the notice and that's it (MIT, BSD, Apache-2.0, ISC, ...)
 *   weak-copyleft    file- or library-level copyleft (LGPL, MPL, EPL, CDDL): fine to ship unmodified,
 *                    but changes to those files must be shared. Listed, not failed.
 *   strong-copyleft  GPL, AGPL, SSPL, EUPL, OSL: would bind the whole product. Fails the check.
 *   unknown          no licence, a custom text, or an id not listed here: a person has to read it.
 * "A OR B" takes the most permissive choice (the licensee picks); "A AND B" the most restrictive.
 */
export type LicenceClass = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown";

const RANK: Record<LicenceClass, number> = { permissive: 0, "weak-copyleft": 1, unknown: 2, "strong-copyleft": 3 };

// SPDX ids seen in npm/Go trees that only ask for the notice to be kept. BSL-1.0 is Boost, not the
// Business Source License (BUSL-1.1, which is not open source and stays unknown).
const PERMISSIVE = new Set(
  [
    "0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "CC-BY-3.0", "CC-BY-4.0",
    "CC0-1.0", "ISC", "MIT", "MIT-0", "Python-2.0", "Unlicense", "WTFPL", "Zlib",
  ].map((id) => id.toLowerCase()),
);
// OFL (SIL Open Font License, the self-hosted fonts): copyleft on the font files only; the software
// they ship with may use any licence.
const WEAK = /^(LGPL|MPL|EPL|CDDL|CPL|MS-RL|OFL)-/i;
const STRONG = /^(GPL|AGPL|SSPL|EUPL|OSL|RPL|CPAL)-/i;

export function classifyId(id: string): LicenceClass {
  const bare = id.trim().replace(/\+$/, "");
  if (PERMISSIVE.has(bare.toLowerCase())) return "permissive";
  if (STRONG.test(bare)) return "strong-copyleft";
  if (WEAK.test(bare)) return "weak-copyleft";
  return "unknown";
}

// Drop parentheses that wrap the whole expression: "(MIT OR Apache-2.0)" -> "MIT OR Apache-2.0".
function stripParens(e: string): string {
  let s = e.trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      if (depth === 0) { wraps = false; break; }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

// Split on a binary operator outside parentheses.
function splitTop(e: string, op: "OR" | "AND"): string[] {
  const parts: string[] = [];
  const sep = ` ${op} `;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "(") depth++;
    else if (e[i] === ")") depth--;
    else if (depth === 0 && e.slice(i, i + sep.length).toUpperCase() === sep) {
      parts.push(e.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(e.slice(start));
  return parts;
}

export function classifyExpression(expr: string | undefined): LicenceClass {
  const e = stripParens(expr ?? "");
  if (!e) return "unknown";
  const pick = (parts: string[], best: boolean) =>
    parts.map(classifyExpression).reduce((a, b) => ((RANK[b] < RANK[a]) === best ? b : a));
  const or = splitTop(e, "OR");
  if (or.length > 1) return pick(or, true);
  const and = splitTop(e, "AND");
  if (and.length > 1) return pick(and, false);
  return classifyId(e.replace(/\s+WITH\s+.*$/i, ""));
}

/**
 * The SPDX id a licence file's text identifies, for packages that ship a licence file but don't declare
 * one (and for Go modules, which never declare one). Only standard texts are recognised; anything else
 * returns undefined and stays unknown.
 */
export function detectFromText(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ");
  const gnuVersion = (/Version (\d(?:\.\d)?)/i.exec(t)?.[1] ?? "").replace(/^(\d)$/, "$1.0");
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return `AGPL-${gnuVersion || "3.0"}`;
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return `LGPL-${gnuVersion || "3.0"}`;
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return `GPL-${gnuVersion || "3.0"}`;
  if (/Mozilla Public License,? (?:Version|v\.?) ?2\.0/i.test(t)) return "MPL-2.0";
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) {
    return /provided that the above copyright notice/i.test(t) ? "ISC" : "0BSD";
  }
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  return undefined;
}

/** True for file names that carry licence terms or attribution a redistributor must pass on. */
export function isLicenceFile(name: string): boolean {
  return /^(licen[cs]e|copying|notice)([._-]|$)/i.test(name);
}
