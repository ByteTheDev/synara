/** Runs inside the real isolated Electron acceptance harness, not a mock UI. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function verifyAppearance({
  application,
  agent,
  workbench,
  composer,
  screen,
  until,
  record,
}) {
  const profile = await application.evaluate(({ app }) => app.getPath("userData"));
  const readSettings = () =>
    readFile(join(profile, "User/settings.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const beforeSettings = await readSettings();
  const beforeDraft = await composer.innerText();
  const previous = await agent.evaluate(() => localStorage.getItem("synara:theme"));
  async function setTheme(mode, custom = false) {
    await agent.evaluate(
      ({ mode, custom }) => {
        const key = "synara:theme";
        const state = JSON.parse(localStorage.getItem(key) ?? "{}");
        state.mode = mode;
        if (custom) {
          state.systemUiFont = false;
          state.chromeThemes = {
            ...state.chromeThemes,
            dark: {
              ...state.chromeThemes?.dark,
              surface: "#20252b",
              accent: "#cc7e5c",
              fonts: { ui: "DejaVu Sans", code: null },
            },
          };
        }
        localStorage.setItem(key, JSON.stringify(state));
        window.dispatchEvent(new StorageEvent("storage", { key }));
      },
      { mode, custom },
    );
    return until(
      () => agent.evaluate(() => window.desktopBridge.ide.getState()),
      (state) =>
        state.appearance?.variant === mode &&
        (!custom || state.appearance.colors.surface.startsWith("#20252b")),
      `Synara ${mode} appearance reaches desktop bridge`,
    );
  }
  async function nativeStyle() {
    return workbench.evaluate(() => {
      const root = document.querySelector(".monaco-workbench");
      const style = getComputedStyle(root);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      const hex = (name) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = style.getPropertyValue(name);
        context.fillRect(0, 0, 1, 1);
        return (
          "#" +
          Array.from(context.getImageData(0, 0, 1, 1).data, (value) =>
            value.toString(16).padStart(2, "0"),
          ).join("")
        );
      };
      return {
        variant: root.dataset.synaraAppearance,
        styled: root.classList.contains("synara-workbench"),
        fontFamily: style.fontFamily,
        fontSize: parseFloat(style.fontSize),
        surface: hex("--vscode-editor-background"),
        sidebar: hex("--vscode-sideBar-background"),
        accent: hex("--vscode-focusBorder"),
      };
    });
  }
  for (const mode of ["dark", "light"]) {
    const { appearance } = await setTheme(mode);
    const actual = await until(
      nativeStyle,
      (native) =>
        native.variant === mode &&
        native.styled &&
        native.surface === appearance.colors.surface &&
        native.sidebar === appearance.colors.surface,
      `native IDE and Synara share ${mode} surfaces`,
    );
    if (actual.fontFamily !== appearance.uiFontFamily || actual.fontSize !== appearance.uiFontSize)
      throw new Error(`Native typography does not match Synara: ${JSON.stringify(actual)}`);
    // Let Electron composite both sibling views before the actual desktop capture.
    await workbench.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    screen(`after-synara-ide-${mode}.png`);
    await record(`native IDE follows Synara ${mode} colors and typography`, actual);
  }
  const { appearance } = await setTheme("dark", true);
  await agent.evaluate(() =>
    document.documentElement.style.setProperty("--app-font-size-ui", "16px"),
  );
  const custom = await until(
    nativeStyle,
    (native) =>
      native.surface === appearance.colors.surface &&
      native.fontSize === 16 &&
      native.fontFamily.includes("DejaVu Sans"),
    "custom imported appearance and typography propagate without reload",
  );
  await record("custom Synara surface and UI font propagate live", custom);
  const state = await agent.evaluate(() => window.desktopBridge.ide.getState());
  const rejected = await agent.evaluate(async (appearance) => {
    try {
      await window.desktopBridge.ide.setAppearance({
        ...appearance,
        uiFontFamily: "system-ui; color:red",
      });
      return false;
    } catch {
      return true;
    }
  }, state.appearance);
  if (!rejected) throw new Error("Native appearance bridge accepted arbitrary CSS");
  if ((await readSettings()) !== beforeSettings)
    throw new Error("Appearance synchronization overwrote native user settings");
  if ((await composer.innerText()) !== beforeDraft)
    throw new Error("Appearance changes replaced the existing Agent draft");
  await record("appearance sync rejects CSS injection and preserves native settings and draft");
  await agent.evaluate((previous) => {
    if (previous === null) localStorage.removeItem("synara:theme");
    else localStorage.setItem("synara:theme", previous);
    window.dispatchEvent(new StorageEvent("storage", { key: "synara:theme" }));
    document.documentElement.style.setProperty("--app-font-size-ui", "13px");
  }, previous);
  await setTheme("dark");
}
