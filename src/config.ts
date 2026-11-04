import { z } from "zod";
import type { Mode, Principal, Tier } from "./types.js";

export const tenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const limitSchema = z.number().int().min(1).max(1_000_000);
export const modeSchema = z.enum(["off", "log-only", "enforce"]);
const redisUrlSchema = z.url().refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), "Use redis:// or rediss://");

const principalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tenant"), tenantId: tenantIdSchema, tier: z.enum(["free", "pro", "enterprise"]) }).strict(),
  z.object({ kind: z.literal("service"), tenantId: tenantIdSchema }).strict(),
  z.object({ kind: z.literal("admin") }).strict(),
]);
const keysSchema = z.array(z.object({
  key: z.string().min(32),
  principal: principalSchema,
}).strict()).min(1);

export type PlanLimits = { free: 60; pro?: number; enterprise?: number };
export interface Config {
  redisUrl: string;
  clusterRoots?: string[];
  port: number;
  mode: Mode;
  limits: PlanLimits;
  apiKeys: { key: string; principal: Principal }[];
}

function optionalLimit(value: string | undefined): number | undefined {
  return value === undefined || value === "" ? undefined : limitSchema.parse(Number(value));
}

export function validateLimits(mode: Mode, limits: PlanLimits): void {
  if (limits.free !== 60) throw new Error("The Free plan limit must be 60 requests per minute");
  for (const tier of ["pro", "enterprise"] as const) {
    if (limits[tier] !== undefined) limitSchema.parse(limits[tier]);
    if (mode !== "off" && limits[tier] === undefined) {
      throw new Error(`${tier} limit must be configured from the approved plan table before enabling rate limiting`);
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const mode = modeSchema.parse(env.RATE_LIMIT_MODE ?? "off");
  const limits: PlanLimits = {
    free: 60,
    pro: optionalLimit(env.PRO_RATE_LIMIT),
    enterprise: optionalLimit(env.ENTERPRISE_RATE_LIMIT),
  };
  validateLimits(mode, limits);
  const apiKeys = keysSchema.parse(JSON.parse(env.API_KEYS ?? "[]") as unknown);
  if (new Set(apiKeys.map(({ key }) => key)).size !== apiKeys.length) {
    throw new Error("API keys must be unique");
  }
  const tenantPlans = new Map<string, Tier>();
  for (const { principal } of apiKeys) {
    if (principal.kind !== "tenant") continue;
    const previous = tenantPlans.get(principal.tenantId);
    if (previous !== undefined && previous !== principal.tier) {
      throw new Error("All keys for a tenant must use the same plan tier");
    }
    tenantPlans.set(principal.tenantId, principal.tier);
  }
  return {
    redisUrl: redisUrlSchema.parse(env.REDIS_URL ?? "redis://127.0.0.1:6379"),
    clusterRoots: env.REDIS_CLUSTER_ROOTS
      ? z.array(redisUrlSchema).min(1).parse(JSON.parse(env.REDIS_CLUSTER_ROOTS) as unknown)
      : undefined,
    port: z.coerce.number().int().min(0).max(65535).parse(env.PORT ?? "3000"),
    mode,
    limits,
    apiKeys,
  };
}
