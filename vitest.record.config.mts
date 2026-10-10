import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/record-seed-cache.ts"], environment: "node", testTimeout: 600_000 },
});
