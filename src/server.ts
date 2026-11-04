import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createStore } from "./redis.js";
import type { Logger } from "./types.js";

const logger: Logger = {
  info: (event) => console.log(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event)),
};

try {
  const config = loadConfig(process.env);
  const store = createStore(config);
  store.on("error", (error: Error) => logger.error({ event: "redis_error", error: error.message }));
  await store.connect();
  const { app } = createApp({ store, config, logger });
  const server = app.listen(config.port, () => {
    const address = server.address();
    logger.info({ event: "listening", port: typeof address === "object" ? address?.port : config.port, mode: config.mode });
  });
  server.on("error", (error) => {
    logger.error({ event: "server_error", error: error.message });
    store.destroy();
    process.exitCode = 1;
  });
  const shutdown = () => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      if (store.isOpen) store.destroy();
    }, 5000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      if (store.isOpen) store.destroy();
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  logger.error({ event: "startup_failed", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
