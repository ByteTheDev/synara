import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/chat/PrHandoffFooterControl1145.browser.tsx"],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
