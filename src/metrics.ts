import { Counter, Histogram, Registry } from "prom-client";
import type { Mode, Tier } from "./types.js";

export interface Decision {
  tenantId: string;
  tier: Tier;
  mode: Mode;
  outcome: "allowed" | "rejected" | "would_reject" | "error";
  durationSeconds: number;
}

export interface Metrics {
  registry: Registry;
  record(decision: Decision): void;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  const decisions = new Counter({
    name: "orders_rate_limit_decisions_total",
    help: "Rate-limit decisions by authenticated tenant (not request-supplied headers)",
    labelNames: ["tenant", "tier", "mode", "outcome"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "orders_rate_limit_duration_seconds",
    help: "Rate-limit middleware duration including Redis round trip",
    labelNames: ["mode"],
    buckets: [0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
    registers: [registry],
  });
  return {
    registry,
    record({ tenantId, tier, mode, outcome, durationSeconds }) {
      decisions.inc({ tenant: tenantId, tier, mode, outcome });
      duration.observe({ mode }, durationSeconds);
    },
  };
}
