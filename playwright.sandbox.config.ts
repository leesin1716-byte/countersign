import { defineConfig, devices } from "@playwright/test";

// Opt-in run against the real PayPal sandbox (keys from .env.local). Seed messages replay recorded Claude runs, so no AI spend.
const PORT = 3211;

export default defineConfig({
  testDir: "e2e-sandbox",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 1000 }, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { PAYPAL_MODE: "sandbox", AI_SEED_MODE: "cache", DATA_DIR: ".data-sandbox", RESETS_PER_VISITOR_DAILY: "200" },
  },
});
