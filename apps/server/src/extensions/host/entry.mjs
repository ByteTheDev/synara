// Bundled with the pinned, MIT-licensed Code-OSS source. Only the extension
// child loads these services; no graphical workbench or renderer is imported.
import "@code-oss/vs/workbench/api/common/extHost.common.services.js";
import "@code-oss/vs/workbench/api/node/extHost.node.services.js";
import { ExtensionHostMain } from "@code-oss/vs/workbench/api/common/extensionHostMain.js";
import { MainContext, ExtHostContext } from "@code-oss/vs/workbench/api/common/extHost.protocol.js";
import { RPCProtocol } from "@code-oss/vs/workbench/services/extensions/common/rpcProtocol.js";
import { Emitter } from "@code-oss/vs/base/common/event.js";
import { URI } from "@code-oss/vs/base/common/uri.js";
import { VSBuffer } from "@code-oss/vs/base/common/buffer.js";
import { CancellationToken } from "@code-oss/vs/base/common/cancellation.js";
import { ExtensionIdentifier } from "@code-oss/vs/platform/extensions/common/extensions.js";
import { registerSingleton, InstantiationType } from "@code-oss/vs/platform/instantiation/common/extensions.js";
import { ILogService, NullLogService, LogLevel } from "@code-oss/vs/platform/log/common/log.js";
import { lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

registerSingleton(ILogService, NullLogService, InstantiationType.Eager);
const MAX_FRAME = 8 * 1_024 * 1_024;
const output = process.stdout.write.bind(process.stdout);
let token;
let host;
let rpc;
let initialization;
let nextRequest = 1;
const pending = new Map();
const providers = new Map();
const commands = new Set();
const documents = new Map();
const diagnostics = new Map();
const activeExtensions = new Set();
let activeEditor = null;

function send(message) {
  const contents = JSON.stringify({ ...message, token });
  if (Buffer.byteLength(contents) > MAX_FRAME) throw new Error("Extension host response exceeds its size limit.");
  output(contents + "\n");
}
function event(name, body) { send({ kind: "event", event: name, body }); }
function parent(method, params, timeout = 30_000) {
  if (pending.size >= 128) return Promise.reject(new Error("Too many pending extension requests."));
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Synara did not answer ${method} in time.`)); }, timeout).unref();
    pending.set(id, { resolve, reject, timer });
    send({ kind: "request", id, method, params });
  });
}
function proxy(name, handlers) {
  return new Proxy(handlers, {
    get(target, method) {
      if (method === "then") return undefined;
      if (typeof method !== "string") return target[method];
      return target[method] ?? (() => { throw new Error(`Unsupported Synara extension API: ${name}.${method}`); });
    },
  });
}
function actor(name) { return rpc.getProxy(ExtHostContext[name]); }
function uri(value) { return typeof value === "string" ? URI.parse(value) : URI.revive(value); }
function endpoint(value) {
  const resource = uri(value);
  if (resource.scheme !== "file" || resource.authority) throw new Error("Only local file resources are supported.");
  return resource;
}
function configurationModel(values) {
  const contents = Object.create(null);
  const keys = [];
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split(".");
    if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) continue;
    let target = contents;
    for (const part of parts.slice(0, -1)) target = target[part] ??= Object.create(null);
    target[parts.at(-1)] = value;
    keys.push(key);
  }
  return { contents, keys, overrides: [] };
}
function configurationData(extensions, values) {
  const defaults = {};
  for (const extension of extensions) {
    const config = extension.contributes?.configuration;
    for (const item of Array.isArray(config) ? config : [config]) {
      for (const [key, property] of Object.entries(item?.properties ?? {})) {
        if (property && "default" in property) defaults[key] = property.default;
      }
    }
  }
  const empty = configurationModel({});
  return { configurationScopes: [], defaults: configurationModel(defaults), policy: empty,
    application: empty, userLocal: configurationModel(values), userRemote: empty,
    workspace: empty, folders: [] };
}
const registrations = new Map([
  ["$registerDocumentFormattingSupport", "format"], ["$registerRangeFormattingSupport", "rangeFormat"],
  ["$registerCompletionsProvider", "completion"], ["$registerHoverProvider", "hover"],
  ["$registerSignatureHelpProvider", "signature"], ["$registerDefinitionSupport", "definition"],
  ["$registerDeclarationSupport", "declaration"], ["$registerTypeDefinitionSupport", "typeDefinition"],
  ["$registerImplementationSupport", "implementation"], ["$registerReferenceSupport", "references"],
  ["$registerDocumentSymbolProvider", "documentSymbols"], ["$registerNavigateTypeSupport", "workspaceSymbols"],
  ["$registerCodeActionSupport", "codeActions"], ["$registerRenameSupport", "rename"],
  ["$registerFoldingRangeProvider", "folding"], ["$registerInlayHintsProvider", "inlayHints"],
  ["$registerDocumentSemanticTokensProvider", "semanticTokens"],
]);

function installMainThreadActors() {
  const language = {
    $unregister(handle) { providers.delete(handle); event("providers", [...providers.values()]); },
    $setLanguageConfiguration() {},
  };
  for (const [method, kind] of registrations) language[method] = (handle, selector, ...metadata) => {
    providers.set(handle, { handle, kind, selector, metadata });
    event("providers", [...providers.values()]);
  };
  const handlers = {
    MainThreadLanguageFeatures: language,
    MainThreadExtensionService: {
      $onWillActivateExtension(id) { event("activating", id); },
      $onDidActivateExtension(id, ...timing) { activeExtensions.add(id.value ?? id); event("activated", { id, timing }); },
      $onExtensionActivationError(id, error, missing) { event("activationError", { id, error, missing }); },
      $onExtensionRuntimeError(id, error) { event("extensionError", { id, error }); },
      $activateExtension(id, reason) { return host.extensionService.activateByIdWithErrors(new ExtensionIdentifier(id.value ?? id), reason); },
      $setPerformanceMarks() {},
    },
    MainThreadConsole: { $logExtensionHostMessage(message) { event("output", message); } },
    MainThreadErrors: { $onUnexpectedError(error) { event("error", error); } },
    MainThreadTelemetry: { $publicLog() {}, $publicLog2() {}, $publicLogError() {}, $publicLogError2() {}, $onExtensionError() {} },
    MainThreadStorage: {
      async $initializeExtensionStorage(shared, key) {
        const value = await parent("storage.get", { shared, key });
        return value === undefined || value === null ? undefined : JSON.stringify(value);
      },
      $setValue(shared, key, value) { return parent("storage.set", { shared, key, value }); },
      $registerExtensionStorageKeysToSync() {},
    },
    MainThreadCommands: {
      $registerCommand(id) { commands.add(id); event("commands", [...commands]); },
      $unregisterCommand(id) { commands.delete(id); event("commands", [...commands]); },
      $getCommands() { return [...commands]; },
      $fireCommandActivationEvent(id) { void host.extensionService.activateByEvent(`onCommand:${id}`, 0); },
      $executeCommand(id, args) { return parent("command", { id, args }); },
    },
    MainThreadDiagnostics: {
      $changeMany(owner, entries) { diagnostics.set(owner, entries); event("diagnostics", { owner, entries }); },
      $clear(owner) { diagnostics.delete(owner); event("diagnostics", { owner, entries: [] }); },
    },
    MainThreadConfiguration: {
      $updateConfigurationOption(...args) { return parent("configuration.update", { args }); },
      $removeConfigurationOption(...args) { return parent("configuration.remove", { args }); },
    },
    MainThreadWindow: {
      $getInitialState() { return { focused: true, active: true }; },
      $openUri(resource, options) { return parent("window.openUri", { resource, options }); },
      $asExternalUri() { throw new Error("Extension URI tunnelling is not supported."); },
    },
    MainThreadMessageService: { $showMessage(severity, message, options, items) {
      return parent("ui.message", { severity, message, options, items }, 120_000);
    } },
    MainThreadProgress: {
      $startProgress(handle, options, extension) { event("progress.start", { handle, options, extension }); },
      $progressReport(handle, step) { event("progress.report", { handle, step }); },
      $progressEnd(handle) { event("progress.end", { handle }); },
    },
    MainThreadQuickOpen: {
      $show(instance, options) { return parent("ui.quickPick", { instance, options }, 120_000); },
      $setItems(instance, items) { event("quickPick.items", { instance, items }); },
      $setError(instance, error) { event("quickPick.error", { instance, error }); },
      $input(options, validateInput) { return parent("ui.input", { options, validateInput }, 120_000); },
      $createOrUpdate(params) { event("quickInput.update", params); },
      $dispose(sessionId) { event("quickInput.dispose", { sessionId }); },
    },
    MainThreadStatusBar: {
      $setEntry(...args) { event("status.set", { args }); },
      $disposeEntry(id) { event("status.remove", { id }); },
    },
    MainThreadTreeViews: {
      $registerTreeViewDataProvider(id, options) { event("tree.register", { id, options }); },
      $refresh(id, items) { event("tree.refresh", { id, items }); },
      $disposeTree(id) { event("tree.remove", { id }); },
      $reveal(id, item, parentChain, options) { return parent("tree.reveal", { id, item, parentChain, options }); },
      $setMessage(id, message) { event("tree.message", { id, message }); },
      $setTitle(id, title, description) { event("tree.title", { id, title, description }); },
      $setBadge(id, badge) { event("tree.badge", { id, badge }); },
    },
    MainThreadOutputService: {
      $register(label, file, languageId, extensionId) { const id = randomUUID(); event("output.register", { id, label, file, languageId, extensionId }); return id; },
      $update(...args) { event("output.update", { args }); },
      $dispose(id) { event("output.remove", { id }); },
      $reveal(id, preserveFocus) { return parent("output.reveal", { id, preserveFocus }); },
      $close(id) { event("output.close", { id }); },
    },
    MainThreadWorkspace: {
      $checkExists(folders, includes) { return parent("workspace.exists", { folders, includes }); },
      $startFileSearch(...args) { return parent("workspace.findFiles", { args }); },
      $startTextSearch(...args) { return parent("workspace.searchText", { args }); },
      $requestWorkspaceTrust() { return true; },
      $saveAll() { return parent("documents.saveAll", {}); },
    },
    MainThreadFileSystem: {
      $stat(resource) { return parent("fs.stat", { resource: endpoint(resource) }); },
      $readdir(resource) { return parent("fs.readdir", { resource: endpoint(resource) }); },
      async $readFile(resource) { return VSBuffer.wrap(Buffer.from(await parent("fs.read", { resource: endpoint(resource) }), "base64")); },
      $writeFile(resource, content, options) { return parent("fs.write", { resource: endpoint(resource), contents: Buffer.from(content.buffer).toString("base64"), options }); },
      $mkdir(resource) { return parent("fs.mkdir", { resource: endpoint(resource) }); },
      $delete(resource, options) { return parent("fs.delete", { resource: endpoint(resource), options }); },
      $rename(source, target, options) { return parent("fs.rename", { source: endpoint(source), target: endpoint(target), options }); },
      $copy(source, target, options) { return parent("fs.copy", { source: endpoint(source), target: endpoint(target), options }); },
      $ensureActivation() {},
    },
    MainThreadFileSystemEventService: {
      $watch(extensionId, session, resource, options) { event("watch.add", { extensionId, session, resource, options }); },
      $unwatch(session) { event("watch.remove", { session }); },
    },
    MainThreadDocuments: {
      async $tryOpenDocument(resource) { const document = await parent("documents.open", { resource: endpoint(resource) }); await syncDocument(document); return uri(resource); },
      $trySaveDocument(resource) { return parent("documents.save", { resource: endpoint(resource) }); },
    },
    MainThreadTextEditors: {
      $tryApplyEdits(id, versionId, edits, options) { return parent("documents.applyEdits", { id, versionId, edits, options }); },
      $tryShowTextDocument(resource, options) { return parent("documents.show", { resource: endpoint(resource), options }); },
      $trySetSelections(id, selections) { return parent("editor.selections", { id, selections }); },
      $tryRevealRange(id, range, revealType) { return parent("editor.reveal", { id, range, revealType }); },
      $registerTextEditorDecorationType() { throw new Error("Custom extension decorations are not yet supported by the native renderer."); },
    },
    MainThreadBulkEdits: { $tryApplyWorkspaceEdit(edit, undoRedoGroupId, isRefactoring) { return parent("documents.workspaceEdit", { edit, undoRedoGroupId, isRefactoring }); } },
    MainThreadLanguages: {
      $getLanguages() { return initialization.languages ?? ["plaintext", "javascript", "typescript", "json", "yaml", "python", "markdown", "html", "css"]; },
      $changeLanguage(resource, languageId) { return parent("documents.language", { resource, languageId }); },
    },
    MainThreadDebugService: {
      $registerDebugTypes(types) { event("debug.types", { types }); },
      $registerDebugConfigurationProvider(...args) { event("debug.configurationProvider", { args }); },
      $unregisterDebugConfigurationProvider(handle) { event("debug.configurationProvider.remove", { handle }); },
      $registerDebugAdapterDescriptorFactory(...args) { event("debug.factory", { args }); },
      $unregisterDebugAdapterDescriptorFactory(handle) { event("debug.factory.remove", { handle }); },
      $acceptDAMessage(handle, message) { event("debug.message", { handle, message }); },
      $acceptDAError(handle, name, message, stack) { event("debug.error", { handle, name, message, stack }); },
      $acceptDAExit(handle, code, signal) { event("debug.exit", { handle, code, signal }); },
      $startDebugging(folder, configuration, options) { return parent("debug.start", { folder, configuration, options }); },
      $stopDebugging(id) { return parent("debug.stop", { id }); },
    },
  };
  for (const [name, identifier] of Object.entries(MainContext)) rpc.set(identifier, proxy(name, handlers[name] ?? {}));
}

async function boot(params) {
  if (host) throw new Error("Extension host is already initialized.");
  initialization = params;
  const workspace = URI.file(params.workspace);
  const fromExtension = new Emitter();
  const fromMain = new Emitter();
  rpc = new RPCProtocol({ onMessage: fromExtension.event, send: (buffer) => queueMicrotask(() => fromMain.fire(buffer)) });
  installMainThreadActors();
  const extensions = params.extensions.map(({ manifest, directory }) => ({ ...manifest,
    identifier: new ExtensionIdentifier(`${manifest.publisher}.${manifest.name}`.toLowerCase()),
    extensionLocation: URI.file(directory), isBuiltin: false, isUserBuiltin: false,
    isUnderDevelopment: false, targetPlatform: "universal", enabledApiProposals: [],
  }));
  const workspaceId = params.workspaceId ?? randomUUID();
  const root = dirname(fileURLToPath(import.meta.url));
  const init = {
    version: "1.138.0", quality: "stable", commit: "7debcd0e2acdea1c52de81bf9ee1620444407dda",
    parentPid: process.ppid, autoStart: true,
    environment: { isExtensionDevelopmentDebug: false, appName: "Synara", appHost: "desktop",
      appRoot: URI.file(root), appLanguage: "en", appUriScheme: "synara", isExtensionTelemetryLoggingOnly: true,
      globalStorageHome: URI.file(params.storage + "/global"), workspaceStorageHome: URI.file(params.storage + "/workspaces"),
      skipWorkspaceStorageLock: true, useHostProxy: false },
    workspace: { id: workspaceId, name: basename(params.workspace), configuration: undefined, transient: false, isUntitled: false },
    extensions: { versionId: 1, allExtensions: extensions, myExtensions: extensions.map((extension) => extension.identifier),
      activationEvents: Object.fromEntries(params.extensions.map((entry) => [`${entry.manifest.publisher}.${entry.manifest.name}`.toLowerCase(), entry.activationEvents ?? []])) },
    telemetryInfo: { sessionId: randomUUID(), machineId: "synara-extension-host", sqmId: "", devDeviceId: "", firstSessionDate: "" },
    logLevel: LogLevel.Off, loggers: [], logsLocation: URI.file(params.storage + "/logs"),
    remote: { isRemote: false, authority: undefined, connectionData: null },
    consoleForward: { includeStack: false, logNative: false }, uiKind: 1,
  };
  host = new ExtensionHostMain({ onMessage: fromMain.event, send: (buffer) => queueMicrotask(() => fromExtension.fire(buffer)) }, init,
    { pid: process.pid, exit: (code) => process.exit(code), exists: (file) => lstat(file).then(() => true, () => false), realpath }, null);
  await actor("ExtHostConfiguration").$initializeConfiguration(configurationData(extensions, params.configuration ?? {}));
  await actor("ExtHostWorkspace").$initializeWorkspace({ id: workspaceId, name: basename(params.workspace),
    folders: [{ uri: workspace, name: basename(params.workspace), index: 0 }], configuration: undefined }, true);
  await host.extensionService.getExtensionRegistry();
  for (const document of params.documents ?? []) await syncDocument(document);
  return { apiVersion: "1.138.0", pid: process.pid, upstream: true, extensions: extensions.map((extension) => extension.identifier.value) };
}

async function syncDocument(document) {
  const resource = URI.file(document.path);
  const key = resource.toString();
  const previous = documents.get(key);
  if (!Number.isSafeInteger(document.version) || document.version < 1 || typeof document.contents !== "string") throw new Error("Invalid native document snapshot.");
  if (previous && document.version < previous.version) throw new Error("Stale native document snapshot.");
  if (previous && document.version === previous.version && document.contents !== previous.contents) throw new Error("Conflicting native document version.");
  if (previous && document.contents !== previous.contents) {
    const lines = previous.contents.split(/\r\n|\r|\n/);
    await actor("ExtHostDocuments").$acceptModelChanged(resource, { versionId: document.version,
      changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1).length + 1 },
        rangeOffset: 0, rangeLength: previous.contents.length, text: document.contents }],
      EOL: document.contents.includes("\r\n") ? "\r\n" : "\n", isUndoing: false, isRedoing: false }, Boolean(document.dirty));
  } else if (!previous) {
    await actor("ExtHostDocumentsAndEditors").$acceptDocumentsAndEditorsDelta({ addedDocuments: [{ uri: resource,
      lines: document.contents.split(/\r\n|\r|\n/), EOL: document.contents.includes("\r\n") ? "\r\n" : "\n",
      versionId: document.version, languageId: document.languageId ?? "plaintext", isDirty: Boolean(document.dirty), encoding: "utf8" }] });
  }
  documents.set(key, document);
  if (document.active && activeEditor !== key) {
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
    await actor("ExtHostDocumentsAndEditors").$acceptDocumentsAndEditorsDelta({
      removedEditors: activeEditor ? [activeEditor] : [], addedEditors: [{ id: key, documentUri: resource,
        selections: [{ ...range, selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 1 }],
        options: { tabSize: 2, indentSize: 2, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 }, visibleRanges: [range], editorPosition: 0 }], newActiveEditor: key,
    });
    activeEditor = key;
  }
}
async function language(params) {
  const provider = providers.get(params.handle);
  if (!provider) throw new Error("Extension language provider is no longer registered.");
  const resource = URI.file(params.path);
  const position = params.position ?? { lineNumber: 1, column: 1 };
  const range = params.range ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  const target = actor("ExtHostLanguageFeatures");
  const cancellation = CancellationToken.None;
  switch (provider.kind) {
    case "format": return target.$provideDocumentFormattingEdits(params.handle, resource, params.options ?? { tabSize: 2, insertSpaces: true }, cancellation);
    case "rangeFormat": return target.$provideDocumentRangeFormattingEdits(params.handle, resource, range, params.options ?? { tabSize: 2, insertSpaces: true }, cancellation);
    case "completion": return target.$provideCompletionItems(params.handle, resource, position, params.context ?? { triggerKind: 0 }, cancellation);
    case "hover": return target.$provideHover(params.handle, resource, position, params.context, cancellation);
    case "signature": return target.$provideSignatureHelp(params.handle, resource, position, params.context ?? { triggerKind: 1, isRetrigger: false }, cancellation);
    case "definition": return target.$provideDefinition(params.handle, resource, position, cancellation);
    case "declaration": return target.$provideDeclaration(params.handle, resource, position, cancellation);
    case "typeDefinition": return target.$provideTypeDefinition(params.handle, resource, position, cancellation);
    case "implementation": return target.$provideImplementation(params.handle, resource, position, cancellation);
    case "references": return target.$provideReferences(params.handle, resource, position, { includeDeclaration: true }, cancellation);
    case "documentSymbols": return target.$provideDocumentSymbols(params.handle, resource, cancellation);
    case "workspaceSymbols": return target.$provideWorkspaceSymbols(params.handle, params.query ?? "", cancellation);
    case "codeActions": return target.$provideCodeActions(params.handle, resource, range, params.context ?? { trigger: 1 }, cancellation);
    case "rename": return target.$provideRenameEdits(params.handle, resource, position, params.newName, cancellation);
    case "folding": return target.$provideFoldingRanges(params.handle, resource, {}, cancellation);
    case "inlayHints": return target.$provideInlayHints(params.handle, resource, range, cancellation);
    case "semanticTokens": return target.$provideDocumentSemanticTokens(params.handle, resource, 0, cancellation);
    default: throw new Error(`Unsupported language request ${provider.kind}.`);
  }
}
async function dispatch(message) {
  if (message.method === "initialize") {
    if (token || typeof message.token !== "string" || message.token.length < 32) throw new Error("Invalid extension host initialization.");
    token = message.token;
    return boot(message.params);
  }
  if (!host || message.token !== token) throw new Error("Unauthenticated extension host message.");
  switch (message.method) {
    case "activate": {
      if (message.params.id) {
        const id = new ExtensionIdentifier(message.params.id);
        await host.extensionService.activateByIdWithErrors(id, { startup: false, extensionId: id, activationEvent: message.params.event ?? "onCommand:synara.activate" });
      } else await host.extensionService.activateByEvent(message.params.event, 0);
      return { active: [...activeExtensions], providers: [...providers.values()], commands: [...commands] };
    }
    case "documents": for (const document of message.params.documents) await syncDocument(document); return true;
    case "language": return language(message.params);
    case "command": return actor("ExtHostCommands").$executeContributedCommand(message.params.id, ...(message.params.args ?? []));
    case "state": return { active: [...activeExtensions], providers: [...providers.values()], commands: [...commands], diagnostics: [...diagnostics] };
    case "shutdown": host.terminate("Synara requested shutdown"); return true;
    default: throw new Error(`Unknown extension host operation ${message.method}.`);
  }
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_FRAME) { process.stderr.write("Extension host input limit exceeded.\n"); process.exit(2); }
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { process.exit(2); }
    if (message.kind === "response") {
      if (message.token !== token) process.exit(2);
      const request = pending.get(message.id);
      if (request) { clearTimeout(request.timer); pending.delete(message.id); message.ok ? request.resolve(message.result) : request.reject(new Error(message.error ?? "Synara rejected the extension request.")); }
    } else if (message.kind === "request") {
      void dispatch(message).then((result) => send({ kind: "response", id: message.id, ok: true, result }),
        (error) => send({ kind: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error), stack: error?.stack }));
    } else process.exit(2);
  }
});
process.stdin.on("end", () => host ? host.terminate("Synara disconnected") : process.exit(0));
process.on("SIGTERM", () => host ? host.terminate("Synara terminated host") : process.exit(0));
