import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_PR1859_OUTPUT;
if (!directory?.startsWith("/")) throw new Error("An explicit video directory is required.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/PrUiEvidence1859Devin.browser.tsx"],
    testNamePattern:
      "shows Loading until ack, then keeps Thinking through the post-ack gap|PR1859 review evidence",
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
