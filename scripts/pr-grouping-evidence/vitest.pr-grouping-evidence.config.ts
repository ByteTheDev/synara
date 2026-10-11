import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_PR_GROUPING_OUTPUT;
if (!directory?.startsWith("/")) throw new Error("An explicit video directory is required.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/PrUiEvidence1827ChatView.browser.tsx"],
    testNamePattern:
      "keeps the selected Activity grouping after switching back from classic view|restores Activity grouping on mount and adopts an external grouping change",
    browser: {
      ...browserConfig.test?.browser,
      viewport: { width: 960, height: 1100 },
      provider: playwright({
        contextOptions: {
          recordVideo: { dir: `${directory}/video`, size: { width: 960, height: 1100 } },
        },
      }),
    },
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
