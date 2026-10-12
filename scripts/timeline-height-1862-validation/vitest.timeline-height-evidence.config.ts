import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

const screenshots = process.env.PR1862_SCREENSHOTS;
if (!screenshots?.startsWith("/")) throw new Error("An explicit owned screenshot directory is required.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: [
      "src/components/chat/PrRowHeightOwnership1862.browser.tsx",
      "src/components/chat/MessagesTimeline.scroll.browser.tsx",
    ],
    browser: {
      ...browserConfig.test?.browser,
      viewport: { width: 960, height: 1100 },
      screenshotDirectory: screenshots,
    },
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
