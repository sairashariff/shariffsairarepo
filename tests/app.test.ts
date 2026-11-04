import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { tenantKeys } from "../src/rate-limit.js";
import { bearer, config, fakeLogger, fakeStore, keys } from "./helpers.js";

describe("Orders API", () => {
  it("provides health without a tenant key or consuming quota", async () => {
    const store = fakeStore();
    await request(createApp({ store, config, logger: fakeLogger() }).app).get("/healthz").expect(200, { status: "ok" });
    expect(store.eval).not.toHaveBeenCalled();
  });
  it.each([undefined, "Bearer invalid", `Basic ${keys.free}`, `Bearer ${keys.free} extra`])("rejects unauthenticated requests (%s)", async (authorization) => {
    const store = fakeStore();
    const req = request(createApp({ store, config, logger: fakeLogger() }).app).get("/orders");
    if (authorization) req.set("Authorization", authorization);
    await req.expect(401);
    expect(store.eval).not.toHaveBeenCalled();
  });
  it("creates, lists and retrieves tenant-scoped orders", async () => {
    const store = fakeStore();
    const { app } = createApp({ store, config, logger: fakeLogger() });
    const items = [{ sku: "SKU-1", quantity: 2 }];
    const created = await request(app).post("/orders").set("Authorization", bearer()).send({ items }).expect(201);
    expect(created.headers.location).toBe(`/orders/${created.body.id}`);
    expect(store.hSet).toHaveBeenCalledWith(tenantKeys("tenant-a").orders, created.body.id, JSON.stringify(created.body));
    vi.mocked(store.hVals).mockResolvedValue([JSON.stringify(created.body)]);
    await request(app).get("/orders").set("Authorization", bearer()).expect(200, { orders: [created.body] });
    vi.mocked(store.hGet).mockResolvedValue(JSON.stringify(created.body));
    await request(app).get(`/orders/${created.body.id}`).set("Authorization", bearer()).expect(200, created.body);
    await request(app).get(`/orders/${created.body.id}`).set("Authorization", bearer(keys.other)).expect(200);
    expect(store.hGet).toHaveBeenLastCalledWith(tenantKeys("tenant-b").orders, created.body.id);
    expect(store.eval).toHaveBeenCalledTimes(4);
  });
  it.each([
    {}, { items: [] }, { items: [{ sku: "", quantity: 1 }] },
    { items: [{ sku: "SKU", quantity: 0 }] }, { items: [{ sku: "SKU", quantity: 1.5 }] },
    { items: [{ sku: "SKU", quantity: 1 }], tenantId: "other" },
  ])("validates order input %j", async (body) => {
    const store = fakeStore();
    await request(createApp({ store, config, logger: fakeLogger() }).app).post("/orders")
      .set("Authorization", bearer()).send(body).expect(400);
    expect(store.hSet).not.toHaveBeenCalled();
    expect(store.eval).toHaveBeenCalledTimes(1);
  });
  it("handles invalid IDs and missing orders", async () => {
    const { app } = createApp({ store: fakeStore(), config, logger: fakeLogger() });
    await request(app).get("/orders/not-a-uuid").set("Authorization", bearer()).expect(400);
    await request(app).get("/orders/00000000-0000-4000-8000-000000000001").set("Authorization", bearer()).expect(404);
  });
  it("limits unknown public endpoints too", async () => {
    const store = fakeStore();
    const { app } = createApp({ store, config, logger: fakeLogger() });
    await request(app).get("/future-public-endpoint").set("Authorization", bearer()).expect(404);
    expect(store.eval).toHaveBeenCalledTimes(1);
  });
  it("rejects admin identities at the tenant API", async () => {
    const store = fakeStore();
    await request(createApp({ store, config, logger: fakeLogger() }).app).get("/orders")
      .set("Authorization", bearer(keys.admin)).expect(403);
    expect(store.eval).not.toHaveBeenCalled();
  });
  it("exposes metrics only to admins", async () => {
    const { app } = createApp({ store: fakeStore(), config, logger: fakeLogger() });
    await request(app).get("/metrics").expect(401);
    await request(app).get("/metrics").set("Authorization", bearer()).expect(403);
    const res = await request(app).get("/metrics").set("Authorization", bearer(keys.admin)).expect(200);
    expect(res.text).toContain("orders_rate_limit_decisions_total");
  });
  it.each(["bad-json", "oversize"])("reports malformed request bodies (%s)", async (body) => {
    const { app } = createApp({ store: fakeStore(), config, logger: fakeLogger() });
    await request(app).post("/orders").set("Authorization", bearer()).type("json")
      .send(body === "bad-json" ? "{" : JSON.stringify({ value: "x".repeat(65_536) }))
      .expect(body === "bad-json" ? 400 : 413);
  });
  it.each([new Error("Redis failed"), "failure"])("logs storage failures and returns explicit 503", async (error) => {
    const store = fakeStore();
    const logger = fakeLogger();
    vi.mocked(store.hVals).mockRejectedValue(error);
    await request(createApp({ store, config, logger }).app).get("/orders").set("Authorization", bearer()).expect(503);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "request_failed" }));
  });
});

describe("admin overrides", () => {
  it("sets and deletes overrides without consuming a tenant's quota", async () => {
    const store = fakeStore();
    const logger = fakeLogger();
    const { app } = createApp({ store, config, logger });
    await request(app).put("/admin/tenants/tenant-a/rate-limit").set("Authorization", bearer(keys.admin))
      .send({ limit: 75 }).expect(200, { tenantId: "tenant-a", limit: 75, effective: "next-request" });
    expect(store.set).toHaveBeenCalledWith(tenantKeys("tenant-a").override, "75");
    await request(app).delete("/admin/tenants/tenant-a/rate-limit").set("Authorization", bearer(keys.admin)).expect(204);
    expect(store.del).toHaveBeenCalledWith(tenantKeys("tenant-a").override);
    expect(store.eval).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(2);
  });
  it("rejects non-admin identities and spoofed role headers", async () => {
    const store = fakeStore();
    const { app } = createApp({ store, config, logger: fakeLogger() });
    await request(app).put("/admin/tenants/tenant-a/rate-limit").send({ limit: 75 }).expect(401);
    for (const key of [keys.free, keys.service]) {
      await request(app).put("/admin/tenants/tenant-a/rate-limit").set("Authorization", bearer(key))
        .set("X-Role", "platform-admin").send({ limit: 75 }).expect(403);
    }
    expect(store.set).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 1_000_001, "75", null])("rejects invalid override %j", async (limit) => {
    const { app } = createApp({ store: fakeStore(), config, logger: fakeLogger() });
    await request(app).put("/admin/tenants/tenant-a/rate-limit").set("Authorization", bearer(keys.admin))
      .send({ limit }).expect(400);
  });
  it("rejects invalid tenant IDs on set and delete", async () => {
    const { app } = createApp({ store: fakeStore(), config, logger: fakeLogger() });
    await request(app).put("/admin/tenants/%7Bbad%7D/rate-limit").set("Authorization", bearer(keys.admin)).send({ limit: 1 }).expect(400);
    await request(app).delete("/admin/tenants/%7Bbad%7D/rate-limit").set("Authorization", bearer(keys.admin)).expect(400);
  });
  it("does not report success when an override cannot be persisted", async () => {
    const store = fakeStore();
    vi.mocked(store.set).mockRejectedValue(new Error("Redis unavailable"));
    await request(createApp({ store, config, logger: fakeLogger() }).app)
      .put("/admin/tenants/tenant-a/rate-limit").set("Authorization", bearer(keys.admin)).send({ limit: 75 }).expect(503);
  });
});
