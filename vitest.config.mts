import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { PAYPAL_MODE: "mock", AI_MODE: "mock", DATA_DIR: ".data-test" },
  },
});
