import { createClient, createCluster } from "redis";
import type { Config } from "./config.js";

export function createStore(config: Pick<Config, "redisUrl" | "clusterRoots">) {
  const defaults = {
    socket: { connectTimeout: 2000, reconnectStrategy: (retries: number) => retries < 10 ? Math.min(100 * (retries + 1), 1000) : false },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 10_000,
  };
  const commandOptions = { timeout: 200 };
  return config.clusterRoots
    ? createCluster({ rootNodes: config.clusterRoots.map((url) => ({ url })), defaults, commandOptions, useReplicas: false })
    : createClient({ url: config.redisUrl, ...defaults, commandOptions });
}
