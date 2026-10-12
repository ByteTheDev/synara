// Dismiss first-run dialogs (import prompt, product tour) so they do not cover the transcript.
export async function dismissOnboarding(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let clicked = false;
    for (const name of ["Not now", "Skip tour"]) {
      const btn = page.getByRole("button", { name });
      if (await btn.count()) {
        await btn
          .first()
          .click()
          .catch(() => {});
        clicked = true;
        await page.waitForTimeout(300);
      }
    }
    if (!clicked && attempt > 0) return;
    await page.waitForTimeout(400);
  }
}
