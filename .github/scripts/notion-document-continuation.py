from pathlib import Path
ROOT = Path.cwd()
def replace(path, old, new):
    file = ROOT / path
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one anchor in {path}: {old[:100]!r}')
    file.write_text(text.replace(old, new))
def write(path, text):
    file = ROOT / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text.lstrip('\n'))

write('apps/web/src/components/notion/NotionBlockComposer.tsx', r'''
import type { NotionObject } from "@synara/contracts";
import { notionResourceId, plainNotionText, safeNotionLink } from "@synara/shared/notion";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useNotionDraft } from "./NotionDraftBoundary";
import { NotionError, NotionReceiptNotice, NotionSelect, useNotionAction } from "./notionUi";

const TYPES = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code", "table", "divider", "bookmark", "image", "file", "link_to_page"];
const COMMANDS: Record<string, string> = { text: "paragraph", h1: "heading_1", h2: "heading_2", h3: "heading_3", bullet: "bulleted_list_item", number: "numbered_list_item", todo: "to_do", toggle: "toggle", quote: "quote", callout: "callout", code: "code", table: "table", divider: "divider", link: "bookmark", image: "image", file: "file", page: "link_to_page" };
export function buildNotionBlock(type: string, text: string, url: string, language: string, header: boolean): NotionObject {
  if (!TYPES.includes(type)) throw new Error("Choose a supported block type.");
  if (type === "divider") return { object: "block", type, divider: {} };
  if (type === "link_to_page") return { object: "block", type, link_to_page: { type: "page_id", page_id: notionResourceId(url) } };
  if (["image", "file", "bookmark"].includes(type)) {
    const target = safeNotionLink(url);
    if (!target || !target.startsWith("https://")) throw new Error("Use a valid HTTPS media or bookmark URL.");
    return { object: "block", type, [type]: type === "bookmark" ? { url: target, caption: plainNotionText(text) } : { type: "external", external: { url: target }, caption: plainNotionText(text) } };
  }
  if (type === "table") {
    const rows = text.split("\n").map(row => row.split("\t"));
    const width = rows[0]?.length ?? 0;
    if (!width || width > 12 || rows.length > 30 || rows.some(row => row.length !== width)) throw new Error("Paste a rectangular tab-separated table with 1–12 columns and at most 30 rows.");
    return { object: "block", type: "table", table: { table_width: width, has_column_header: header, has_row_header: false, children: rows.map(row => ({ object: "block", type: "table_row", table_row: { cells: row.map(plainNotionText) } })) } };
  }
  if (!text.trim()) throw new Error("Write some content before inserting this block.");
  return { object: "block", type, [type]: { rich_text: plainNotionText(text), ...(type === "to_do" ? { checked: false } : {}), ...(type === "code" ? { language } : {}), ...(type === "callout" ? { icon: { type: "emoji", emoji: "💡" } } : {}) } };
}
export function NotionBlockComposer({ connectionId, parentId, after, onSaved, onCancel }: { connectionId: string; parentId: string; after?: string | undefined; onSaved: () => void; onCancel?: (() => void) | undefined }) {
  const [type, setType] = useState("paragraph"); const [text, setText] = useState(""); const [url, setUrl] = useState("");
  const [language, setLanguage] = useState("plain text"); const [header, setHeader] = useState(true);
  const action = useNotionAction(); const locked = action.pending || action.awaitingConfirmation;
  useNotionDraft(Boolean(text || url) || action.pending);
  const commands = /^\/[a-z0-9_]*$/.test(text) ? Object.entries(COMMANDS).filter(([name]) => name.startsWith(text.slice(1))) : [];
  const selectCommand = (command: string) => { setType(command); setText(""); };
  return <form className="space-y-3 rounded-xl border border-border bg-muted/10 p-3" onSubmit={event => { event.preventDefault(); void action.run(async () => {
    const child = buildNotionBlock(type, text, url, language, header);
    await action.write({ connectionId, kind: "appendBlocks", id: parentId, base: {}, changes: { children: [child], ...(after ? { after } : {}) } });
    setText(""); setUrl(""); onSaved();
  }); }}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-ui font-medium">{after ? "Insert after this block" : "Add document content"}</h3><NotionSelect label="New block type" value={type} onChange={setType} disabled={locked} options={TYPES.map(value => ({ value, label: value.replaceAll("_", " ") }))} /></div>
    {type !== "divider" ? <Textarea aria-label="New block content" placeholder={type === "table" ? "Paste rows separated by newlines and columns separated by tabs" : "Write content, or type / for block commands"} value={text} maxLength={12000} rows={type === "table" ? 5 : 3} disabled={locked} onChange={event => setText(event.target.value)} onKeyDown={event => { if (commands.length && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); selectCommand(commands[0]![1]); } if (event.key === "Escape" && commands.length) { event.preventDefault(); setText(""); } }} /> : <p className="text-ui-sm text-muted-foreground">Insert a horizontal divider without changing existing blocks.</p>}
    {commands.length ? <div role="group" aria-label="Slash commands" className="flex flex-wrap gap-1 rounded-lg border border-border p-2">{commands.map(([name, value]) => <Button key={name} size="sm" variant="ghost" type="button" onClick={() => selectCommand(value)}>/{name}</Button>)}</div> : null}
    {["image", "file", "bookmark", "link_to_page"].includes(type) ? <label className="grid gap-1 text-ui-sm">{type === "link_to_page" ? "Shared Notion page ID" : "HTTPS URL"}<Input aria-label="Block reference" value={url} disabled={locked} onChange={event => setUrl(event.target.value)} /></label> : null}
    {type === "code" ? <NotionSelect label="Code language" value={language} onChange={setLanguage} disabled={locked} options={["plain text", "typescript", "javascript", "python", "json", "bash", "sql", "rust", "html", "css", "markdown"].map(value => ({ value, label: value }))} /> : null}
    {type === "table" ? <label className="flex items-center gap-2 text-ui-sm"><Checkbox checked={header} disabled={locked} onCheckedChange={checked => setHeader(checked === true)} />First row is a header</label> : null}
    <NotionError message={action.error} /><NotionReceiptNotice active={action.awaitingConfirmation} />
    <div className="flex gap-2"><Button type="submit" disabled={action.pending || commands.length > 0}>{action.awaitingConfirmation ? "Check original insertion" : "Insert block"}</Button><Button type="button" variant="ghost" disabled={action.pending} onClick={() => { setText(""); setUrl(""); onCancel?.(); }}>Discard new block</Button></div>
  </form>;
}
''')

write('apps/web/src/components/notion/notionDrafts.ts', r'''
import type { NotionObject } from "@synara/contracts";
import { notionArray, notionCanonical, notionComparableValue } from "@synara/shared/notion";
/** Only changed supported fields are sent; original runs and cells remain the baseline. */
export function notionBlockDraftPatch(type: string, base: NotionObject, values: NotionObject) {
  if (!["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code", "table_row"].includes(type)) throw new Error("This block type is read-only in Synara.");
  if (type === "table_row") {
    if (!Array.isArray(base.cells) || !Array.isArray(values.cells) || values.cells.length !== base.cells.length || notionArray(values.cells).some(cell => !Array.isArray(cell))) throw new Error("Preserve the existing table width and complete rich-text cells.");
  } else if (!Array.isArray(base.rich_text) || !Array.isArray(values.rich_text) || type === "to_do" && (typeof base.checked !== "boolean" || typeof values.checked !== "boolean")) throw new Error("This block is incomplete. Reload it before editing.");
  const keys = type === "table_row" ? ["cells"] : type === "to_do" ? ["rich_text", "checked"] : type === "code" ? ["rich_text", ...(typeof base.language === "string" && typeof values.language === "string" ? ["language"] : [])] : ["rich_text"];
  const changed = keys.filter(key => notionCanonical(notionComparableValue(base[key], key)) !== notionCanonical(notionComparableValue(values[key], key)));
  return { base: Object.fromEntries(changed.map(key => [key, structuredClone(base[key])])), changes: Object.fromEntries(changed.map(key => [key, structuredClone(values[key])])) };
}
''')

runtime = 'apps/server/src/notion/runtime.ts'
replace(runtime, 'if (keys.length !== 1 || !Array.isArray(changes.children)', 'if (keys.some(key => !["children", "after"].includes(key)) || !Array.isArray(changes.children)')
replace(runtime, '      return { path: `/v1/blocks/${resourceId}/children`, method: "PATCH", body: { children: notionWritableValue(changes.children) }, current: null, desired: changes };', '''      let after: string | undefined;
      if (changes.after !== undefined) {
        after = id(notionString(changes.after));
        const { data: sibling } = await this.read({ connectionId: input.connectionId, kind: "block", id: after });
        const parent = notionObject(sibling.parent);
        if (sibling.archived === true || sibling.in_trash === true || !sameResource(notionString(parent.page_id || parent.block_id), resourceId)) throw new NotionFailure("The insertion anchor is no longer in this parent. Refresh the document.", "conflict");
      }
      return { path: `/v1/blocks/${resourceId}/children`, method: "PATCH", body: { children: notionWritableValue(changes.children), ...(after ? { after } : {}) }, current: null, desired: changes };''')
replace(runtime, 'if (keys.length !== 1 || !Array.isArray(changes.rich_text) || changes.rich_text.length > 100)', 'if (keys.some(key => !["rich_text", "discussion_id"].includes(key)) || !Array.isArray(changes.rich_text) || changes.rich_text.length < 1 || changes.rich_text.length > 100)')
replace(runtime, '    return { path: "/v1/comments", method: "POST", body: { parent: { page_id: resourceId }, rich_text: notionWritableValue(changes.rich_text) }, current: null, desired: changes };', '''    let discussionId: string | undefined;
    if (changes.discussion_id !== undefined) {
      discussionId = id(notionString(changes.discussion_id));
      let found = false;
      for await (const comment of this.client(input.connectionId).pages({ connectionId: input.connectionId, kind: "comments", id: resourceId, pageSize: 100 }, this.signal.signal)) {
        if (sameResource(notionString(comment.discussion_id), discussionId)) { found = true; break; }
      }
      if (!found) throw new NotionFailure("The discussion is not accessible on this page.", "forbidden", 403);
    }
    return { path: "/v1/comments", method: "POST", body: { ...(discussionId ? { discussion_id: discussionId } : { parent: { page_id: resourceId } }), rich_text: notionWritableValue(changes.rich_text) }, current: null, desired: changes };''')

browser = 'apps/web/src/components/notion/NotionBrowser.tsx'
replace(browser, 'import { NotionDatabaseWorkspace } from "./NotionDatabaseWorkspace";', 'import { NotionDatabaseWorkspace } from "./NotionDatabaseWorkspace";\nimport { NotionBlockComposer } from "./NotionBlockComposer";')
replace(browser, 'function Block({ block, connectionId, depth, onOpen, onSaved }: { block: NotionObject;', 'function Block({ block, connectionId, depth, onOpen, onSaved, parentId }: { parentId: string; block: NotionObject;')
replace(browser, 'const [expanded, setExpanded] = useState(false); const action = useNotionAction();', 'const [expanded, setExpanded] = useState(false); const [inserting, setInserting] = useState(false); const action = useNotionAction();')
replace(browser, '"toggle", "quote", "callout", "code"].includes(type);', '"toggle", "quote", "callout", "code", "table_row"].includes(type);')
replace(browser, '<TextRuns runs={notionArray(content.rich_text)} onChange={runs => setDraft({ ...content, rich_text: runs })} />', '''{type === "table_row" ? <div className="space-y-3">{notionArray(content.cells).map((cell, index) => <fieldset key={index} className="rounded border border-border p-2"><legend className="text-ui-sm">Cell {index + 1}</legend><TextRuns runs={notionArray(cell)} onChange={runs => setDraft({ ...content, cells: notionArray(content.cells).map((value, position) => position === index ? runs : value) })} /></fieldset>)}</div> : <TextRuns runs={notionArray(content.rich_text)} onChange={runs => setDraft({ ...content, rich_text: runs })} />}{type === "code" ? <NotionSelect label="Code block language" value={notionString(content.language)} onChange={language => setDraft({ ...content, language })} options={[...new Set([notionString(content.language), "plain text", "typescript", "javascript", "python", "json", "bash", "sql", "rust", "html", "css", "markdown"])].filter(Boolean).map(value => ({ value, label: value }))} /> : null}''')
replace(browser, 'validateNotionRichTextDraft(notionArray(base.rich_text), notionArray(content.rich_text));', 'if (type === "table_row") notionArray(content.cells).forEach((cell, index) => validateNotionRichTextDraft(notionArray(notionArray(base.cells)[index]), notionArray(cell))); else validateNotionRichTextDraft(notionArray(base.rich_text), notionArray(content.rich_text));')
replace(browser, '    {block.has_children === true && depth < 8 ?', '''    {!draft ? <Button size="sm" variant="ghost" onClick={() => setInserting(true)}>Insert after</Button> : null}
    {inserting ? <NotionBlockComposer connectionId={connectionId} parentId={parentId} after={notionString(block.id)} onCancel={() => setInserting(false)} onSaved={() => { setInserting(false); onSaved(); }} /> : null}
    {block.has_children === true && depth < 8 ?''')
replace(browser, '<Block key={notionString(block.id)} block={block}', '<Block key={notionString(block.id)} parentId={id} block={block}')
file = ROOT / browser
text = file.read_text()
a = text.index('function Page('); b = text.index('function Records(', a)
page = text[a:b]
prefix = page.index('  const query = useResource(')
ret = page.index('  return <div', prefix)
page = page[:prefix] + '''  const query = useResource({ connectionId, kind: "page", id }); const queryClient = useQueryClient();
''' + page[ret:]
page = page.replace('query.error?.message ?? action.error', 'query.error?.message').replace('<NotionReceiptNotice active={action.awaitingConfirmation} />', '')
a2 = page.index('    <div className="space-y-2 rounded-lg border border-border p-3"><NotionSelect')
b2 = page.index('    <Comments ', a2)
page = page[:a2] + '''    <NotionBlockComposer connectionId={connectionId} parentId={id} onSaved={() => { void queryClient.invalidateQueries({ queryKey: ["notion", "resource"] }); }} />
''' + page[b2:]
text = text[:a] + page + text[b:]
file.write_text(text)
# A contextual data-source entry point from the existing Tasks card, not another app shell.
replace(browser, 'function NotionBrowserContent({ connectionId, pageId, onClose }: { connectionId: string; pageId?: string | undefined;', 'function NotionBrowserContent({ connectionId, pageId, dataSourceId, onClose }: { connectionId: string; pageId?: string | undefined; dataSourceId?: string | undefined;')
replace(browser, 'pageId ? [{ id: pageId, kind: "page" }] : []', 'dataSourceId ? [{ id: dataSourceId, kind: "dataSource" }] : pageId ? [{ id: pageId, kind: "page" }] : []')
replace(browser, 'export function NotionBrowser(props: { connectionId: string; pageId?: string | undefined;', 'export function NotionBrowser(props: { connectionId: string; pageId?: string | undefined; dataSourceId?: string | undefined;')
# Separate page-title search scope from record filtering; do not create a full-text index.
replace(browser, 'const [search, setSearch] = useState(""); const current = path.at(-1);', 'const [search, setSearch] = useState(""); const [searchKind, setSearchKind] = useState(""); const current = path.at(-1);')
replace(browser, '<ResourceList key={search} input={{ connectionId, kind: "search", query: search }} onOpen={open} />', '<NotionSelect label="Search resource type" value={searchKind} onChange={setSearchKind} options={[{ value: "", label: "Pages and databases" }, { value: "page", label: "Pages and wiki documents" }, { value: "data_source", label: "Databases" }]} /><p className="text-ui-sm text-muted-foreground">Search matches authorized page and database titles in this workspace. Open a database to search its records; this is not document full-text search.</p><ResourceList key={search + searchKind} input={{ connectionId, kind: "search", query: search, ...(searchKind ? { filter: { property: "object", value: searchKind } } : {}) }} onOpen={open} />')
# Expose safe previews without persisting source text.
replace(browser, '<span className="truncate">{notionTitle(value)}</span>', '<span className="min-w-0 text-left"><span className="block truncate">{notionTitle(value)}</span><span className="block truncate text-ui-xs text-muted-foreground">{notionText(value.description) || (notionString(value.last_edited_time) ? "Edited " + notionString(value.last_edited_time).slice(0, 10) : "Shared with this integration")}</span></span>')

task = 'apps/web/src/components/notion/NotionTaskDetails.tsx'
replace(task, 'const [page, setPage] = useState<NotionTodoReference | null>(null);', 'const [page, setPage] = useState<NotionTodoReference | null>(null);\n  const [database, setDatabase] = useState<NotionTodoReference | null>(null);')
replace(task, '<Button variant="ghost" size="sm" disabled={editing !== null} onClick={() => setPage(structuredClone(external))}>Page details</Button>', '<Button variant="ghost" size="sm" disabled={editing !== null} onClick={() => setPage(structuredClone(external))}>Page details</Button><Button variant="ghost" size="sm" disabled={editing !== null} onClick={() => setDatabase(structuredClone(external))}>Database and sprints</Button>')
replace(task, '      {page ? <NotionBrowser', '      {database ? <NotionBrowser key={database.connectionId + database.dataSourceId} connectionId={database.connectionId} dataSourceId={database.dataSourceId} onClose={() => setDatabase(null)} /> : null}\n      {page ? <NotionBrowser')

# Reply within an actual loaded discussion; server checks the thread belongs to this page.
replace(browser, 'const [text, setText] = useState(""); const action = useNotionAction();', 'const [text, setText] = useState(""); const [discussion, setDiscussion] = useState(""); const action = useNotionAction();')
replace(browser, '<NotionRichText runs={notionArray(comment.rich_text)} /></p>', '<NotionRichText runs={notionArray(comment.rich_text)} />{notionString(comment.discussion_id) ? <Button size="sm" variant="ghost" disabled={action.pending || action.awaitingConfirmation} onClick={() => setDiscussion(notionString(comment.discussion_id))}>Reply</Button> : null}</p>')
replace(browser, '<Textarea disabled={action.pending || action.awaitingConfirmation} aria-label="New page comment"', '{discussion ? <p className="text-ui-sm text-muted-foreground">Replying to a discussion <Button size="sm" variant="ghost" onClick={() => setDiscussion("")}>Cancel reply</Button></p> : null}<Textarea disabled={action.pending || action.awaitingConfirmation} aria-label="New page comment"')
replace(browser, 'changes: { rich_text: plainNotionText(text) } }); setText(""); await query.refetch();', 'changes: { rich_text: plainNotionText(text), ...(discussion ? { discussion_id: discussion } : {}) } }); setText(""); setDiscussion(""); await query.refetch();')

write('apps/web/src/components/notion/NotionBlockComposer.test.ts', r'''
import { describe, expect, it } from "vitest";
import { buildNotionBlock } from "./NotionBlockComposer";
import { validateNotionRichTextDraft } from "./NotionRichText";
import { plainNotionText } from "@synara/shared/notion";
describe("Notion document composition", () => {
  it("builds real table rows with bounded rectangular cells", () => { const block = buildNotionBlock("table", "Name\tEstimate\nOAuth\t5", "", "plain text", true); expect(block.type).toBe("table"); expect(block.table).toMatchObject({ table_width: 2, has_column_header: true }); expect(() => buildNotionBlock("table", "Name\tEstimate\nOAuth", "", "plain text", true)).toThrow("rectangular"); });
  it("does not accept executable or insecure media URLs", () => { expect(() => buildNotionBlock("image", "", "javascript:alert(1)", "plain text", false)).toThrow("HTTPS"); });
  it("retains mentions and rejects their replacement", () => { const mention = { type: "mention", mention: { type: "page", page: { id: "11111111-1111-4111-8111-111111111111" } }, plain_text: "Roadmap" }; expect(() => validateNotionRichTextDraft([mention], [mention, ...plainNotionText("Ready")])).not.toThrow(); expect(() => validateNotionRichTextDraft([mention], plainNotionText("Roadmap"))).toThrow("preserved"); });
  it("validates links at save rather than discarding intermediate drafts", () => { expect(() => validateNotionRichTextDraft([], [{ text: { content: "Read", link: { url: "https:" } } }])).toThrow("complete"); expect(() => validateNotionRichTextDraft([], [{ text: { content: "Read", link: { url: "https://example.test/" } } }])).not.toThrow(); });
});
''')
print('Prepared block composition, safe insert-after, table editing, discussion replies and native Tasks navigation.')
