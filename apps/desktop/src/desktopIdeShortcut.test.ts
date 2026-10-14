import { describe, expect, it } from "vitest";
import { matchesDesktopAccelerator, type DesktopKeyboardInput } from "./menuShortcuts";

const input: DesktopKeyboardInput = {
  type: "keyDown",
  key: "g",
  code: "KeyG",
  control: true,
  meta: false,
  shift: false,
  alt: true,
};
describe("retained Agent renderer mode accelerator", () => {
  it("matches the native mode binding on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(matchesDesktopAccelerator("CommandOrControl+Alt+G", platform, input)).toBe(true);
    }
  });
  it("matches Command+Option on macOS, including its printable Option character", () => {
    expect(
      matchesDesktopAccelerator("CmdOrCtrl+Alt+G", "darwin", {
        ...input,
        control: false,
        meta: true,
        key: "©",
      }),
    ).toBe(true);
  });
  it("honors a changed binding rather than a hardcoded mode shortcut", () => {
    expect(matchesDesktopAccelerator("Ctrl+Shift+E", "linux", input)).toBe(false);
    expect(
      matchesDesktopAccelerator("Ctrl+Shift+E", "linux", {
        ...input,
        key: "E",
        code: "KeyE",
        shift: true,
        alt: false,
      }),
    ).toBe(true);
  });
  it("does not switch repeatedly, during composition, or with extra modifiers", () => {
    for (const overrides of [
      { type: "keyUp" },
      { isAutoRepeat: true },
      { isComposing: true },
      { shift: true },
      { meta: true },
    ]) {
      expect(matchesDesktopAccelerator("Ctrl+Alt+G", "linux", { ...input, ...overrides })).toBe(
        false,
      );
    }
  });
  it("does not consume plain typing, unsupported chords, or disabled bindings", () => {
    for (const accelerator of [null, "G", "Shift+G", "Ctrl+K Ctrl+G", "Unknown+G"]) {
      expect(matchesDesktopAccelerator(accelerator, "linux", input)).toBe(false);
    }
  });
});
