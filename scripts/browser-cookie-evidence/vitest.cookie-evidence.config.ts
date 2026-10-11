import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

const directory = process.env.VITE_COOKIE_OUTPUT;
const width = Number(process.env.VITE_COOKIE_WIDTH);
if (!directory?.startsWith("/") || ![360, 760].includes(width))
  throw new Error("Unexpected reviewed cookie capture configuration.");

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: [
      "src/components/PrCookieEvidence1856Vault.browser.tsx",
      "src/components/PrCookieEvidence1856Onboarding.browser.tsx",
    ],
    browser: {
      ...browserConfig.test?.browser,
      viewport: { width, height: 1000 },
      provider: playwright({
        contextOptions: {
          viewport: { width, height: 1000 },
          colorScheme: "light",
          reducedMotion: "reduce",
          recordVideo: { dir: directory + "/video", size: { width, height: 1000 } },
        },
      }),
    },
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
