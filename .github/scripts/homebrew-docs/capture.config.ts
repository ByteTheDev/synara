import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import base from "./playwright.config";

const output = process.env.HOMEBREW_DOCS_OUTPUT;
if (!output) throw new Error("Missing documentation capture output");
export default defineConfig({
  ...base,
  testMatch: "**/homebrew-docs.spec.ts",
  timeout: 90_000,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: join(output, "capture-report.json") }]],
  outputDir: join(output, "capture-test-results"),
  use: { ...base.use, video: "on", trace: "on", screenshot: "on" },
});
