import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_PR_SIDEBAR_OUTPUT;
if (!directory?.startsWith("/")) throw new Error("An explicit video directory is required.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/PrUiEvidence1832ChatView.browser.tsx"],
    testNamePattern:
      "keeps the project environment when global New thread creates a draft from Home|keeps the stored draft environment when global New thread reopens it from Home|does not open Add project before project hydration completes",
    browser: {
      ...browserConfig.test?.browser,
      viewport: { width: 960, height: 1100 },
      provider: playwright({
        contextOptions: {
          viewport: { width: 960, height: 1100 },
          recordVideo: { dir: `${directory}/video`, size: { width: 960, height: 1100 } },
        },
      }),
    },
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
