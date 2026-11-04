import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
      reporter: ["text", "json-summary", "html"],
    },
  },
});
