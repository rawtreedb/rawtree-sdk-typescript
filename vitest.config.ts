import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@rawtree/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
      "@rawtree/otel": fileURLToPath(new URL("./packages/otel/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
