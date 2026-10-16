import type { Request, Response } from "express";
import { ForecastNotConfiguredError, inferAnomalyForecast } from "./client.js";

// GET /api/forecast/anomaly (`user` role, backend/rbac.ts). With no model configured
// the forecast is unavailable (503); it is never generated locally.
export async function anomalyForecastRoute(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await inferAnomalyForecast([]));
  } catch (err) {
    if (err instanceof ForecastNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Forecast generation failed" });
  }
}
