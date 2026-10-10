import { NotebookLMClient } from './notebooklm-client.js';
import { GraphDBClient } from './graphdb-client.js';
import { linkGuardian } from '../lib/connectivity.js';

export interface ReasoningResult {
  answer: string;
  traces: string[];
  confidence: number;
}

export class AgenticReasoningEngine {
  // Retrieval clients for the grounded implementation; unused until it exists (GAU-96).
  private notebookApi: NotebookLMClient;
  private graphDb: GraphDBClient;

  constructor(notebookApi: NotebookLMClient, graphDb: GraphDBClient) {
    this.notebookApi = notebookApi;
    this.graphDb = graphDb;
  }

  async generateVerifiedTacticalResponse(query: string): Promise<ReasoningResult> {
    console.log(`[ReasoningEngine] FLARE / CoVe Loop starting for: "${query}"`);

    // No grounded retrieval exists yet: NotebookLMClient is a stub that returns canned
    // text, and GraphDBClient.traceAnomalyPath yields raw nodes/edges with no path or
    // confidence. Until both are real, the only honest answer is an explicit unknown,
    // whatever the link state. Never assemble a "verified" assessment from canned text
    // or invent a confidence (GAU-96).
    if (linkGuardian.getStatus().mode === "AIRGAP") {
      return this.seekDeepLensTruth(query);
    }
    return this.notGrounded();
  }

  /**
   * Online, but there is nothing real to ground an answer in yet, so the answer is an
   * explicit unknown rather than an assessment.
   */
  private notGrounded(): ReasoningResult {
    return {
      answer:
        "[NOT GROUNDED] Unable to assess: grounded retrieval (knowledge graph and document store) is not connected yet, so no answer can be grounded. Status is unknown, not nominal. Consult live telemetry directly.",
      traces: [],
      confidence: 0,
    };
  }

  /**
   * Offline: no retrieval or telemetry is available, so the only honest answer is an
   * explicit unknown. Canned assessments ("CRITICAL" or "nominal") with invented
   * confidence and citations must never stand in for analysis.
   */
  private seekDeepLensTruth(_query: string): ReasoningResult {
    return {
      answer:
        "[DEEPLENS OFFLINE] Unable to assess: knowledge retrieval is unreachable, so no answer can be grounded. Status is unknown, not nominal. Retry when the link is restored or consult live telemetry directly.",
      traces: [],
      confidence: 0,
    };
  }
}
