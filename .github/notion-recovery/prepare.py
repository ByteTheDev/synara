"""Temporary, exact source integration edits. No branch writes or dependency changes."""
from pathlib import Path
import re
import subprocess

root = Path.cwd()
def replace(name, old, new, count=1):
    path = root / name
    text = path.read_text()
    if text.count(old) != count:
        raise RuntimeError(f'{name}: expected {count} exact anchors, got {text.count(old)} for {old[:100]}')
    path.write_text(text.replace(old, new))
def prepend(name, text):
    path = root / name
    path.write_text(text + path.read_text())
def regex(name, pattern, replacement):
    path = root / name
    text, count = re.subn(pattern, replacement, path.read_text())
    if count != 1:
        raise RuntimeError(f'{name}: expected one regex anchor, got {count}: {pattern}')
    path.write_text(text)

replace('packages/contracts/src/index.ts', 'export * from "./mcpConnectors";', 'export * from "./mcpConnectors";\nexport * from "./notion";\nexport * from "./notionRpc";')
replace('packages/shared/package.json', '  "exports": {', '  "exports": {\n    "./notion": {\n      "types": "./src/notion.ts",\n      "import": "./src/notion.ts"\n    },')
prepend('packages/contracts/src/todo.ts', 'import { NotionTodoReference } from "./notion";\n')
replace('packages/contracts/src/todo.ts', 'export const Todo = Schema.Struct({', 'export const Todo = Schema.Struct({\n  external: Schema.optional(NotionTodoReference),')
prepend('packages/contracts/src/ipc.ts', 'import type { NotionApi } from "./notion";\n')
regex('packages/contracts/src/ipc.ts', r'(export (?:interface NativeApi|type NativeApi\s*=)\s*\{)', r'\1\n  readonly notion?: NotionApi;')

# Recover the existing public transport, without a second socket or authentication system.
prepend('apps/web/src/wsTransport.ts', 'import { NotionRpcs } from "@synara/contracts";\n')
replace('apps/web/src/wsTransport.ts', 'WsFeatureRpcGroup.merge(WsDeviceRpcGroup).merge(WsComputerRpcGroup).merge(WsProjectAgentRpcGroup),', 'WsFeatureRpcGroup.merge(WsDeviceRpcGroup).merge(WsComputerRpcGroup).merge(WsProjectAgentRpcGroup).merge(NotionRpcs),')
prepend('apps/web/src/wsNativeApi.ts', 'import { NOTION_WS_METHODS } from "@synara/contracts";\n')
methods = ['state', 'connect', 'complete', 'disconnect', 'read', 'write', 'saveMapping', 'deleteMapping', 'sync', 'resolve']
api = '    notion: {\n' + ''.join(f'      {method}: ' + ('()' if method in ['state','connect','sync'] else '(input)') + f' => transport.request(NOTION_WS_METHODS.{method}' + (')' if method in ['state','connect','sync'] else ', input)') + ',\n' for method in methods) + '    },\n'
regex('apps/web/src/wsNativeApi.ts', r'(const api: NativeApi = \{\n)', lambda match: match[1] + api)
prepend('apps/server/src/serverLayers.ts', 'import { NotionIntegrationLive } from "./notion/Layers/NotionIntegration";\n')
replace('apps/server/src/serverLayers.ts', 'const todoServiceLayer = TodoServiceLive.pipe(Layer.provideMerge(TodoRepositoryLive));', 'const notionLayer = NotionIntegrationLive.pipe(Layer.provideMerge(ServerSecretStoreLive));\n  const todoServiceLayer = TodoServiceLive.pipe(Layer.provideMerge(TodoRepositoryLive), Layer.provideMerge(notionLayer));')
prepend('apps/server/src/wsRpc.ts', 'import { NotionRpcs } from "@synara/contracts";\nimport { NotionIntegration } from "./notion/Services/NotionIntegration";\nimport { makeNotionHandlers, ownerScopedNotionTodos } from "./notion/wsHandlers";\n')
replace('apps/server/src/wsRpc.ts', '.merge(WsProjectAgentRpcGroup)\n  .middleware(', '.merge(WsProjectAgentRpcGroup)\n  .merge(NotionRpcs)\n  .middleware(')
replace('apps/server/src/wsRpc.ts', 'const todoService = yield* TodoService;', 'const todoService = ownerScopedNotionTodos(yield* TodoService);\n      const optionalNotion = yield* Effect.serviceOption(NotionIntegration);\n      const notionIntegration = Option.getOrNull(optionalNotion);')
replace('apps/server/src/wsRpc.ts', '...makeWsDeviceHandlers(deviceService),', '...makeWsDeviceHandlers(deviceService),\n        ...makeNotionHandlers(notionIntegration),')
replace('apps/server/src/notion/wsHandlers.ts', 'export function ownerScopedNotionTodos(todos: TodoServiceShape): TodoServiceShape {', 'export function ownerScopedNotionTodos(todos: TodoServiceShape) {')
# Existing unscoped agent tools must not bypass Notion resource permission checks.
replace('apps/server/src/agentGateway/todoTools.ts', 'const all = (yield* todos.list().pipe(Effect.mapError(toToolError))).todos;', 'const all = (yield* todos.list().pipe(Effect.mapError(toToolError))).todos.filter(todo => !todo.id.startsWith("notion:"));')
replace('apps/server/src/agentGateway/todoTools.ts', 'const todoId = yield* readArgs(() => readStringArg(args, "todoId", { required: true })!);', 'const todoId = yield* readArgs(() => readStringArg(args, "todoId", { required: true })!);\n        if (todoId.startsWith("notion:")) return yield* Effect.fail(new ToolInputError("Notion tasks require scoped provider permissions. Use the task context explicitly shared by the user instead."));')

# Connect the UI to existing settings and task details, not a separate product route.
prepend('apps/web/src/routes/_chat.settings.tsx', 'import { NotionSettingsPanel } from "../components/settings/NotionSettingsPanel";\n')
replace('apps/web/src/routes/_chat.settings.tsx', '<ExternalMcpSettingsPanel active={activeSection === "integrations"} />', '<NotionSettingsPanel active={activeSection === "integrations"} />\n                <ExternalMcpSettingsPanel active={activeSection === "integrations"} />')
prepend('apps/web/src/components/tasks/TaskCard.tsx', 'import { NotionTaskDetails } from "../notion/NotionTaskDetails";\n')
replace('apps/web/src/components/tasks/TaskCard.tsx', '      <TaskCardProperties\n', '      <NotionTaskDetails todo={todo} />\n      <TaskCardProperties\n')

# Fix exact optional-property errors found by the executed server typecheck.
replace('apps/server/src/notion/client.ts', 'fetch?: typeof fetch;', 'fetch?: typeof fetch | undefined;')
replace('apps/server/src/notion/client.ts', 'signal?: AbortSignal; } = {}', 'signal?: AbortSignal | undefined; } = {}')
replace('packages/shared/src/notion.ts', 'Partial<Pick<Todo,"title" | "notes" | "priority" | "dueDate">> & { completed?: boolean }', '{ title?: string | undefined; notes?: string | undefined; priority?: TodoPriority | undefined; dueDate?: string | null | undefined; completed?: boolean | undefined }')
replace('packages/shared/src/notion.ts', 'NotionTodoReference, Todo, TodoPriority', 'NotionTodoReference, TodoPriority')
replace('apps/server/src/notion/oauthBroker.test.ts', '.json();', '.json() as Record<string, unknown>;', count=2)
replace('apps/server/src/notion/oauthBroker.test.ts', '(await (await broker.handle(request())).json()).accessToken', '((await (await broker.handle(request())).json()) as Record<string, unknown>).accessToken', count=2)
replace('apps/server/src/notion/oauthBroker.ts', 'notionObject, notionResourceId', 'notionResourceId')
replace('apps/server/src/notion/runtime.ts', '  notionArray, notionCanonical,', '  notionCanonical,')
replace('packages/contracts/src/notion.ts', 'storyPoints: Schema.NullOr(Schema.Number)', 'storyPoints: Schema.NullOr(Schema.Finite)')

# Serialize durable writes and preserve original idempotency receipts during conflict rebase.
replace('apps/server/src/notion/runtime.ts', 'private mutation: Promise<unknown> = Promise.resolve();', 'private mutation: Promise<unknown> = Promise.resolve();\n  private persistence: Promise<void> = Promise.resolve();')
replace('apps/server/src/notion/runtime.ts', 'try { if (Buffer.byteLength(serialized) > SECRET_LIMIT) throw new Error("full"); await this.options.save(serialized); }', 'try {\n      if (Buffer.byteLength(serialized) > SECRET_LIMIT) throw new Error("full");\n      const operation = this.persistence.then(() => { this.ready(); return this.options.save(serialized); });\n      this.persistence = operation.catch(() => { this.storageFailed = true; });\n      await operation;\n    }')
replace('apps/server/src/notion/runtime.ts', 'const ChangeEntry = Schema.Struct({ input: NotionWriteInput,', 'const ChangeEntry = Schema.Struct({ deliveryBase: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)), input: NotionWriteInput,')
replace('apps/server/src/notion/runtime.ts', 'const base = notionComparableValue(entry.input.base) as NotionObject;', 'const base = notionComparableValue(entry.deliveryBase ?? entry.input.base) as NotionObject;')
replace('apps/server/src/notion/runtime.ts', 'entry.input = { ...entry.input, base: plan.current }; entry.digest = digest(notionCanonical(entry.input));', 'entry.deliveryBase = plan.current;')
# A missing response cannot turn a recorded success back into a retryable write.
replace('apps/server/src/notion/client.ts', 'let response: Response;\n      try {', 'let response: Response;\n      const attemptedToken = this.options.accessToken();\n      try {')
replace('apps/server/src/notion/client.ts', 'Authorization: `Bearer ${this.options.accessToken()}`', 'Authorization: `Bearer ${attemptedToken}`')
replace('apps/server/src/notion/client.ts', 'await response.body?.cancel(); refreshed = true;', 'await response.body?.cancel();\n        if (this.options.accessToken() !== attemptedToken) continue;\n        refreshed = true;')

# Do not reset unsaved block drafts when appending elsewhere on the page.
replace('apps/web/src/components/notion/NotionBrowser.tsx', 'import { useQuery }', 'import { useQuery, useQueryClient }')
replace('apps/web/src/components/notion/NotionBrowser.tsx', 'const [draft, setDraft] = useState<NotionObject | null>(null);', 'const [draft, setDraft] = useState<NotionObject | null>(null); const [editBase, setEditBase] = useState<NotionObject | null>(null);')
replace('apps/web/src/components/notion/NotionBrowser.tsx', 'base: Object.fromEntries(keys.map(key => [key, original[key]]))', 'base: Object.fromEntries(keys.map(key => [key, (editBase ?? original)[key]]))')
replace('apps/web/src/components/notion/NotionBrowser.tsx', 'onClick={() => setDraft({ ...original })}', 'onClick={() => { setEditBase({ ...original }); setDraft({ ...original }); }}')
replace('apps/web/src/components/notion/NotionBrowser.tsx', 'const [version, setVersion] = useState(0);', 'const queryClient = useQueryClient();')
replace('apps/web/src/components/notion/NotionBrowser.tsx', '<Children key={`${id}:${version}`} connectionId=', '<Children key={id} connectionId=')
replace('apps/web/src/components/notion/NotionBrowser.tsx', 'setVersion(value => value + 1);', 'await queryClient.invalidateQueries({ queryKey: ["notion", "resource", { connectionId, kind: "children", id }] });')
# Honest provisional date views: these are not full calendar/timeline implementations.
replace('apps/web/src/components/notion/NotionBrowser.tsx', '["table", "list", "board", "calendar", "timeline"].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))', '[{ value: "table", label: "Table" }, { value: "list", label: "List" }, { value: "board", label: "Board" }, { value: "calendar", label: "Date grid (preview)" }, { value: "timeline", label: "Date list (preview)" }]')
# Blank status mapping is explicit; unsupported priority mapping is not silently advertised.

changed = subprocess.check_output(['git', 'diff', '--name-only', '42fe8a7a66291ce8959bffd20249778752b4601a'], text=True).splitlines()
source = [name for name in changed if name.startswith(('apps/server/', 'apps/web/', 'packages/contracts/', 'packages/shared/')) and name.endswith(('.ts', '.tsx', '.json'))]
subprocess.run(['bun', 'run', 'fmt', *source], check=True)
print('Prepared and formatted ' + str(len(source)) + ' product files. No dependency versions were changed.')
