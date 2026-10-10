// Admin CLI for organisations, plans and usage (pilots are sales-led, so these
// stay out of the web UI for now).
//
//   npm run org -- list
//   npm run org -- create "<name>" <free|pilot|enterprise>
//   npm run org -- plan <org-id> <free|pilot|enterprise>
//   npm run org -- add-member <org-id> <email>      (they must have signed in once)
//   npm run org -- remove-member <org-id> <email>
//   npm run org -- usage <org-id> [YYYY-MM]          (for invoicing / pilot evidence)
//   npm run org -- leads                             ("Request a pilot" submissions)
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlan, PLANS } from "../commerce/plans.js";
import { CommerceStore } from "../commerce/store.js";

const store = new CommerceStore(path.resolve(process.env.COMMERCE_DB_PATH ?? "data/commerce/commerce.db"));
const [cmd, ...args] = process.argv.slice(2);

function userIdFor(email: string): string {
  const authDb = new Database(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.auth.db"), { readonly: true });
  const row = authDb.prepare("SELECT id FROM user WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
  if (!row) fail(`No user with email ${email}. They must sign in to Gauss once first.`);
  return row!.id;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function org(id: string) {
  return store.getOrg(id) ?? fail(`No organisation with id ${id}. See: npm run org -- list`);
}

switch (cmd) {
  case "list":
    for (const o of store.listOrgs()) console.log(`${o.id}  ${o.plan.padEnd(10)}  ${o.name}`);
    break;
  case "create": {
    const [name, plan] = args;
    if (!name || !isPlan(plan)) fail('Usage: npm run org -- create "<name>" <free|pilot|enterprise>');
    const created = store.createOrg(name, plan);
    console.log(`Created ${created.name} (${created.plan}): ${created.id}`);
    break;
  }
  case "plan": {
    const [id, plan] = args;
    if (!isPlan(plan)) fail("Usage: npm run org -- plan <org-id> <free|pilot|enterprise>");
    org(id);
    store.setPlan(id, plan);
    const limits = PLANS[plan];
    console.log(`${id} is now ${plan}: API ${limits.api ? `on, ${limits.requestsPerMinute}/min per key, ${limits.requestsPerDay}/day` : "off"}.`);
    break;
  }
  case "add-member":
  case "remove-member": {
    const [id, email] = args;
    if (!id || !email) fail(`Usage: npm run org -- ${cmd} <org-id> <email>`);
    const o = org(id);
    const userId = userIdFor(email);
    if (cmd === "add-member") store.addMember(o.id, userId);
    else store.removeMember(o.id, userId);
    console.log(`${email} ${cmd === "add-member" ? "added to" : "removed from"} ${o.name}.`);
    break;
  }
  case "usage": {
    const [id, month = new Date().toISOString().slice(0, 7)] = args;
    const o = org(id);
    if (!/^\d{4}-\d{2}$/.test(month)) fail("Month must be YYYY-MM");
    const rows = store.usage(o.id, `${month}-01`, `${month}-31`);
    const byEndpoint = new Map<string, number>();
    for (const r of rows) byEndpoint.set(r.endpoint, (byEndpoint.get(r.endpoint) ?? 0) + r.count);
    console.log(`${o.name} (${o.plan}) API usage for ${month}: ${rows.reduce((n, r) => n + r.count, 0)} requests`);
    for (const [endpoint, n] of [...byEndpoint].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(8)}  ${endpoint}`);
    break;
  }
  case "leads": {
    const leads = store.listPilotRequests();
    if (leads.length === 0) console.log("No pilot requests yet.");
    for (const l of leads) {
      console.log(`${l.createdAt.slice(0, 16).replace("T", " ")}  ${l.interest.padEnd(12)}  ${l.company} — ${l.name} <${l.email}>`);
      if (l.useCase) console.log(`    ${l.useCase.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    break;
  }
  default:
    fail("Usage: npm run org -- <list|create|plan|add-member|remove-member|usage|leads> …");
}
