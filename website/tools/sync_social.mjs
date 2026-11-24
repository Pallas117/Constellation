// Writes the follow strip and the share links from worker/social.js into the static pages, so they need no
// Worker run and no script. Run after changing the list:  npm run site:social
// A page takes part by carrying the markers: <!--follow--><!--/follow--> (footer), <!--follow-cta--><!--/follow-cta-->
// and <!--share--><!--/share-->. website/test/site.test.mjs fails if a page is out of date.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFollow, renderFollowCta, renderShare } from "../worker/social.js";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const block = (html, name, body) => html.replace(new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`, "g"), () => `<!--${name}-->${body}<!--/${name}-->`);

for (const file of walk(pub).filter((f) => f.endsWith(".html"))) {
  const before = readFileSync(file, "utf8");
  const route = `/${relative(pub, file).replace(/index\.html$/, "")}`;
  let html = block(before, "follow", renderFollow());
  html = block(html, "follow-cta", renderFollowCta());
  html = block(html, "share", renderShare(route));
  if (html !== before) {
    writeFileSync(file, html);
    console.log(`updated ${route}`);
  }
}
