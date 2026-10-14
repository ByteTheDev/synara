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
      const hex = (name, target = style) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = target.getPropertyValue(name);
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
        statusbar: hex("background-color", getComputedStyle(root.querySelector(".part.statusbar"))),
        statusbarForeground: hex("color", getComputedStyle(root.querySelector(".part.statusbar"))),
      };
    });
  }
  async function composerBounds() {
    return agent.evaluate(() => {
      const surface = document.querySelector(".chat-composer-surface");
      const editor = document.querySelector('[contenteditable="true"]');
      if (!surface || !editor) return null;
      const box = surface.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: innerWidth,
        height: innerHeight,
        visible:
          box.width > 0 &&
          box.height > 0 &&
          box.top >= 0 &&
          box.left >= 0 &&
          box.bottom <= innerHeight + 1 &&
          box.right <= innerWidth + 1,
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
        native.sidebar === appearance.colors.surface &&
        native.statusbar === appearance.colors.shell &&
        native.statusbarForeground === appearance.colors.foreground,
      `native IDE and Synara share ${mode} surfaces`,
    );
    if (actual.fontFamily !== appearance.uiFontFamily || actual.fontSize !== appearance.uiFontSize)
      throw new Error(`Native typography does not match Synara: ${JSON.stringify(actual)}`);
    const bounds = await until(
      composerBounds,
      (value) => value?.visible,
      "entire docked composer and toolbar stay inside their pane",
    );
    // Wait for resolved status-bar colors above, including native theme transitions,
    // before compositing both sibling views for the actual desktop capture.
    await workbench.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const icons = await agent.locator(".synara-ide-session-bar svg").evaluateAll(
      (items) =>
        items.filter((item) => {
          const bounds = item.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            item.querySelector("path, rect, circle, line, polyline")
          );
        }).length,
    );
    if (icons < 3) throw new Error("Native mode/session controls are missing their inline glyphs");
    screen(`after-synara-ide-${mode}.png`);
    await record(`native IDE follows Synara ${mode} colors and typography`, {
      ...actual,
      composer: bounds,
    });
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
  const originalBounds = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 720 }),
  );
  const compact = await until(
    composerBounds,
    (value) => value?.visible && value.height < 720,
    "composer remains visible in a smaller native window",
  );
  await record(
    "docked composer and toolbar remain fully visible after native window resize",
    compact,
  );
  await application.evaluate(
    ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
    originalBounds,
  );
  await until(
    composerBounds,
    (value) => value?.visible && value.height > 720,
    "composer restores after window resize",
  );
}

export async function verifySessionControl({ agent, until, record }) {
  const before = await agent.evaluate(() => window.desktopBridge.ide.getState());
  const identity = await agent.evaluate(() => window.__synaraSmokeIdentity);
  await agent.getByRole("button", { name: "New Synara session", exact: true }).click();
  const next = await until(
    () => agent.evaluate(() => window.desktopBridge.ide.getState()),
    (state) => state.scope.threadId && state.scope.threadId !== before.scope.threadId,
    "docked new-session control selects a fresh Synara session",
    20000,
  );
  if (next.mode !== "ide" || next.status !== "ready")
    throw new Error("Creating a session left the ready native IDE");
  if ((await agent.evaluate(() => window.__synaraSmokeIdentity)) !== identity)
    throw new Error("Creating a session reloaded the retained Agent renderer");
  await record(
    "docked new-session control creates a fresh session without reloading Agent or leaving IDE",
    {
      previous: before.scope.threadId,
      selected: next.scope.threadId,
      mode: next.mode,
    },
  );
}
