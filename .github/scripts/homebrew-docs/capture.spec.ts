import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoOverflow, prepareRoute } from "../test-helpers";

const variant = process.env.HOMEBREW_DOCS_VARIANT;
const output = process.env.HOMEBREW_DOCS_OUTPUT;
const source = process.env.HOMEBREW_DOCS_SOURCE;
if (!output || !source || !["before", "after"].includes(variant ?? "")) {
  throw new Error("Missing exact documentation capture identity");
}
for (const [layout, width, height] of [
  ["desktop", 1440, 1100],
  ["mobile", 390, 844],
] as const) {
  test(`actual Homebrew documentation ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const observations: object[] = [];
    for (const [name, route, heading] of [
      ["installation", "/docs/getting-started/installation", "Installation"],
      ["updates", "/docs/troubleshooting/desktop-and-updates", "Desktop and updates"],
    ] as const) {
      await prepareRoute(page, route, "light");
      await expect(
        page.getByRole("heading", { level: 1, name: heading, exact: true }),
      ).toBeVisible();
      await assertNoOverflow(page);
      const upgrade = page.getByText("brew upgrade --cask --greedy-auto-updates synara", {
        exact: true,
      });
      if (variant === "after") {
        await expect(upgrade).toBeVisible();
        if (name === "installation") {
          await expect(
            page.getByRole("heading", {
              level: 3,
              name: "Homebrew on macOS Copy Anchor Link",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText(/Homebrew support is pending acceptance of the official cask/),
          ).toBeVisible();
          await expect(page.getByText("brew install --cask synara", { exact: true })).toBeVisible();
        } else {
          await expect(page.getByText(/After Homebrew accepts the official cask/)).toBeVisible();
          await expect(
            page.getByText("brew reinstall --cask synara", { exact: true }),
          ).toBeVisible();
        }
      } else {
        await expect(upgrade).toHaveCount(0);
        await expect(
          page.getByRole("heading", {
            level: 3,
            name: "Homebrew on macOS Copy Anchor Link",
            exact: true,
          }),
        ).toHaveCount(0);
      }
      const state = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        fonts: document.fonts.status,
        text: document.body.innerText,
        viewport: { width: innerWidth, height: innerHeight },
        document: {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        },
      }));
      expect(state.theme).toBe("light");
      expect(state.reducedMotion).toBe(true);
      expect(state.fonts).toBe("loaded");
      await page.screenshot({
        path: join(output, `${name}-${layout}.png`),
        fullPage: true,
        animations: "disabled",
      });
      observations.push({ name, route, state });
    }
    await prepareRoute(page, "/install", "light");
    await expect(
      page.getByRole("heading", { level: 1, name: "Download Synara", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/brew install --cask synara/)).toHaveCount(0);
    await expect(page.getByText(/Homebrew/)).toHaveCount(0);
    await assertNoOverflow(page);
    await page.screenshot({
      path: join(output, `install-page-${layout}.png`),
      fullPage: true,
      animations: "disabled",
    });
    expect(pageErrors).toEqual([]);
    writeFileSync(
      join(output, `observations-${layout}.json`),
      JSON.stringify(
        {
          source,
          variant,
          platform: process.platform,
          layout,
          observations,
          installCalloutAbsent: true,
          pageErrors,
          qualification:
            "Actual production Next routes and Chromium. Exact unchanged preparation helper controls light preference, reduced motion, fonts and image readiness. No mocked component or API response, install command execution, upstream Homebrew acceptance, or app-source edit.",
        },
        null,
        2,
      ) + "\n",
    );
  });
}
