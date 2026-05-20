import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, "../../data/bedrock");
const TELEMETRY_FILE = path.join(DATA_DIR, "telemetry.jsonl");

export class BedrockDB {
  private initialized = false;

  private async ensureDir() {
    if (this.initialized) return;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      this.initialized = true;
    } catch (err) {
      console.error("[Bedrock] Failed to create data directory", err);
    }
  }

  public async appendTelemetry(data: any) {
    await this.ensureDir();
    const line = JSON.stringify(data) + "\n";
    try {
      await fs.appendFile(TELEMETRY_FILE, line, "utf8");
    } catch (err) {
      console.error("[Bedrock] Append failed", err);
    }
  }

  public async getRecent(limit: number = 200): Promise<any[]> {
    await this.ensureDir();
    try {
      const content = await fs.readFile(TELEMETRY_FILE, "utf8");
      const lines = content.trim().split("\n");
      return lines
        .slice(Math.max(0, lines.length - limit))
        .map((line) => JSON.parse(line));
    } catch (err) {
      // File might not exist yet
      return [];
    }
  }

  public async clearOld(keepLines: number = 5000) {
    await this.ensureDir();
    try {
      const content = await fs.readFile(TELEMETRY_FILE, "utf8");
      const lines = content.trim().split("\n");
      if (lines.length > keepLines) {
        const remaining = lines.slice(lines.length - keepLines).join("\n") + "\n";
        await fs.writeFile(TELEMETRY_FILE, remaining, "utf8");
      }
    } catch (err) {
      // Ignore
    }
  }
}

export const bedrock = new BedrockDB();
