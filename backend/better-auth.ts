import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize a local SQLite db for better-auth
const sqlite = new Database(path.join(__dirname, "../.auth.db"));

export const auth = betterAuth({
    database: sqlite,
    emailAndPassword: {  
        enabled: true
    },
    user: {
        additionalFields: {
            // input: false stops users choosing their own role at sign-up.
            // Change it with `npm run auth:set-role -- <email> <role>`.
            role: { type: "string", required: false, defaultValue: "viewer", input: false },
        },
    },
});
