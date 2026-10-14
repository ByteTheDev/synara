/* Test-only extension installed into an isolated smoke profile, never bundled. */
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

exports.activate = (context) => {
  const config = JSON.parse(
    fs.readFileSync(path.join(context.extensionPath, "probe.json"), "utf8"),
  );
  const state = { extensionHostPid: process.pid, activated: true, debugStopped: false };
  const uri = vscode.Uri.file(path.join(config.workspace, "sample.ts"));
  function report(extra = {}) {
    const editor = vscode.window.activeTextEditor;
    const git = vscode.extensions.getExtension("vscode.git");
    const repositories = git?.isActive ? git.exports.getAPI(1).repositories : [];
    Object.assign(state, extra, {
      editor: editor
        ? {
            path: editor.document.uri.fsPath,
            text: editor.document.getText(),
            dirty: editor.document.isDirty,
          }
        : null,
      diagnostics: vscode.languages
        .getDiagnostics(uri)
        .map((item) => ({ message: item.message, severity: item.severity })),
      terminals: vscode.window.terminals.map((terminal) => terminal.name),
      git: repositories.map((repo) => ({
        root: repo.rootUri.fsPath,
        changes: repo.state.workingTreeChanges.map((change) => change.uri.fsPath),
      })),
      typescriptActive: Boolean(
        vscode.extensions.getExtension("vscode.typescript-language-features")?.isActive,
      ),
      debugSession: vscode.debug.activeDebugSession?.id ?? null,
    });
    const temporary = config.output + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, config.output);
  }
  const command = (id, action) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await action();
          report({ command: id, error: null });
        } catch (error) {
          report({ command: id, error: String(error.stack ?? error) });
          throw error;
        }
      }),
    );
  command("synaraSmoke.open", async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });
  command("synaraSmoke.inspect", async () => report());
  command("synaraSmoke.languages", async () => {
    const extension = vscode.extensions.getExtension("vscode.typescript-language-features");
    if (!extension) throw new Error("Built-in TypeScript extension is absent");
    await extension.activate();
    const definitions = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      uri,
      new vscode.Position(1, 24),
    );
    const completions = await vscode.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      uri,
      new vscode.Position(4, 9),
    );
    report({
      definitionCount: definitions?.length ?? 0,
      completionLabels: (completions?.items ?? []).map((item) =>
        typeof item.label === "string" ? item.label : item.label.label,
      ),
    });
  });
  command("synaraSmoke.selection", async () => {
    const editor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    editor.selection = new vscode.Selection(0, 0, 2, 0);
    await vscode.commands.executeCommand("synara.sendSelection");
  });
  command("synaraSmoke.debug", async () => {
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), {
      name: "Synara native acceptance",
      type: "pwa-node",
      request: "launch",
      program: path.join(config.workspace, "debug.cjs"),
      cwd: config.workspace,
      runtimeExecutable: config.node,
      stopOnEntry: true,
      console: "internalConsole",
    });
    if (!started) throw new Error("Native JavaScript debugger refused to start");
  });
  command("synaraSmoke.stopDebug", async () => vscode.debug.stopDebugging());
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message) {
            if (message.type === "event" && message.event === "stopped") {
              state.debugStopped = true;
              session
                .customRequest("stackTrace", { threadId: message.body.threadId, levels: 3 })
                .then(
                  (stack) =>
                    report({
                      stackFrames: stack.stackFrames.map((frame) => ({
                        name: frame.name,
                        line: frame.line,
                        path: frame.source?.path,
                      })),
                    }),
                  (error) => report({ debugError: String(error) }),
                );
            }
          },
        };
      },
    }),
  );
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => report()));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(() => report()));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => report()));
  report();
};
