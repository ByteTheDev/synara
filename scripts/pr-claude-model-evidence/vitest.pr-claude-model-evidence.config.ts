import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_PR_MODEL_OUTPUT;
if (!directory?.startsWith("/")) throw new Error("An explicit video directory is required.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/PrUiEvidence369ModelChatView.browser.tsx"],
    testNamePattern:
      "qualifies configured Claude options in the full ChatView|keeps '(sibling|unknown)' Claude model controls unconfigured in the full ChatView",
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
