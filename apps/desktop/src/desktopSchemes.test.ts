import { describe, expect, it } from "vitest";
import { desktopPrivilegedSchemes } from "./desktopSchemes";
describe("single-app privileged schemes", () => {
  it("preserves legacy desktop and local preview capabilities", () => {
    const schemes = desktopPrivilegedSchemes("synara", "synara-preview", false);
    expect(schemes.map((item) => item.scheme)).toEqual(["synara", "synara-preview"]);
    expect(schemes[0]?.privileges?.codeCache).toBe(true);
    expect(
      schemes.every((item) => item.privileges?.supportFetchAPI && item.privileges.secure),
    ).toBe(true);
  });
  it("registers native fetch and extension-webview workers alongside Synara without bypassing CSP", () => {
    const schemes = desktopPrivilegedSchemes("synara-beta", "synara-preview", true);
    expect(schemes).toHaveLength(6);
    expect(new Set(schemes.map((item) => item.scheme)).size).toBe(schemes.length);
    expect(schemes.find((item) => item.scheme === "vscode-file")?.privileges).toMatchObject({
      supportFetchAPI: true,
      standard: true,
      secure: true,
    });
    expect(
      schemes.find((item) => item.scheme === "vscode-webview")?.privileges?.allowServiceWorkers,
    ).toBe(true);
    expect(schemes.some((item) => item.privileges?.bypassCSP)).toBe(false);
  });
});
