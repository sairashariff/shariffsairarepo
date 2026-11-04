import { vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Logger, RedisStore } from "../src/types.js";

export const keys = {
  free: "free-test-key-".padEnd(32, "a"),
  other: "other-test-key-".padEnd(32, "b"),
  pro: "pro-test-key-".padEnd(32, "c"),
  enterprise: "enterprise-test-key-".padEnd(32, "d"),
  service: "service-test-key-".padEnd(32, "e"),
  admin: "admin-test-key-".padEnd(32, "f"),
};
export const config: Config = {
  redisUrl: "redis://127.0.0.1:16379",
  port: 0,
  mode: "enforce",
  // These are test fixtures, not proposed production Pro/Enterprise limits.
  limits: { free: 60, pro: 120, enterprise: 240 },
  apiKeys: [
    { key: keys.free, principal: { kind: "tenant", tenantId: "tenant-a", tier: "free" } },
    { key: keys.other, principal: { kind: "tenant", tenantId: "tenant-b", tier: "free" } },
    { key: keys.pro, principal: { kind: "tenant", tenantId: "tenant-pro", tier: "pro" } },
    { key: keys.enterprise, principal: { kind: "tenant", tenantId: "tenant-enterprise", tier: "enterprise" } },
    { key: keys.service, principal: { kind: "service", tenantId: "tenant-a" } },
    { key: keys.admin, principal: { kind: "admin" } },
  ],
};
export const bearer = (key = keys.free) => `Bearer ${key}`;
export const resetAtEpochSeconds = 1_800_000_000;
export function fakeStore(): RedisStore {
  return {
    eval: vi.fn<RedisStore["eval"]>().mockResolvedValue([1, 60, 59, 42, resetAtEpochSeconds]),
    set: vi.fn<RedisStore["set"]>().mockResolvedValue("OK"),
    del: vi.fn<RedisStore["del"]>().mockResolvedValue(1),
    hSet: vi.fn<RedisStore["hSet"]>().mockResolvedValue(1),
    hGet: vi.fn<RedisStore["hGet"]>().mockResolvedValue(null),
    hVals: vi.fn<RedisStore["hVals"]>().mockResolvedValue([]),
  };
}
export function fakeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() };
}
