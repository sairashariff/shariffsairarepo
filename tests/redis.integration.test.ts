import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { consume, tenantKeys } from "../src/rate-limit.js";
import { createStore } from "../src/redis.js";
import { loadConfig } from "../src/config.js";
import { bearer, config, fakeLogger, keys } from "./helpers.js";

describe.skipIf(process.env.RUN_REDIS_TESTS !== "1")("real Redis integration", () => {
  const store = createStore({
    redisUrl: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:16379",
    clusterRoots: loadConfig({ API_KEYS: JSON.stringify(config.apiKeys), REDIS_CLUSTER_ROOTS: process.env.TEST_REDIS_CLUSTER_ROOTS }).clusterRoots,
  });
  store.on("error", (error: Error) => console.error(error.message));
  const cleanup = new Set<string>();
  const tenant = () => {
    const id = randomUUID();
    Object.values(tenantKeys(id)).forEach((key) => cleanup.add(key));
    return id;
  };
  beforeAll(async () => { await store.connect(); });
  beforeEach(async () => {
    const clock = await store.eval("return redis.call('TIME')", { keys: [tenantKeys("clock").bucket], arguments: [] });
    if (!Array.isArray(clock) || typeof clock[0] !== "string") throw new Error("Unexpected Redis TIME response");
    if (Number(clock[0]) % 60 === 59) await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  afterAll(async () => {
    if (store.isOpen) {
      await Promise.all([...cleanup].map((key) => store.del(key)));
      await store.quit();
    }
  });

  it("atomically allows exactly 60 concurrent Free requests and isolates other tenants", async () => {
    const id = tenant();
    const decisions = await Promise.all(Array.from({ length: 100 }, () => consume(store, id, 60)));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(60);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(40);
    expect((await consume(store, id, 60)).allowed).toBe(false);
    expect((await consume(store, tenant(), 60)).allowed).toBe(true);
    expect(await store.ttl(tenantKeys(id).bucket)).toBeGreaterThan(60);
  });
  it("does not continuously refill an exhausted bucket and refills at the next minute", async () => {
    const id = tenant();
    const bucket = tenantKeys(id).bucket;
    const clock = await store.eval("return redis.call('TIME')", { keys: [bucket], arguments: [] });
    if (!Array.isArray(clock) || typeof clock[0] !== "string") throw new Error("Unexpected Redis TIME response");
    const minute = Math.floor(Number(clock[0]) / 60);
    await store.hSet(bucket, { minute: String(minute), tokens: "0", capacity: "60" });
    expect((await consume(store, id, 60)).allowed).toBe(false);
    await store.hSet(bucket, "minute", String(minute - 1));
    expect(await consume(store, id, 60)).toMatchObject({ allowed: true, remaining: 59 });
  });
  it("applies override increases/decreases/deletion immediately without resetting consumption", async () => {
    const id = tenant();
    const key = tenantKeys(id).override;
    await Promise.all(Array.from({ length: 60 }, () => consume(store, id, 60)));
    await store.set(key, "62");
    expect(await consume(store, id, 60)).toMatchObject({ allowed: true, limit: 62, remaining: 1 });
    await store.set(key, "10");
    expect(await consume(store, id, 60)).toMatchObject({ allowed: false, limit: 10, remaining: 0 });
    await store.set(key, "62");
    expect(await consume(store, id, 60)).toMatchObject({ allowed: true, remaining: 0 });
    expect((await consume(store, id, 60)).allowed).toBe(false);
    await store.del(key);
    expect(await consume(store, id, 60)).toMatchObject({ allowed: false, limit: 60 });
  });
  it.each([120, 240])("uses the supplied paid tier capacity %i", async (limit) => {
    const id = tenant();
    const results = await Promise.all(Array.from({ length: limit + 1 }, () => consume(store, id, limit)));
    expect(results.filter((result) => result.allowed)).toHaveLength(limit);
  });
  it("serves real orders and applies admin overrides to the next HTTP request", async () => {
    const id = tenant();
    const otherId = tenant();
    const apiKeys = config.apiKeys.map((entry) => ({
      ...entry,
      principal: entry.principal.kind === "admin" ? entry.principal : {
        ...entry.principal, tenantId: entry.key === keys.other ? otherId : id,
      },
    }));
    const { app } = createApp({ store, config: { ...config, apiKeys }, logger: fakeLogger() });
    const order = await request(app).post("/orders").set("Authorization", bearer())
      .send({ items: [{ sku: "SKU-1", quantity: 1 }] }).expect(201);
    await request(app).get(`/orders/${order.body.id}`).set("Authorization", bearer(keys.other)).expect(404);
    await request(app).put(`/admin/tenants/${id}/rate-limit`).set("Authorization", bearer(keys.admin)).send({ limit: 1 }).expect(200);
    await request(app).get("/orders").set("Authorization", bearer()).expect(429);
    await request(app).put(`/admin/tenants/${id}/rate-limit`).set("Authorization", bearer(keys.admin)).send({ limit: 100 }).expect(200);
    await request(app).get("/orders").set("Authorization", bearer()).expect(200);
    await request(app).get("/orders").set("Authorization", bearer(keys.service)).expect(200);
  });
});
