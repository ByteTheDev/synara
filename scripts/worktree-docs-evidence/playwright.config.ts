import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/pr1847-docs-evidence",
  testMatch: "capture.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  forbidOnly: true,
  expect: { timeout: 15_000 },
  outputDir: process.env.DOCS_PLAYWRIGHT_OUTPUT,
  reporter: [["line"], ["json", { outputFile: process.env.DOCS_LIVE_REPORT }]],
  use: {
    baseURL: "http://127.0.0.1:3211",
    browserName: "chromium",
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run start --hostname 127.0.0.1 --port 3211",
    url: "http://127.0.0.1:3211",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
