import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { validateLimits, type PlanLimits } from "./config.js";
import type { Metrics } from "./metrics.js";
import type { Logger, Mode, RedisStore } from "./types.js";

// Redis TIME and a discrete refill preserve the strict 60-per-minute criterion.
// Both keys share a cluster hash slot; negative tokens preserve usage on a limit decrease.
export const TOKEN_BUCKET_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])
local minute = math.floor(now / 60)
local capacity = tonumber(redis.call('GET', KEYS[2]) or ARGV[1])
local state = redis.call('HMGET', KEYS[1], 'minute', 'tokens', 'capacity')
local tokens = capacity
if tonumber(state[1]) == minute then
  tokens = math.min(capacity, tonumber(state[2]) + capacity - tonumber(state[3]))
end
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'minute', minute, 'tokens', tokens, 'capacity', capacity)
redis.call('EXPIRE', KEYS[1], 120)
local reset = (minute + 1) * 60
return {allowed, capacity, math.max(0, tokens), reset - now, reset}
`;

export function tenantKeys(tenantId: string): { bucket: string; override: string; orders: string } {
  const tag = createHash("sha256").update(tenantId).digest("hex");
  const prefix = `orders:{${tag}}`;
  return { bucket: `${prefix}:bucket`, override: `${prefix}:limit`, orders: `${prefix}:orders` };
}

export interface BucketDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtEpochSeconds: number;
}

export async function consume(store: RedisStore, tenantId: string, limit: number): Promise<BucketDecision> {
  const keys = tenantKeys(tenantId);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    // The Redis client's command timeout only bounds time waiting to be written.
    result = await Promise.race([
      store.eval(TOKEN_BUCKET_SCRIPT, { keys: [keys.bucket, keys.override], arguments: [String(limit)] }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Redis token-bucket decision timed out after 200 ms")), 200);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  if (
    !Array.isArray(result) || result.length !== 5 ||
    !result.every((value: unknown) => typeof value === "number" && Number.isSafeInteger(value)) ||
    (result[0] !== 0 && result[0] !== 1) ||
    result[1] < 1 || result[1] > 1_000_000 ||
    result[2] < 0 || result[2] > result[1] ||
    result[3] < 1 || result[3] > 60 ||
    result[4] < 1 || result[4] % 60 !== 0
  ) {
    throw new Error("Redis returned an invalid token-bucket decision");
  }
  return {
    allowed: result[0] === 1, limit: result[1], remaining: result[2],
    retryAfterSeconds: result[3], resetAtEpochSeconds: result[4],
  };
}

export function rateLimit(options: {
  store: RedisStore;
  mode: Mode;
  limits: PlanLimits;
  metrics: Metrics;
  logger: Logger;
}): RequestHandler {
  const { store, mode, limits, metrics, logger } = options;
  validateLimits(mode, limits);
  return async (_req, res, next) => {
    const principal = res.locals.principal;
    if (mode === "off" || principal?.kind === "service") {
      next();
      return;
    }
    if (!principal || principal.kind !== "tenant") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Authenticated tenant identity required" } });
      return;
    }
    const started = performance.now();
    const labels = { tenantId: principal.tenantId, tier: principal.tier, mode };
    const record = (outcome: Parameters<Metrics["record"]>[0]["outcome"]) => {
      metrics.record({ ...labels, outcome, durationSeconds: (performance.now() - started) / 1000 });
    };
    let decision: BucketDecision;
    try {
      const limit = limits[principal.tier];
      if (limit === undefined) throw new Error(`Missing rate limit for ${principal.tier}`);
      decision = await consume(store, principal.tenantId, limit);
    } catch (error) {
      logger.error({ event: "rate_limit_unavailable", ...labels, error: error instanceof Error ? error.message : String(error) });
      record("error");
      if (mode === "log-only") {
        next();
      } else {
        res.set("Retry-After", "5").status(503).json({
          error: { code: "RATE_LIMIT_UNAVAILABLE", message: "Rate limiting is temporarily unavailable", retryAfterSeconds: 5 },
        });
      }
      return;
    }
    res.set({
      "RateLimit-Limit": String(decision.limit),
      "RateLimit-Remaining": String(decision.remaining),
      "RateLimit-Reset": String(decision.retryAfterSeconds),
      "X-RateLimit-Limit": String(decision.limit),
      "X-RateLimit-Remaining": String(decision.remaining),
      "X-RateLimit-Reset": String(decision.resetAtEpochSeconds),
    });
    if (!decision.allowed && mode === "enforce") {
      record("rejected");
      res.set("Retry-After", String(decision.retryAfterSeconds)).status(429).json({
        error: { code: "RATE_LIMIT_EXCEEDED", message: "Tenant request limit exceeded", retryAfterSeconds: decision.retryAfterSeconds },
      });
      return;
    }
    if (!decision.allowed) logger.info({ event: "rate_limit_would_reject", ...labels, limit: decision.limit });
    record(decision.allowed ? "allowed" : "would_reject");
    next();
  };
}
