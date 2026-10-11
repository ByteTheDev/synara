import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const side = process.env.DOCS_EVIDENCE_SIDE;
if (side !== "before" && side !== "after") throw new Error("Unknown evidence side");
const output = process.env.DOCS_EVIDENCE_OUTPUT;
if (!output) throw new Error("Missing evidence output directory");
const after = side === "after";

for (const viewport of [
  { name: "desktop", width: 1440, height: 1100 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const phase of ["worktrees-context", "worktrees-policy", "troubleshooting"] as const) {
    test(`${viewport.name} ${phase}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(() => localStorage.setItem("synara-theme", "light"));
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const pathname =
        phase === "troubleshooting"
          ? "/docs/troubleshooting/git-and-worktrees"
          : "/docs/workflows/worktrees";
      await page.goto(pathname, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).not.toHaveClass(/dark/u);
      const main = page.getByRole("main", { name: "Documentation content" });
      await expect(main).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.images]
              .filter((image) => image.getClientRects().length > 0)
              .every((image) => image.complete && image.naturalWidth > 0),
          ),
        )
        .toBe(true);

      let selectedAnchor: string;
      let target;
      if (phase === "troubleshooting") {
        selectedAnchor = "Slow branch or worktree creation";
        target = main.getByRole("heading", {
          name: /^Slow branch or worktree creation(?: Copy Anchor Link)?$/u,
        });
        await expect(main).toContainText(".worktreeinclude");
        if (after)
          await expect(main).toContainText(
            "A large read-only directory that every worktree needs belongs in .worktreelink",
          );
        else await expect(main).not.toContainText(".worktreelink");
      } else {
        await expect(
          main.getByRole("heading", {
            name: /^Ignored files in a new worktree(?: Copy Anchor Link)?$/u,
          }),
        ).toHaveCount(after ? 1 : 0);
        if (after) {
          await expect(main).toContainText(
            "Directory links use junctions on Windows and symlinks elsewhere",
          );
          await expect(main).toContainText("Synara copies the resolved file instead");
          await expect(main).toContainText(
            "If Git rejects removal, Synara restores the detached links",
          );
        } else await expect(main).not.toContainText(".worktreelink");
        if (phase === "worktrees-context") {
          selectedAnchor = "Starting from a base ref";
          target = main.getByRole("heading", {
            name: /^Starting from a base ref(?: Copy Anchor Link)?$/u,
          });
        } else if (after) {
          selectedAnchor = "New .worktreelink policy paragraph";
          target = main
            .locator("p")
            .filter({ hasText: ".worktreelink lists ignored paths to link instead of copy" });
        } else {
          selectedAnchor =
            "Working inside the task (the following section before the new policy exists)";
          target = main.getByRole("heading", {
            name: /^Working inside the task(?: Copy Anchor Link)?$/u,
          });
        }
      }
      await expect(target).toHaveCount(1);
      await target.evaluate((element) =>
        element.scrollIntoView({ block: "start", behavior: "instant" }),
      );
      await page.evaluate(() => window.scrollBy({ top: -100, behavior: "instant" }));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeLessThan(viewport.height);
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
        documentWidth: document.documentElement.scrollWidth,
        light: !document.documentElement.classList.contains("dark"),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      }));
      expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width);
      expect(pageErrors).toEqual([]);
      const filename = `${viewport.name}-${phase}`;
      await page.screenshot({
        path: join(output, `${filename}.png`),
        fullPage: false,
        animations: "allow",
      });
      writeFileSync(
        join(output, `${filename}.json`),
        JSON.stringify(
          {
            side,
            phase,
            pathname,
            viewport,
            selectedAnchor,
            targetBox: box,
            geometry,
            source: process.env.DOCS_SOURCE_SHA,
            tree: process.env.DOCS_SOURCE_TREE,
            containsLinkPolicy: (await main.innerText()).includes(".worktreelink"),
            pageErrors,
            qualification:
              "Actual built production documentation and CSS. Read-only page observations and ordinary scrolling; no rendered content or CSS replacement. The policy view is explicitly the neighboring old section Before and the newly inserted policy After. Filesystem/native behavior is verified separately.",
          },
          null,
          2,
        ) + "\n",
      );
    });
  }
}
