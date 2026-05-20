import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ConnectivityMode = "CLOUD" | "SAT" | "AIRGAP";

export interface LinkStatus {
  mode: ConnectivityMode;
  latencyMs: number;
  lastChecked: string;
}

class LinkGuardian {
  private currentMode: ConnectivityMode = "CLOUD";
  private currentLatency: number = 0;
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly PING_HOST = "8.8.8.8"; // Standard DNS ping for general health
  private readonly SUPABASE_HOST = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : "supabase.co";

  constructor() {
    this.start();
  }

  public getStatus(): LinkStatus {
    return {
      mode: this.currentMode,
      latencyMs: this.currentLatency,
      lastChecked: new Date().toISOString(),
    };
  }

  private start() {
    this.check();
    this.checkInterval = setInterval(() => this.check(), 30000); // Check every 30s
  }

  private async check() {
    try {
      const start = Date.now();
      // Using ping -c 1 for macOS/Linux compatibility
      await execAsync(`ping -c 1 -W 2000 ${this.PING_HOST}`);
      this.currentLatency = Date.now() - start;

      if (this.currentLatency < 150) {
        this.currentMode = "CLOUD";
      } else {
        this.currentMode = "SAT";
      }
    } catch (error) {
      this.currentLatency = -1;
      this.currentMode = "AIRGAP";
    }

    console.log(`[LinkGuardian] Mode: ${this.currentMode}, Latency: ${this.currentLatency}ms`);
  }

  public stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}

export const linkGuardian = new LinkGuardian();
