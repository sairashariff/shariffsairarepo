import { describe, expect, it, vi } from "vitest";
import { createClient, createCluster } from "redis";
import { createStore } from "../src/redis.js";

vi.mock("redis", () => ({ createClient: vi.fn(), createCluster: vi.fn() }));

describe("production Redis configuration", () => {
  it("uses standalone mode, bounded queues, offline-queue prevention and bounded retries", () => {
    createStore({ redisUrl: "redis://localhost:16379" });
    const options = vi.mocked(createClient).mock.calls.at(-1)?.[0];
    expect(options).toMatchObject({
      url: "redis://localhost:16379", disableOfflineQueue: true, commandsQueueMaxLength: 10_000, commandOptions: { timeout: 200 },
    });
    const retry = options?.socket && "reconnectStrategy" in options.socket ? options.socket.reconnectStrategy : undefined;
    if (typeof retry !== "function") throw new Error("Missing reconnect strategy");
    expect(retry(0, new Error("test"))).toBe(100);
    expect(retry(9, new Error("test"))).toBe(1000);
    expect(retry(10, new Error("test"))).toBe(false);
  });
  it("uses Redis Cluster discovery and primary reads when roots are configured", () => {
    createStore({ redisUrl: "redis://unused:6379", clusterRoots: ["rediss://node-a:6379", "rediss://node-b:6379"] });
    expect(createCluster).toHaveBeenCalledWith(expect.objectContaining({
      rootNodes: [{ url: "rediss://node-a:6379" }, { url: "rediss://node-b:6379" }],
      commandOptions: { timeout: 200 }, useReplicas: false,
      defaults: expect.objectContaining({ disableOfflineQueue: true }),
    }));
  });
});
