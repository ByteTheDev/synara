import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

const output = process.env.VITE_PR_CHATVIEW_OUTPUT;
if (!output?.startsWith("/")) throw new Error("An explicit isolated capture directory is required");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/ChatView.browser.tsx"],
    testNamePattern: /PR UI evidence: preserve a ChatView reading position/,
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    browser: {
      ...browserConfig.test?.browser,
      provider: playwright({
        contextOptions: {
          viewport: { width: 1280, height: 900 },
          recordVideo: { dir: output + "/video", size: { width: 1280, height: 900 } },
        },
      }),
    },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

