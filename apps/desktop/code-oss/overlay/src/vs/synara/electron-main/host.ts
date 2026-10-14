/* Synara's embedding seam. No Electron executable or second application is launched. */
import type { BrowserWindow, Menu, WebContents, Session } from "electron";
import type { NativeParsedArgs } from "../../platform/environment/common/argv.js";

export interface SynaraNativeHost {
  ownsNativeContents(contents: WebContents | null): boolean;
  isAgentContents(contents: WebContents | null): boolean;
  checkAgentPermission: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
  requestAgentPermission: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
  readonly args: NativeParsedArgs;
  onWindow(window: BrowserWindow): void;
  onLifecycle(
    window: BrowserWindow,
    lifecycle: { check(): Promise<boolean>; unload(): Promise<void>; reload(): void },
  ): void;
  canQuit(): boolean;
  isPrepared(windowId: number): boolean;
  isPrimary(windowId: number): boolean;
  focus(window: BrowserWindow): boolean;
  setMenu(menu: Menu | null): void;
}
export function synaraHost(): SynaraNativeHost | undefined {
  return (globalThis as typeof globalThis & { __SYNARA_EMBEDDED_CODE_OSS__?: SynaraNativeHost })
    .__SYNARA_EMBEDDED_CODE_OSS__;
}
