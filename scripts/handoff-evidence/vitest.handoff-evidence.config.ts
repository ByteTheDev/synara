import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_HANDOFF_EVIDENCE_OUTPUT;
if (!directory?.startsWith("/")) throw new Error("An explicit evidence directory is required.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/PrHandoffEvidence1145.browser.tsx"],
    testNamePattern:
      "holds the composer for a durable provider request until its matching .* outcome$",
    browser: {
      ...browserConfig.test?.browser,
      viewport: { width: 960, height: 1100 },
      provider: playwright({
        contextOptions: {
          viewport: { width: 960, height: 1100 },
          colorScheme: "light",
          reducedMotion: "reduce",
          recordVideo: { dir: directory + "/video", size: { width: 960, height: 1100 } },
        },
      }),
    },
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
