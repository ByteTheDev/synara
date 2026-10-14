import type { CustomScheme } from "electron";
/** Electron accepts one registration call before ready, shared by both retained views. */
export function desktopPrivilegedSchemes(
  desktopScheme: string,
  previewScheme: string,
  nativeIde: boolean,
): CustomScheme[] {
  const local: CustomScheme[] = [
    {
      scheme: desktopScheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
    { scheme: previewScheme, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ];
  if (nativeIde)
    local.push(
      {
        scheme: "vscode-webview",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          allowServiceWorkers: true,
          codeCache: true,
        },
      },
      {
        scheme: "vscode-file",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          codeCache: true,
        },
      },
      {
        scheme: "vscode-remote-resource",
        privileges: { secure: true, supportFetchAPI: true, corsEnabled: true },
      },
      {
        scheme: "vscode-managed-remote-resource",
        privileges: { secure: true, supportFetchAPI: true, corsEnabled: true },
      },
    );
  return local;
}
