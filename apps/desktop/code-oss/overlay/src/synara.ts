/* Starts the native Code-OSS services inside the already-running Synara Electron process. */
import { app } from "electron";
import { resolveNLSConfiguration } from "./vs/base/node/nls.js";
import { synaraHost } from "./vs/synara/electron-main/host.js";

export async function start(locale: string): Promise<void> {
  if (!synaraHost() || !app.isReady()) {
    throw new Error("Code-OSS must be hosted by the existing Synara desktop lifecycle.");
  }
  process.env["VSCODE_NLS_CONFIG"] = JSON.stringify(
    await resolveNLSConfiguration({
      userLocale: locale,
      osLocale: locale,
      userDataPath: app.getPath("userData"),
      nlsMetadataPath: import.meta.dirname,
      commit: undefined,
    }),
  );
  const { bootstrapESM } = await import("./bootstrap-esm.js");
  await bootstrapESM();
  const { CodeMain } = await import("./vs/code/electron-main/main.js");
  await new CodeMain().startup();
}
