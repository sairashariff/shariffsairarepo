import { randomBytes, randomUUID } from "node:crypto";
import { createHistogram } from "node:perf_hooks";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import autocannon from "autocannon";
import { createApp } from "../src/app.js";
import { createMetrics } from "../src/metrics.js";
import { tenantKeys } from "../src/rate-limit.js";
import { createStore } from "../src/redis.js";
import type { Config } from "../src/config.js";
import type { Mode } from "../src/types.js";

const rate = 5000;
const offeredRate = 5050;
const duration = Number(process.env.LOAD_SECONDS ?? "20");
if (!Number.isInteger(duration) || duration < 10) throw new Error("LOAD_SECONDS must be an integer >= 10");
const store = createStore({ redisUrl: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:16379" });
store.on("error", (error: Error) => console.error(JSON.stringify({ event: "redis_error", error: error.message })));
const tenantId = `load-${randomUUID()}`;
const apiKey = randomBytes(32).toString("hex");
const results: Record<string, unknown> = {};
await store.connect();
try {
  for (const mode of ["off", "enforce"] as Mode[]) {
    const histogram = createHistogram();
    const metrics = createMetrics();
    const record = metrics.record;
    metrics.record = (decision) => {
      const metricStarted = performance.now();
      record(decision);
      histogram.record(Math.max(1, Math.ceil((decision.durationSeconds + (performance.now() - metricStarted) / 1000) * 1e9)));
    };
    const config: Config = {
      port: 0, redisUrl: "", mode,
      // Synthetic benchmark values allow all requests; these are not plan defaults.
      limits: { free: 60, pro: 1_000_000, enterprise: 1_000_000 },
      apiKeys: [{ key: apiKey, principal: { kind: "tenant", tenantId, tier: "enterprise" } }],
    };
    const { app } = createApp({ store, config, metrics, logger: { info: console.log, error: console.error } });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing load-test listener");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      if (!response.ok) throw new Error("Load-test server failed health check");
      const result = await autocannon({
        url: `http://127.0.0.1:${address.port}/orders`, connections: 50,
        overallRate: offeredRate, duration, headers: { authorization: `Bearer ${apiKey}` },
      });
      results[mode] = {
        requiredRps: rate,
        offeredRps: offeredRate,
        durationSeconds: result.duration,
        completedRequests: result.requests.total,
        achievedRps: result.requests.total / result.duration,
        httpLatencyMs: result.latency,
        errors: result.errors,
        non2xx: result.non2xx,
        measuredLimiterDecisions: histogram.count,
        limiterP95Ms: histogram.count ? histogram.percentile(95) / 1e6 : null,
        limiterUnder5ms: histogram.count ? histogram.percentile(95) / 1e6 < 5 : null,
      };
      if (result.errors || result.non2xx || result.requests.total / result.duration < rate) {
        process.exitCode = 1;
      }
      if (mode === "enforce" && (histogram.count === 0 || histogram.percentile(95) / 1e6 >= 5)) {
        process.exitCode = 1;
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
} finally {
  await store.del(Object.values(tenantKeys(tenantId)));
  await store.quit();
}
const report = {
  timestamp: new Date().toISOString(), node: process.version, platform: process.platform,
  architecture: process.arch, cpu: cpus()[0]?.model, availableCpus: availableParallelism(),
  minimumRps: rate, offeredRps: offeredRate, results,
};
const output = JSON.stringify(report, null, 2) + "\n";
if (process.env.LOAD_REPORT) await writeFile(process.env.LOAD_REPORT, output);
console.log(output);
