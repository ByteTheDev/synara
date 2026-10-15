// Branch-only integration anchors. Excluded from the normalized application tree.
import {readFile,writeFile} from 'node:fs/promises';
const file='apps/web/src/components/codeEditor/MonacoEditorSurface.tsx';
let source=await readFile(file,'utf8');
function replace(before,after){if(source.split(before).length!==2)throw new Error(`Ambiguous editor anchor: ${before}`);source=source.replace(before,after);}
source='import { getEditorExtensionBridge } from "./editorExtensionBridge";\nimport { EditorExtensionInteraction } from "./EditorExtensionInteraction";\n'+source;
replace('  const client = useQueryClient();','  const client = useQueryClient();\n  const extensionBridge = useMemo(() => props.workspaceRoot ? getEditorExtensionBridge(client, props.workspaceRoot) : null, [client, props.workspaceRoot]);');
replace('  const commandRef = useRef<(id: string) => void>(() => undefined);','  const commandRef = useRef<(id: string) => void>(() => undefined);\n  useEffect(() => {\n    if (!controller || !extensionBridge) return;\n    return extensionBridge.retain(controller.entry, !props.readOnly);\n  }, [controller, extensionBridge, props.readOnly]);');
replace('      action("editor.foldAll", "Fold all"),','      ...(extensionBridge && editable ? extensionBridge.actionRows(active.entry, results) : []),\n      action("editor.foldAll", "Fold all"),');
// Anchor on the existing command picker rather than reconstructing its surrounding layout.
replace('      <EditorActionPicker','      {extensionBridge ? <EditorExtensionInteraction bridge={extensionBridge} entry={controller?.entry ?? null} /> : null}\n      <EditorActionPicker');
await writeFile(file,source);
console.log('Connected shared extension lifecycle, native formatter/commands, guarded document writes and Synara interaction primitives.');
