// Copies the application forms from worker/forms.js into the static apply pages, so the pages work
// even before the Worker fills them. Run after changing a question:  npm run site:forms
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderApplyForm } from "../worker/forms.js";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
for (const kind of ["gauss", "constellation"]) {
  const file = join(pub, kind, "apply", "index.html");
  const html = readFileSync(file, "utf8").replace(/<!--live:apply-->[\s\S]*?<!--\/live:apply-->/, () => `<!--live:apply-->${renderApplyForm(kind)}<!--/live:apply-->`);
  writeFileSync(file, html);
  console.log(`updated ${kind}/apply/index.html`);
}
