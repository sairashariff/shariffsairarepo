import { describe, expect, it } from "vitest";
import { loadConfig, validateLimits } from "../src/config.js";
import { config } from "./helpers.js";

const env = { API_KEYS: JSON.stringify(config.apiKeys) };

describe("configuration", () => {
  it("defaults to off and Free 60 without guessing paid tier limits", () => {
    expect(loadConfig(env)).toMatchObject({
      mode: "off", limits: { free: 60, pro: undefined, enterprise: undefined },
      port: 3000, redisUrl: "redis://127.0.0.1:6379",
    });
  });
  it.each(["log-only", "enforce"])("requires both approved paid limits in %s", (mode) => {
    expect(() => loadConfig({ ...env, RATE_LIMIT_MODE: mode })).toThrow("pro limit");
    expect(() => loadConfig({ ...env, RATE_LIMIT_MODE: mode, PRO_RATE_LIMIT: "120" })).toThrow("enterprise limit");
    expect(loadConfig({
      ...env, RATE_LIMIT_MODE: mode, PRO_RATE_LIMIT: "120", ENTERPRISE_RATE_LIMIT: "240",
      PORT: "4000", REDIS_URL: "redis://localhost:16379",
    })).toMatchObject({ mode, limits: { free: 60, pro: 120, enterprise: 240 }, port: 4000 });
  });
  it.each(["0", "-1", "1.5", "not-a-number", "1000001"])("rejects invalid limits: %s", (value) => {
    expect(() => loadConfig({ ...env, PRO_RATE_LIMIT: value })).toThrow();
  });
  it("treats blank paid limits as unconfigured", () => {
    expect(loadConfig({ ...env, PRO_RATE_LIMIT: "", ENTERPRISE_RATE_LIMIT: "" }).limits.pro).toBeUndefined();
  });
  it("accepts cluster seed nodes and rejects invalid cluster configuration", () => {
    expect(loadConfig({ ...env, REDIS_CLUSTER_ROOTS: '["redis://localhost:17001"]' }).clusterRoots)
      .toEqual(["redis://localhost:17001"]);
    for (const roots of ["[]", "invalid-json", '["https://example.com"]']) {
      expect(() => loadConfig({ ...env, REDIS_CLUSTER_ROOTS: roots })).toThrow();
    }
  });
  it.each([
    { RATE_LIMIT_MODE: "on" }, { PORT: "-1" }, { PORT: "65536" },
    { REDIS_URL: "bad-url" }, { REDIS_URL: "https://example.com" }, { API_KEYS: "bad-json" }, { API_KEYS: "[]" },
    { API_KEYS: JSON.stringify([{ key: "short", principal: { kind: "admin" } }]) },
  ])("rejects unsafe configuration %j", (values) => {
    expect(() => loadConfig({ ...env, ...values })).toThrow();
  });
  it("rejects duplicate keys and inconsistent plans for the same tenant", () => {
    expect(() => loadConfig({ API_KEYS: JSON.stringify([config.apiKeys[0], config.apiKeys[0]]) })).toThrow("unique");
    const first = config.apiKeys[0]!;
    expect(() => loadConfig({
      API_KEYS: JSON.stringify([first, { key: "z".repeat(32), principal: { kind: "tenant", tenantId: "tenant-a", tier: "pro" } }]),
    })).toThrow("same plan");
    expect(loadConfig({
      API_KEYS: JSON.stringify([first, { key: "z".repeat(32), principal: first.principal }]),
    }).apiKeys).toHaveLength(2);
  });
  it("rejects a mutated Free limit at the middleware boundary", () => {
    const limits = { ...config.limits };
    Reflect.set(limits, "free", 59);
    expect(() => validateLimits("off", limits)).toThrow("Free");
  });
});
