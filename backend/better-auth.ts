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
    }
});
