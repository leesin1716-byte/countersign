import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    env: { PAYPAL_MODE: "mock", AI_MODE: "mock", AI_SEED_MODE: "rules", DATA_DIR: ".data-test" },
  },
});
