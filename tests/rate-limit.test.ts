import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createMetrics } from "../src/metrics.js";
import { consume, rateLimit, tenantKeys, TOKEN_BUCKET_SCRIPT } from "../src/rate-limit.js";
import { bearer, config, fakeLogger, fakeStore, keys } from "./helpers.js";

describe("token bucket adapter", () => {
  it("uses cluster-compatible, tenant-isolated keys and an atomic script", async () => {
    const store = fakeStore();
    expect(await consume(store, "tenant-a", 60)).toEqual({ allowed: true, limit: 60, remaining: 59, retryAfterSeconds: 42 });
    const expected = tenantKeys("tenant-a");
    expect(store.eval).toHaveBeenCalledWith(TOKEN_BUCKET_SCRIPT, {
      keys: [expected.bucket, expected.override], arguments: ["60"],
    });
    expect(expected.bucket.match(/\{(.+)\}/)?.[1]).toBe(expected.override.match(/\{(.+)\}/)?.[1]);
    expect(expected.bucket).not.toBe(tenantKeys("tenant-b").bucket);
  });
  it.each([
    null, [], [1, 60, 59], ["1", 60, 59, 1], [2, 60, 0, 1], [0, 0, 0, 1],
    [0, 1000001, 0, 1], [0, 60, -1, 1], [0, 60, 61, 1], [0, 60, 0, 0],
    [0, 60, 0, 61], [0, 60, 0, 1.5],
  ].map((reply) => ({ reply })))("rejects corrupt Redis reply $reply", async ({ reply }) => {
    const store = fakeStore();
    vi.mocked(store.eval).mockResolvedValue(reply);
    await expect(consume(store, "tenant-a", 60)).rejects.toThrow("invalid token-bucket");
  });
  it("bounds the complete Redis round trip even if an in-flight command never replies", async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      vi.mocked(store.eval).mockImplementation(() => new Promise<never>(() => {}));
      const failure = expect(consume(store, "tenant-a", 60)).rejects.toThrow("timed out after 200 ms");
      await vi.advanceTimersByTimeAsync(200);
      await failure;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rate limiting middleware", () => {
  it("returns 429 with JSON and matching Retry-After, and reports tenant metrics", async () => {
    const store = fakeStore();
    vi.mocked(store.eval).mockResolvedValue([0, 60, 0, 17]);
    const { app, metrics } = createApp({ store, config, logger: fakeLogger() });
    const res = await request(app).get("/orders").set("Authorization", bearer()).expect(429);
    expect(res.headers["retry-after"]).toBe("17");
    expect(res.headers["ratelimit-limit"]).toBe("60");
    expect(res.headers["ratelimit-remaining"]).toBe("0");
    expect(res.body.error).toEqual({ code: "RATE_LIMIT_EXCEEDED", message: "Tenant request limit exceeded", retryAfterSeconds: 17 });
    expect(store.hVals).not.toHaveBeenCalled();
    expect(await metrics.registry.metrics()).toContain('tenant="tenant-a",tier="free",mode="enforce",outcome="rejected"');
  });
  it.each(["off", "log-only"] as const)("%s never rejects a tenant", async (mode) => {
    const store = fakeStore();
    const logger = fakeLogger();
    vi.mocked(store.eval).mockResolvedValue([0, 60, 0, 17]);
    const { app } = createApp({ store, config: { ...config, mode }, logger });
    const res = await request(app).get("/orders").set("Authorization", bearer()).expect(200);
    expect(res.headers["retry-after"]).toBeUndefined();
    if (mode === "off") {
      expect(store.eval).not.toHaveBeenCalled();
    } else {
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "rate_limit_would_reject", tenantId: "tenant-a" }));
    }
  });
  it.each(["enforce", "log-only"] as const)("handles Redis errors explicitly in %s", async (mode) => {
    const store = fakeStore();
    const logger = fakeLogger();
    vi.mocked(store.eval).mockRejectedValue(new Error("Redis unavailable"));
    const { app, metrics } = createApp({ store, config: { ...config, mode }, logger });
    const res = await request(app).get("/orders").set("Authorization", bearer()).expect(mode === "enforce" ? 503 : 200);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "rate_limit_unavailable", error: "Redis unavailable" }));
    expect(await metrics.registry.metrics()).toContain('outcome="error"');
    if (mode === "enforce") {
      expect(res.headers["retry-after"]).toBe("5");
      expect(res.body.error.retryAfterSeconds).toBe(5);
    }
  });
  it("handles non-Error failures without silently swallowing them", async () => {
    const store = fakeStore();
    const logger = fakeLogger();
    vi.mocked(store.eval).mockRejectedValue("failure");
    await request(createApp({ store, config, logger }).app).get("/orders").set("Authorization", bearer()).expect(503);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: "failure" }));
  });
  it.each([[keys.free, "60"], [keys.pro, "120"], [keys.enterprise, "240"]])("uses the authenticated plan for %s", async (key, limit) => {
    const store = fakeStore();
    await request(createApp({ store, config, logger: fakeLogger() }).app).get("/orders")
      .set("Authorization", bearer(key)).set("X-Tenant-ID", "spoofed").set("X-Internal", "true").expect(200);
    expect(vi.mocked(store.eval).mock.calls[0]?.[1].arguments).toEqual([limit]);
  });
  it("exempts authenticated internal services, not tenant-supplied headers", async () => {
    const store = fakeStore();
    await request(createApp({ store, config, logger: fakeLogger() }).app).get("/orders")
      .set("Authorization", bearer(keys.service)).expect(200);
    expect(store.eval).not.toHaveBeenCalled();
  });
  it("fails closed if mounted without authenticated tenant context", async () => {
    const app = express();
    app.use(rateLimit({ store: fakeStore(), mode: "enforce", limits: config.limits, metrics: createMetrics(), logger: fakeLogger() }));
    await request(app).get("/orders").expect(403);
  });
  it("fails closed if a plan is removed at runtime", async () => {
    const limits = { ...config.limits };
    const { app } = createApp({ store: fakeStore(), config: { ...config, limits }, logger: fakeLogger() });
    delete limits.pro;
    await request(app).get("/orders").set("Authorization", bearer(keys.pro)).expect(503);
  });
});
