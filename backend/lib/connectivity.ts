import { exec } from "node:child_process";
import { promisify } from "node:util";

import { nextLinkState, pingCommand, PING_TIMEOUT_MS, type ConnectivityMode, type LinkState } from "./link-mode.js";

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
      // The -W unit differs by platform (link-mode.ts); the exec timeout is the backstop on any of them.
      await execAsync(pingCommand(this.PING_HOST), { timeout: PING_TIMEOUT_MS + 1000 });
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
