import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createClient } from "redis";
import { tenantKeys } from "../src/rate-limit.js";

const tenantId = `smoke-${randomUUID()}`;
const tenantKey = randomBytes(32).toString("hex");
const adminKey = randomBytes(32).toString("hex");
const env = {
  ...process.env, PORT: "0", REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:16379",
  REDIS_CLUSTER_ROOTS: "", RATE_LIMIT_MODE: "enforce", PRO_RATE_LIMIT: "120", ENTERPRISE_RATE_LIMIT: "240",
  API_KEYS: JSON.stringify([
    { key: tenantKey, principal: { kind: "tenant", tenantId, tier: "free" } },
    { key: adminKey, principal: { kind: "admin" } },
  ]),
};
const child = spawn(process.execPath, ["dist/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let errors = "";
child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
const store = createClient({ url: env.REDIS_URL });
store.on("error", (error: Error) => console.error(error.message));
try {
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Server did not start")), 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        const event: unknown = JSON.parse(line);
        if (typeof event === "object" && event && "event" in event && event.event === "listening" && "port" in event) {
          assert.equal(typeof event.port, "number");
          clearTimeout(timer);
          resolve(Number(event.port));
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Early server exit ${code}: ${errors}`));
    });
  });
  assert.ok(port > 0);
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, key = tenantKey, options: RequestInit = {}) =>
    fetch(base + path, { ...options, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const created = await call("/orders", tenantKey, { method: "POST", body: JSON.stringify({ items: [{ sku: "SMOKE", quantity: 1 }] }) });
  assert.equal(created.status, 201);
  const location = created.headers.get("location");
  assert.ok(location);
  assert.equal((await call(location)).status, 200);
  const overridePath = `/admin/tenants/${tenantId}/rate-limit`;
  assert.equal((await call(overridePath, adminKey, { method: "PUT", body: '{"limit":1}' })).status, 200);
  const limited = await call("/orders");
  assert.equal(limited.status, 429);
  const retryAfter = limited.headers.get("retry-after");
  assert.ok(retryAfter && /^[1-9]\d*$/.test(retryAfter) && Number(retryAfter) <= 60);
  assert.equal(limited.headers.get("ratelimit-reset"), retryAfter);
  assert.equal((await limited.json()).error.retryAfterSeconds, Number(retryAfter));
  assert.equal(limited.headers.get("ratelimit-limit"), "1");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "1");
  assert.equal(limited.headers.get("ratelimit-remaining"), "0");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  const reset = Number(limited.headers.get("x-ratelimit-reset"));
  assert.ok(Number.isSafeInteger(reset) && reset > 0 && reset % 60 === 0);
  assert.equal((await call(overridePath, adminKey, { method: "PUT", body: '{"limit":100}' })).status, 200);
  await store.connect();
  // Only run this script against a dedicated standalone test Redis: it briefly pauses that server.
  await store.sendCommand(["CLIENT", "PAUSE", "400", "ALL"]);
  const unavailable = await call("/orders");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "5");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal((await call("/orders")).status, 200);
  assert.equal((await call("/metrics", adminKey)).status, 200);
  assert.match(errors, /rate_limit_unavailable/);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);

  const bad = spawnSync(process.execPath, ["dist/server.js"], { env: { ...env, API_KEYS: "[]" }, encoding: "utf8", timeout: 5000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /startup_failed/);
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  try {
    const address = occupied.address();
    assert.ok(address && typeof address !== "string");
    const badPort = spawnSync(process.execPath, ["dist/server.js"], {
      env: { ...env, PORT: String(address.port) }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(badPort.status, 1);
    assert.match(badPort.stderr, /server_error/);
  } finally {
    occupied.close();
  }
  console.log("Bootstrap smoke passed: Orders API, overrides, 429, Redis timeout/recovery, metrics, shutdown, startup errors.");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  if (store.isOpen) {
    await store.del(Object.values(tenantKeys(tenantId)));
    await store.quit();
  }
}
