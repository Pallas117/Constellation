import assert from "node:assert/strict";
import test from "node:test";
import { classifyExpression, classifyId, detectFromText, isLicenceFile } from "../../scripts/release/licences.ts";

test("licence ids: permissive, weak and strong copyleft, unknown", () => {
  for (const id of ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "0BSD", "CC0-1.0", "mit"]) assert.equal(classifyId(id), "permissive", id);
  for (const id of ["LGPL-2.1-or-later", "MPL-2.0", "EPL-2.0", "CDDL-1.0", "OFL-1.1"]) assert.equal(classifyId(id), "weak-copyleft", id);
  for (const id of ["GPL-3.0-only", "GPL-2.0+", "AGPL-3.0", "SSPL-1.0", "EUPL-1.2"]) assert.equal(classifyId(id), "strong-copyleft", id);
  // BUSL is not open source; "BSD" alone doesn't say which BSD; a custom text needs reading
  for (const id of ["BUSL-1.1", "BSD", "SEE LICENSE IN LICENSE", "UNLICENSED"]) assert.equal(classifyId(id), "unknown", id);
});

test("expressions: OR takes the licensee's best choice, AND the most restrictive", () => {
  assert.equal(classifyExpression("(MIT OR GPL-3.0-only)"), "permissive");
  assert.equal(classifyExpression("MIT or Apache-2.0"), "permissive");
  assert.equal(classifyExpression("(BSD-2-Clause OR MIT OR Apache-2.0)"), "permissive");
  assert.equal(classifyExpression("MIT AND ISC"), "permissive");
  assert.equal(classifyExpression("MIT AND GPL-3.0-only"), "strong-copyleft");
  assert.equal(classifyExpression("(MIT OR LGPL-2.1-only) AND GPL-2.0-only"), "strong-copyleft");
  assert.equal(classifyExpression("(MIT OR LGPL-2.1-only) AND (MPL-2.0 OR GPL-2.0-only)"), "weak-copyleft");
  assert.equal(classifyExpression("((MIT))"), "permissive");
  assert.equal(classifyExpression("(MIT) OR (GPL-2.0-only)"), "permissive");
  assert.equal(classifyExpression("Apache-2.0 WITH LLVM-exception"), "permissive");
});

test("no licence at all is unknown, never permissive", () => {
  assert.equal(classifyExpression(undefined), "unknown");
  assert.equal(classifyExpression(""), "unknown");
  assert.equal(classifyExpression("  "), "unknown");
});

test("licence texts are recognised only when they are the standard text", () => {
  assert.equal(detectFromText("MIT License\n\nCopyright (c) 2019 A\n\nPermission is hereby granted, free of charge, to any person"), "MIT");
  const isc = "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted";
  assert.equal(detectFromText(`${isc}, provided that the above copyright notice and this permission notice appear in all copies.`), "ISC");
  assert.equal(detectFromText(`${isc}.\n\nTHE SOFTWARE IS PROVIDED "AS IS"`), "0BSD");
  const bsd = "Redistribution and use in source and binary forms, with or without modification, are permitted";
  assert.equal(detectFromText(`${bsd} provided that ...`), "BSD-2-Clause");
  assert.equal(detectFromText(`${bsd} ... 3. Neither the name of the copyright holder`), "BSD-3-Clause");
  assert.equal(detectFromText("Apache License\n Version 2.0, January 2004"), "Apache-2.0");
  assert.equal(detectFromText("GNU GENERAL PUBLIC LICENSE\n Version 2, June 1991"), "GPL-2.0");
  assert.equal(detectFromText("GNU LESSER GENERAL PUBLIC LICENSE\n Version 2.1, February 1999"), "LGPL-2.1");
  assert.equal(detectFromText("GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007"), "AGPL-3.0");
  assert.equal(detectFromText("Mozilla Public License Version 2.0"), "MPL-2.0");
  assert.equal(detectFromText("All rights reserved. Do not copy."), undefined);
  // the detected id goes through the same rules: a GPL text is strong copyleft
  assert.equal(classifyExpression(detectFromText("GNU GENERAL PUBLIC LICENSE Version 3")), "strong-copyleft");
});

test("licence and notice files are picked out by name", () => {
  for (const n of ["LICENSE", "LICENCE.md", "license-mit.txt", "LICENSE-APACHE", "COPYING", "NOTICE", "notice.txt"]) assert.ok(isLicenceFile(n), n);
  for (const n of ["licenses.js", "noticeboard.js", "README.md", "package.json"]) assert.ok(!isLicenceFile(n), n);
});
