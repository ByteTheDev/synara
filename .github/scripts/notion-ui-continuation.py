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

write('apps/web/src/components/notion/notionPlanning.ts', r'''
import type { NotionMapping, NotionObject, NotionSprintPlan } from "@synara/contracts";
import { notionArray, notionObject, notionProperty, notionResourceId, notionString } from "@synara/shared/notion";
export const NOTION_DAY_MS = 86_400_000;
export function notionDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}
export function addNotionDays(day: string, days: number): string {
  if (!notionDay(day) || !Number.isInteger(days)) throw new Error("Invalid calendar date.");
  const time = Date.parse(day + "T00:00:00Z") + days * NOTION_DAY_MS;
  if (!Number.isFinite(time)) throw new Error("Invalid calendar range.");
  return new Date(time).toISOString().slice(0, 10);
}
export function moveNotionDate(property: NotionObject, target: string): NotionObject {
  const date = notionObject(property.date);
  if (!notionDay(target) || date.time_zone || date.start != null && !notionDay(date.start) || date.end != null && !notionDay(date.end)) throw new Error("Timed or incomplete dates cannot be moved on a date-only calendar. Use the original date editor.");
  if (!date.start) return { start: target };
  const offset = (Date.parse(target) - Date.parse(notionString(date.start))) / NOTION_DAY_MS;
  return { ...date, start: target, ...(date.end ? { end: addNotionDays(notionString(date.end), offset) } : {}) };
}
export function moveNotionSprint(property: NotionObject, from: string, to: string): unknown[] {
  if (property.type !== "relation" || property.has_more === true || !Array.isArray(property.relation)) throw new Error("Load a complete Sprint relation before changing membership.");
  const source = from ? notionResourceId(from) : "";
  const target = to ? notionResourceId(to) : "";
  const selected = property.relation.map(raw => ({ raw, id: notionResourceId(notionString(notionObject(raw).id)) }));
  if (source && !selected.some(value => value.id === source)) throw new Error("The task is no longer in this sprint. Refresh planning.");
  const retained = selected.filter(value => !source || value.id !== source);
  if (target && !retained.some(value => value.id === target)) return [...retained.map(value => value.raw), { id: target }];
  return retained.map(value => value.raw);
}
export function notionSprintPhase(page: NotionObject, plan: NotionSprintPlan | null | undefined, today: string): "current" | "upcoming" | "completed" | "past" | "unscheduled" {
  if (!plan) return "unscheduled";
  const status = notionProperty(page.properties, plan.status ?? undefined);
  if (plan.completedStatusIds.includes(notionString(notionObject(status[notionString(status.type)]).id))) return "completed";
  const start = notionObject(notionProperty(page.properties, plan.start ?? undefined).date);
  const end = notionObject(notionProperty(page.properties, plan.end ?? undefined).date);
  const from = notionDay(start.start);
  const to = notionDay(end.end) || notionDay(end.start) || notionDay(start.end);
  if (from && from > today) return "upcoming";
  if (to && to < today) return "past";
  return from || to ? "current" : "unscheduled";
}
export function notionRecordDone(page: NotionObject, mapping: NotionMapping): boolean {
  const property = notionProperty(page.properties, mapping.fields.status);
  return property.type === "checkbox" ? property.checkbox === true : mapping.completedStatusIds.includes(notionString(notionObject(property[notionString(property.type)]).id));
}
export function notionPlanningSummary(pages: readonly NotionObject[], mapping: NotionMapping) {
  let points = 0, completedPoints = 0, completed = 0;
  const workloads = new Map<string, { id: string; name: string; tasks: number; points: number }>();
  for (const page of pages) {
    const raw = notionProperty(page.properties, mapping.fields.points).number;
    const estimate = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    const done = notionRecordDone(page, mapping);
    points += estimate; if (done) { completed++; completedPoints += estimate; }
    for (const rawPerson of notionArray(notionProperty(page.properties, mapping.fields.assignee).people)) {
      const person = notionObject(rawPerson); const id = notionString(person.id);
      if (!id) continue;
      const value = workloads.get(id) ?? { id, name: notionString(person.name) || id, tasks: 0, points: 0 };
      value.tasks++; value.points += estimate; workloads.set(id, value);
    }
  }
  return { total: pages.length, completed, points, completedPoints, workloads: [...workloads.values()] };
}
''')

write('apps/web/src/components/notion/NotionRichText.tsx', r'''
import type { NotionObject } from "@synara/contracts";
import { notionArray, notionCanonical, notionObject, notionString, notionText, safeNotionLink } from "@synara/shared/notion";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

export function validateNotionRichTextDraft(original: readonly unknown[], next: readonly unknown[]): void {
  if (next.length > 100) throw new Error("A block supports at most 100 text runs.");
  const preserved = (runs: readonly unknown[]) => runs.filter(raw => { const run = notionObject(raw); return run.type && run.type !== "text"; }).map(notionCanonical);
  if (notionCanonical(preserved(original)) !== notionCanonical(preserved(next))) throw new Error("Unsupported runs and mentions must be retained unchanged.");
  for (const raw of next) {
    const run = notionObject(raw); if (run.type && run.type !== "text") continue;
    const text = notionObject(run.text);
    if (typeof text.content !== "string" || text.content.length > 2000) throw new Error("Each text run must contain at most 2,000 characters.");
    const link = notionObject(text.link).url;
    if (link != null && !safeNotionLink(link)) throw new Error("Enter a complete http, https or mailto link before saving.");
  }
}
export function NotionRichText({ runs }: { runs: readonly unknown[] }) {
  return <>{runs.map((raw, index) => {
    const run = notionObject(raw); const marks = notionObject(run.annotations);
    const text = notionString(notionObject(run.text).content) || notionString(run.plain_text) || notionString(notionObject(run.equation).expression);
    const link = safeNotionLink(notionObject(notionObject(run.text).link).url || run.href);
    const className = [marks.bold ? "font-semibold" : "", marks.italic ? "italic" : "", marks.underline ? "underline" : "", marks.strikethrough ? "line-through" : "", marks.code ? "rounded bg-muted px-1 font-mono" : "", run.type === "mention" ? "rounded bg-muted px-1" : ""].filter(Boolean).join(" ");
    const content = <span className={className}>{text || `[${notionString(run.type) || "unsupported content"}]`}</span>;
    return link ? <a key={index} href={link} target="_blank" rel="noreferrer noopener" className="underline decoration-muted-foreground underline-offset-2">{content}</a> : <span key={index}>{content}</span>;
  })}</>;
}
export function NotionRichTextEditor({ runs, onChange, disabled = false }: { runs: readonly unknown[]; onChange: (runs: unknown[]) => void; disabled?: boolean }) {
  const prefix = useId();
  const replace = (index: number, next: NotionObject) => onChange(runs.map((run, position) => position === index ? next : run));
  const formats = [{ key: "bold", text: "B", label: "Bold" }, { key: "italic", text: "I", label: "Italic" }, { key: "underline", text: "U", label: "Underline" }, { key: "strikethrough", text: "S", label: "Strikethrough" }, { key: "code", text: "</>", label: "Inline code" }];
  return <div className="space-y-3">{runs.map((raw, index) => {
    const run = notionObject(raw); const text = notionObject(run.text); const marks = notionObject(run.annotations);
    if (run.type && run.type !== "text" || typeof text.content !== "string") return <p key={index} className="rounded-lg bg-muted p-2 text-ui-sm"><NotionRichText runs={[raw]} /> <span className="text-muted-foreground">· preserved read-only</span></p>;
    return <div key={index} className="space-y-2 rounded-lg border border-border p-2">
      <div role="group" aria-label={`Formatting for segment ${index + 1}`} className="flex flex-wrap gap-1">{formats.map(format => <Button key={format.key} type="button" size="sm" variant={marks[format.key] ? "secondary" : "ghost"} disabled={disabled} aria-label={format.label} aria-pressed={marks[format.key] === true} onClick={() => replace(index, { ...run, annotations: { ...marks, [format.key]: marks[format.key] !== true } })}>{format.text}</Button>)}</div>
      <label htmlFor={`${prefix}-${index}`} className="sr-only">Text run {index + 1}</label><Textarea id={`${prefix}-${index}`} aria-label={`Text run ${index + 1}`} value={text.content} rows={2} maxLength={2000} disabled={disabled} onChange={event => replace(index, { ...run, text: { ...text, content: event.target.value } })} />
      <label className="grid gap-1 text-ui-sm text-muted-foreground">Link URL<Input aria-label={`Link for segment ${index + 1}`} value={notionString(notionObject(text.link).url)} disabled={disabled} placeholder="https://…" onChange={event => replace(index, { ...run, text: { ...text, link: event.target.value ? { ...notionObject(text.link), url: event.target.value } : null } })} /></label>
    </div>;
  })}<Button type="button" size="sm" variant="ghost" disabled={disabled || runs.length >= 100} onClick={() => onChange([...runs, { type: "text", text: { content: "" } }])}>{runs.length ? "Add text segment" : "Add text"}</Button></div>;
}
''')

replace('apps/web/src/components/notion/notionProperties.ts', 'function writablePropertyValue(property:', 'export function writablePropertyValue(property:')
replace('apps/web/src/components/notion/NotionTaskPropertyEditor.tsx', 'function PropertyControl(props:', 'export function PropertyControl(props:')
write('apps/web/src/components/notion/NotionRecordPropertyEditor.tsx', r'''
import type { NotionObject } from "@synara/contracts";
import { notionArray, notionCanonical, notionComparableValue, notionObject, notionPropertyLabel, notionPropertySnapshot, notionString, notionTitle } from "@synara/shared/notion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { NotionDraftBoundary, useNotionDraft, useNotionDraftGuard } from "./NotionDraftBoundary";
import { PropertyControl } from "./NotionTaskPropertyEditor";
import { NotionRichTextEditor, validateNotionRichTextDraft } from "./NotionRichText";
import { notionProperties, notionPropertyReadOnlyReason, writablePropertyValue, type MappedNotionProperty } from "./notionProperties";
import { NotionError, NotionReceiptNotice, notionApi, useNotionAction } from "./notionUi";

interface Props { connectionId: string; source: NotionObject; page: NotionObject; propertyId?: string | undefined; onClose: () => void; onSaved: () => void }
function PropertyForm(props: Props) {
  const [snapshot] = useState(() => ({ source: structuredClone(props.source), page: structuredClone(props.page) }));
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const action = useNotionAction();
  const locked = action.pending || action.awaitingConfirmation;
  useNotionDraft(Object.keys(edits).length > 0 || action.pending);
  const properties: MappedNotionProperty[] = notionProperties(snapshot.source).filter(property => !props.propertyId || property.id === props.propertyId).map(descriptor => {
    const original = Object.values(notionObject(snapshot.page.properties)).map(notionObject).find(value => value.id === descriptor.id) ?? {};
    const text = ["title", "rich_text"].includes(descriptor.type);
    return { ...descriptor, original, fields: [], readOnlyReason: text ? (Array.isArray(original[descriptor.type]) && original.has_more !== true ? null : "This rich-text property is incomplete.") : notionPropertyReadOnlyReason(original, descriptor) };
  });
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    void action.run(async () => {
      const changes: Record<string, unknown> = {};
      for (const [id, draft] of Object.entries(edits)) {
        const property = properties.find(value => value.id === id);
        if (!property || property.readOnlyReason) throw new Error(property?.readOnlyReason || "The selected property is read-only.");
        let value: unknown;
        if (["title", "rich_text"].includes(property.type)) {
          if (!Array.isArray(draft)) throw new Error("Invalid rich text.");
          validateNotionRichTextDraft(notionArray(property.original[property.type]), draft); value = draft;
        } else value = writablePropertyValue(property, draft);
        if (notionCanonical(notionComparableValue(property.original[property.type], property.type)) !== notionCanonical(notionComparableValue(value, property.type))) changes[id] = { [property.type]: value };
      }
      if (Object.keys(changes).length) await action.write({ connectionId: props.connectionId, kind: "updatePage", id: notionString(snapshot.page.id), base: notionPropertySnapshot(snapshot.page.properties, Object.keys(changes)), changes });
      props.onSaved(); props.onClose();
    });
  }}>
    <p className="text-ui-sm text-muted-foreground">Only changed properties are sent. Original values remain the conflict baseline while this editor is open.</p>
    {properties.map(property => <fieldset disabled={locked} key={property.id} className="space-y-2 rounded-lg border border-border p-3"><legend className="px-1 text-ui font-medium">{property.label}</legend>{["title", "rich_text"].includes(property.type) && !property.readOnlyReason ? <NotionRichTextEditor runs={notionArray(Object.hasOwn(edits, property.id) ? edits[property.id] : property.original[property.type])} onChange={value => setEdits(current => ({ ...current, [property.id]: value }))} disabled={locked} /> : <PropertyControl connectionId={props.connectionId} property={property} value={Object.hasOwn(edits, property.id) ? edits[property.id] : property.original[property.type]} disabled={locked} onChange={value => setEdits(current => ({ ...current, [property.id]: value }))} />}</fieldset>)}
    <NotionError message={action.error} /><NotionReceiptNotice active={action.awaitingConfirmation} />
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={action.pending} onClick={props.onClose}>Cancel edits</Button><Button type="submit" disabled={action.pending || !Object.keys(edits).length}>{action.awaitingConfirmation ? "Check original request" : "Save properties"}</Button></div>
  </form>;
}
function PropertyDialog(props: Props) {
  const guard = useNotionDraftGuard();
  return <Dialog open onOpenChange={open => { if (!open && guard?.mayLeave() !== false) props.onClose(); }}><DialogPopup className="w-[min(42rem,94vw)]"><DialogHeader><DialogTitle>{notionTitle(props.page)}</DialogTitle><DialogDescription>Notion record properties</DialogDescription></DialogHeader><DialogPanel className="max-h-[75vh] space-y-3 overflow-auto"><NotionError message={guard?.error} /><PropertyForm {...props} /></DialogPanel></DialogPopup></Dialog>;
}
export function NotionRecordPropertyEditor(props: Props) { return <NotionDraftBoundary><PropertyDialog {...props} /></NotionDraftBoundary>; }
export function NotionPageProperties({ connectionId, page, onSaved }: { connectionId: string; page: NotionObject; onSaved: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const sourceId = notionString(notionObject(page.parent).data_source_id);
  const schema = useQuery({ queryKey: ["notion", "page-schema", connectionId, sourceId], queryFn: async () => (await notionApi().read({ connectionId, kind: "dataSource", id: sourceId })).data, enabled: Boolean(sourceId), retry: false, gcTime: 0, refetchOnWindowFocus: false });
  const source = sourceId ? schema.data : page;
  return <details className="rounded-lg border border-border p-3"><summary className="text-ui font-medium">Page properties</summary><NotionError message={schema.error?.message} /><dl className="mt-3 grid gap-2 text-ui">{Object.entries(notionObject(page.properties)).map(([name, raw]) => { const property = notionObject(raw); return <div className="grid grid-cols-2 items-center gap-3" key={notionString(property.id) || name}><dt className="text-muted-foreground">{name}</dt><dd className="min-w-0 break-words"><Button variant="ghost" className="max-w-full justify-start truncate" disabled={!source} onClick={() => setSelected(notionString(property.id))}>{notionPropertyLabel(property) || "—"}</Button></dd></div>; })}</dl>{selected && source ? <NotionRecordPropertyEditor key={selected} connectionId={connectionId} source={source} page={page} propertyId={selected} onClose={() => setSelected(null)} onSaved={onSaved} /> : null}</details>;
}
''')

write('apps/web/src/components/notion/notionPlanning.test.ts', r'''
import { describe, expect, it } from "vitest";
import { addNotionDays, moveNotionDate, moveNotionSprint, notionDay, notionSprintPhase } from "./notionPlanning";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222", c = "33333333-3333-4333-8333-333333333333";
describe("Notion planning invariants", () => {
  it("rejects rolled-over dates and handles calendar boundaries", () => { expect(notionDay("2026-02-31")).toBe(""); expect(addNotionDays("2026-12-31", 1)).toBe("2027-01-01"); });
  it("moves a full date range without discarding its duration", () => { expect(moveNotionDate({ date: { start: "2026-10-01", end: "2026-10-05", time_zone: null } }, "2026-10-20")).toEqual({ start: "2026-10-20", end: "2026-10-24", time_zone: null }); });
  it("refuses to flatten timed dates", () => { expect(() => moveNotionDate({ date: { start: "2026-10-01T10:00:00Z" } }, "2026-10-20")).toThrow("Timed"); });
  it("preserves other sprint memberships when moving or removing one", () => { const original = { type: "relation", relation: [{ id: a }, { id: b }] }; expect(moveNotionSprint(original, a, c)).toEqual([{ id: b }, { id: c }]); expect(moveNotionSprint(original, a, "")).toEqual([{ id: b }]); expect(original.relation).toHaveLength(2); });
  it("refuses incomplete or stale membership replacements", () => { expect(() => moveNotionSprint({ type: "relation", relation: [{ id: a }], has_more: true }, a, b)).toThrow("complete"); expect(() => moveNotionSprint({ type: "relation", relation: [{ id: a }] }, b, c)).toThrow("no longer"); });
  it("does not infer completed status from elapsed dates", () => { const plan = { dataSourceId: a, title: { id: "t", type: "title" }, start: { id: "d", type: "date" }, end: null, status: null, completedStatusIds: [] }; expect(notionSprintPhase({ properties: { Date: { id: "d", type: "date", date: { start: "2026-10-01", end: "2026-10-03" } } } }, plan, "2026-10-15")).toBe("past"); });
});
''')

browser = ROOT / 'apps/web/src/components/notion/NotionBrowser.tsx'
text = browser.read_text()
start = text.index('function TextRuns(')
end = text.index('function Block(', start)
text = text[:start] + 'const TextRuns = NotionRichTextEditor;\n' + text[end:]
text = text.replace('import { useState } from "react";', 'import { useState } from "react";\nimport { NotionRichText, NotionRichTextEditor, validateNotionRichTextDraft } from "./NotionRichText";\nimport { NotionPageProperties } from "./NotionRecordPropertyEditor";')
browser.write_text(text)
replace(str(browser.relative_to(ROOT)), 'const patch = notionBlockDraftPatch(type, base, content);', 'validateNotionRichTextDraft(notionArray(base.rich_text), notionArray(content.rich_text)); const patch = notionBlockDraftPatch(type, base, content);')
replace(str(browser.relative_to(ROOT)), '{text || (type === "table"', '{text ? <NotionRichText runs={notionArray(content.rich_text)} /> : (type === "table"')
old = '<details className="rounded-lg border border-border p-3"><summary className="text-ui font-medium">Page properties</summary><dl className="mt-3 grid gap-2 text-ui">{Object.entries(notionObject(query.data?.properties)).map(([name, property]) => <div className="grid grid-cols-2 gap-3" key={name}><dt className="text-muted-foreground">{name}</dt><dd className="break-words">{notionPropertyLabel(property) || "—"}</dd></div>)}</dl></details>'
replace(str(browser.relative_to(ROOT)), old, '{query.data ? <NotionPageProperties connectionId={connectionId} page={query.data} onSaved={() => void query.refetch()} /> : null}')
replace(str(browser.relative_to(ROOT)), '{notionText(cell)}</span>', '<NotionRichText runs={notionArray(cell)} /></span>')
replace(str(browser.relative_to(ROOT)), '{notionText(comment.rich_text)}</p>', '<NotionRichText runs={notionArray(comment.rich_text)} /></p>')

print('Prepared lossless rich text, shared record properties and planning invariants.')
