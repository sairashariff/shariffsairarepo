import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { authenticate, requireAdmin, requireTenant } from "./auth.js";
import { limitSchema, tenantIdSchema, type Config } from "./config.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { rateLimit, tenantKeys } from "./rate-limit.js";
import type { Logger, RedisStore } from "./types.js";

const orderSchema = z.object({
  items: z.array(z.object({
    sku: z.string().min(1).max(100),
    quantity: z.number().int().min(1).max(10_000),
  }).strict()).min(1).max(100),
}).strict();
const overrideSchema = z.object({ limit: limitSchema }).strict();
const orderIdSchema = z.uuid();

export function createApp(options: { store: RedisStore; config: Config; logger: Logger; metrics?: Metrics }) {
  const { store, config, logger } = options;
  const metrics = options.metrics ?? createMetrics();
  const app = express();
  app.disable("x-powered-by");
  const auth = authenticate(config.apiKeys);

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/metrics", auth, requireAdmin, async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  const admin = express.Router();
  admin.use(auth, requireAdmin, express.json({ limit: "16kb" }));
  admin.put("/tenants/:tenantId/rate-limit", async (req, res) => {
    const tenant = tenantIdSchema.safeParse(req.params.tenantId);
    const body = overrideSchema.safeParse(req.body);
    if (!tenant.success || !body.success) {
      res.status(400).json({ error: { code: "INVALID_OVERRIDE", message: "A valid tenant ID and integer limit from 1 to 1000000 are required" } });
      return;
    }
    await store.set(tenantKeys(tenant.data).override, String(body.data.limit));
    logger.info({ event: "rate_limit_override_set", tenantId: tenant.data, limit: body.data.limit });
    res.json({ tenantId: tenant.data, limit: body.data.limit, effective: "next-request" });
  });
  admin.delete("/tenants/:tenantId/rate-limit", async (req, res) => {
    const tenant = tenantIdSchema.safeParse(req.params.tenantId);
    if (!tenant.success) {
      res.status(400).json({ error: { code: "INVALID_TENANT", message: "Invalid tenant ID" } });
      return;
    }
    await store.del(tenantKeys(tenant.data).override);
    logger.info({ event: "rate_limit_override_deleted", tenantId: tenant.data });
    res.sendStatus(204);
  });
  app.use("/admin", admin);

  // Every public route, including future routes and unknown paths, shares this boundary.
  app.use(auth, requireTenant, rateLimit({ store, mode: config.mode, limits: config.limits, metrics, logger }));
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    const principal = res.locals.principal;
    if (!principal || principal.kind === "admin") throw new Error("Tenant boundary was not applied");
    res.locals.ordersKey = tenantKeys(principal.tenantId).orders;
    next();
  });
  app.post("/orders", async (req, res) => {
    const body = orderSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "INVALID_ORDER", message: "Provide 1-100 items with a SKU and positive integer quantity" } });
      return;
    }
    const order = { id: randomUUID(), items: body.data.items, createdAt: new Date().toISOString() };
    await store.hSet(res.locals.ordersKey, order.id, JSON.stringify(order));
    res.status(201).location(`/orders/${order.id}`).json(order);
  });
  app.get("/orders", async (_req, res) => {
    const orders = await store.hVals(res.locals.ordersKey);
    res.json({ orders: orders.map((order) => JSON.parse(order) as unknown) });
  });
  app.get("/orders/:orderId", async (req, res) => {
    const id = orderIdSchema.safeParse(req.params.orderId);
    if (!id.success) {
      res.status(400).json({ error: { code: "INVALID_ORDER_ID", message: "Order ID must be a UUID" } });
      return;
    }
    const order = await store.hGet(res.locals.ordersKey, id.data);
    if (!order) {
      res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
      return;
    }
    res.json(JSON.parse(order) as unknown);
  });
  app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Endpoint not found" } }));
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    logger.error({ event: "request_failed", error: error instanceof Error ? error.message : String(error) });
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: { code: "INVALID_BODY", message: "Request body must be valid JSON within the size limit" } });
      return;
    }
    res.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable" } });
  };
  app.use(onError);
  return { app, metrics };
}

declare global {
  namespace Express {
    interface Locals {
      ordersKey: string;
    }
  }
}
