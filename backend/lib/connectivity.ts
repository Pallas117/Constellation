import { exec } from "node:child_process";
import { promisify } from "node:util";

import { nextLinkState, type ConnectivityMode, type LinkState } from "./link-mode.js";

const execAsync = promisify(exec);

export type { ConnectivityMode };

export interface LinkStatus {
  mode: ConnectivityMode;
  latencyMs: number;
  lastChecked: string;
}

class LinkGuardian {
  private state: LinkState = { mode: "CLOUD", latencyMs: 0, failures: 0 };
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly PING_HOST = "8.8.8.8"; // Standard DNS ping for general health

  constructor() {
    this.start();
  }

  public getStatus(): LinkStatus {
    return {
      mode: this.state.mode,
      latencyMs: this.state.latencyMs,
      lastChecked: new Date().toISOString(),
    };
  }

  private start() {
    this.check();
    this.checkInterval = setInterval(() => this.check(), 30000); // Check every 30s
    // Don't keep the process alive just for link checks (lets importers like tests exit).
    this.checkInterval.unref();
  }

  private async check() {
    let latency: number | null;
    try {
      const start = Date.now();
      // Using ping -c 1 for macOS/Linux compatibility
      await execAsync(`ping -c 1 -W 2000 ${this.PING_HOST}`);
      latency = Date.now() - start;
    } catch {
      latency = null;
    }
    const prev = this.state.mode;
    this.state = nextLinkState(this.state, latency);
    // Only changes: one line per check was 57k of the live backend.log's 189k lines (4 Nov 2026).
    if (this.state.mode !== prev) console.log(`[LinkGuardian] Mode: ${prev} -> ${this.state.mode}, Latency: ${this.state.latencyMs}ms`);
  }

  public stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}

export const linkGuardian = new LinkGuardian();
