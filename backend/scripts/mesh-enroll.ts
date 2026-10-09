// Usage: npm run -s mesh:enroll -- <device-name> | argo enroll <gauss-url> <device-name>
// Prints only the one-time device token on stdout so it can be piped straight
// into `argo enroll` without appearing on screen or in shell history.
import path from "node:path";
import { MeshStore } from "../mesh/store.js";

const name = (process.argv[2] ?? "").trim().toLowerCase();
const store = new MeshStore(path.resolve(process.env.MESH_STORE_PATH ?? "data/mesh/devices.json"));
const result = store.enroll(name, "local-cli");
if ("error" in result) {
  console.error(`mesh:enroll: ${result.error}`);
  process.exit(1);
}
process.stdout.write(`${result.token}\n`);
