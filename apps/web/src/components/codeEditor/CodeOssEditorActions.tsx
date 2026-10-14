import type { DesktopIdeCommand, DesktopIdeDocument } from "@synara/contracts";
import { useState } from "react";
import { useDesktopIdeStore } from "~/desktopIdeStore";
import { readReadyCodeOssBridge } from "~/lib/desktopIdeBridge";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { ChatHeaderIconButton } from "../chat/chatHeaderControls";
import { Menu, MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

/** One compact action menu in the existing editor header, not another IDE mode. */
export function CodeOssEditorActions({ document }: { document: DesktopIdeDocument }) {
  const debugState = useDesktopIdeStore((store) => store.debugState);
  const ready = useDesktopIdeStore((store) => store.state?.status === "ready");
  const [busy, setBusy] = useState(false);
  const run = (command: DesktopIdeCommand) => {
    const bridge = readReadyCodeOssBridge(document.root);
    if (!bridge || busy) return;
    setBusy(true);
    void bridge.request({ kind: "editor.command", command, document }).catch((error: unknown) => {
      toastManager.add({
        type: "error", title: "Editor command failed",
        description: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => setBusy(false));
  };
  return (
    <Menu>
      <ChatHeaderIconButton render={<MenuTrigger />} tone="plain" label="Editor tools" title="Editor tools" disabled={!ready || busy}>
        <span aria-hidden="true">…</span>
      </ChatHeaderIconButton>
      <ComposerPickerMenuPopup align="end">
        <MenuSub>
          <MenuSubTrigger>Code</MenuSubTrigger>
          <MenuSubPopup surface="composer">
            <MenuItem onClick={() => run("suggest")}>Completions</MenuItem>
            <MenuItem onClick={() => run("definition")}>Go to definition</MenuItem>
            <MenuItem onClick={() => run("references")}>Find references</MenuItem>
            <MenuItem onClick={() => run("rename")}>Rename symbol</MenuItem>
            <MenuItem onClick={() => run("format")}>Format document</MenuItem>
            <MenuItem onClick={() => run("problems")}>Problems</MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Debug</MenuSubTrigger>
          <MenuSubPopup surface="composer">
            <MenuItem onClick={() => run("debugStart")} disabled={debugState !== "inactive"}>Start debugging</MenuItem>
            <MenuItem onClick={() => run("debugConfigure")}>Configure debugger</MenuItem>
            <MenuItem onClick={() => run("breakpoint")}>Toggle breakpoint</MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => run("debugContinue")} disabled={debugState !== "stopped"}>Continue</MenuItem>
            <MenuItem onClick={() => run("debugPause")} disabled={debugState !== "running"}>Pause</MenuItem>
            <MenuItem onClick={() => run("debugStepOver")} disabled={debugState !== "stopped"}>Step over</MenuItem>
            <MenuItem onClick={() => run("debugStepInto")} disabled={debugState !== "stopped"}>Step into</MenuItem>
            <MenuItem onClick={() => run("debugStepOut")} disabled={debugState !== "stopped"}>Step out</MenuItem>
            <MenuItem onClick={() => run("debugConsole")} disabled={debugState === "inactive"}>Console, variables and call stack</MenuItem>
            <MenuItem onClick={() => run("debugRestart")} disabled={debugState === "inactive"}>Restart debugging</MenuItem>
            <MenuItem onClick={() => run("debugStop")} disabled={debugState === "inactive"}>Stop debugging</MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Add to chat draft</MenuSubTrigger>
          <MenuSubPopup surface="composer">
            <MenuItem onClick={() => run("sendSelection")}>Selected code</MenuItem>
            <MenuItem onClick={() => run("sendDiagnostics")}>File diagnostics</MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem onClick={() => run("extensions")}>Extensions</MenuItem>
        <MenuItem onClick={() => run("commands")}>Command palette</MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
