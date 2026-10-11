import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_PR_ROOT_OUTPUT;
const kind = process.env.PR_ROOT_KIND;
if (!directory?.startsWith("/") || !["images", "settings"].includes(kind ?? "")) {
  throw new Error("Explicit source evidence target and owned report destination are required.");
}

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: [
      kind === "images"
        ? "src/components/PrRootSourceEvidence.browser.tsx"
        : "src/components/settings/PrRootSettingsEvidence.browser.tsx",
    ],
    testNamePattern:
      kind === "images"
        ? "source UI evidence renders (view|generation) projection$"
        : "saves raw Codex launch args without changing account paths$",
    browser: {
      ...browserConfig.test?.browser,
      viewport: { width: 960, height: 1100 },
      provider: playwright({
        contextOptions: {
          viewport: { width: 960, height: 1100 },
          recordVideo: { dir: directory + "/video", size: { width: 960, height: 1100 } },
        },
      }),
    },
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
