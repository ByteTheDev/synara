from pathlib import Path
ROOT = Path.cwd()
def replace(path, old, new):
    file = ROOT / path
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one anchor in {path}: {old[:95]!r}')
    file.write_text(text.replace(old, new))
def write(path, text):
    file = ROOT / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text.lstrip('\n'))

write('apps/web/src/components/notion/NotionPlanningPanel.tsx', r'''
import type { NotionMapping, NotionObject } from "@synara/contracts";
import { notionArray, notionObject, notionProperty, notionPropertyLabel, notionPropertySnapshot, notionRelationIds, notionResourceId, notionString, notionTitle, plainNotionText } from "@synara/shared/notion";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useNotionDraft } from "./NotionDraftBoundary";
import { NotionRecordPropertyEditor } from "./NotionRecordPropertyEditor";
import { moveNotionSprint, notionDay, notionPlanningSummary, notionRecordDone, notionSprintPhase } from "./notionPlanning";
import { notionOptions, notionProperties } from "./notionProperties";
import { NotionError, NotionReceiptNotice, NotionSelect, notionApi, useNotionAction } from "./notionUi";

export function NotionPlanningPanel({ connectionId, mapping, source, records, partial, onOpen, onSaved }: { connectionId: string; mapping: NotionMapping; source: NotionObject; records: readonly NotionObject[]; partial: boolean; onOpen: (id: string, kind: "page") => void; onSaved: () => void }) {
  const [phase, setPhase] = useState("all");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("");
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [editing, setEditing] = useState<{ page: NotionObject; source: NotionObject } | null>(null);
  const [drag, setDrag] = useState<{ page: NotionObject; from: string } | null>(null);
  const action = useNotionAction(); const locked = action.pending || action.awaitingConfirmation;
  useNotionDraft(Boolean(title || from || to) || action.pending);
  const ref = mapping.fields.sprint;
  const relation = notionProperty(source.properties, ref);
  const sprintSourceId = notionString(notionObject(relation.relation).data_source_id);
  const schema = useQuery({ queryKey: ["notion", "sprint-plan-schema", connectionId, sprintSourceId], queryFn: async () => (await notionApi().read({ connectionId, kind: "dataSource", id: sprintSourceId })).data, enabled: Boolean(sprintSourceId), retry: false, gcTime: 0, refetchOnWindowFocus: false });
  const query = useInfiniteQuery({
    queryKey: ["notion", "sprint-plans", connectionId, sprintSourceId], initialPageParam: undefined as string | undefined,
    enabled: Boolean(sprintSourceId), retry: false, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ pageParam }) => {
      const data = (await notionApi().read({ connectionId, kind: "query", id: sprintSourceId, pageSize: 50, ...(pageParam ? { cursor: pageParam } : {}) })).data;
      if (!Array.isArray(data.results) || typeof data.has_more !== "boolean" || data.has_more && !notionString(data.next_cursor)) throw new Error("The sprint page is incomplete. Existing plans were retained.");
      const pages = data.results.map(notionObject);
      if (pages.some(page => page.object !== "page" || notionString(notionObject(page.parent).data_source_id).replaceAll("-", "").toLowerCase() !== sprintSourceId.replaceAll("-", "").toLowerCase())) throw new Error("A sprint did not belong to the authorized relation target.");
      return { pages, more: data.has_more, cursor: notionString(data.next_cursor) };
    },
    getNextPageParam: (last, pages) => last.more && last.cursor && pages.length < 100 && !pages.slice(0, -1).some(page => page.cursor === last.cursor) ? last.cursor : undefined,
  });
  const plans = [...new Map((query.data?.pages ?? []).flatMap(page => page.pages).map(page => [notionResourceId(notionString(page.id)), page])).values()];
  const selected = (page: NotionObject) => notionRelationIds(notionProperty(page.properties, ref).relation).map(notionResourceId);
  const planIds = new Set(plans.map(page => notionResourceId(notionString(page.id))));
  const unknown = [...new Set(records.flatMap(selected))].filter(id => !planIds.has(id));
  const groups: { id: string; title: string; page: NotionObject | null }[] = [{ id: "", title: "Product backlog", page: null }, ...plans.map(page => ({ id: notionResourceId(notionString(page.id)), title: notionTitle(page), page })), ...unknown.map(id => ({ id, title: `Unloaded sprint · ${id.slice(0, 8)}`, page: null }))];
  const people = new Map<string, string>();
  for (const page of records) for (const raw of notionArray(notionProperty(page.properties, mapping.fields.assignee).people)) { const person = notionObject(raw); if (notionString(person.id)) people.set(notionString(person.id), notionString(person.name) || notionString(person.id)); }
  const priorities = notionOptions(notionProperties(source).find(property => property.id === mapping.fields.priority?.id));
  const visibleTasks = records.filter(page => (!assignee || notionRelationIds(notionProperty(page.properties, mapping.fields.assignee).people).includes(assignee)) && (!priority || notionString(notionObject(notionProperty(page.properties, mapping.fields.priority)[mapping.fields.priority?.type ?? ""]).id) === priority));
  const today = new Date().toISOString().slice(0, 10);
  const move = (page: NotionObject, current: string, target: string) => void action.run(async () => {
    if (!ref || ref.type !== "relation" || target && !planIds.has(notionResourceId(target))) throw new Error("Choose an authorized, loaded sprint.");
    const value = moveNotionSprint(notionProperty(page.properties, ref), current, target);
    await action.write({ connectionId, kind: "updatePage", id: notionString(page.id), base: notionPropertySnapshot(page.properties, [ref.id]), changes: { [ref.id]: { relation: value } } });
    onSaved();
  });
  if (ref?.type !== "relation" || !sprintSourceId) return <p className="text-ui text-muted-foreground">Map a shared relation-based Sprint field to enable planning. Select and multi-select sprint properties remain editable through record properties.</p>;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2"><NotionSelect label="Sprint phase" value={phase} onChange={setPhase} options={[{ value: "all", label: "All sprints and backlog" }, { value: "backlog", label: "Product backlog" }, { value: "current", label: "Current sprints" }, { value: "upcoming", label: "Upcoming sprints" }, { value: "completed", label: "Completed sprints" }, { value: "past", label: "Past dates · not completed" }, { value: "unscheduled", label: "Unscheduled sprints" }]} />{people.size ? <NotionSelect label="Planning assignee" value={assignee} onChange={setAssignee} options={[{ value: "", label: "All assignees" }, ...[...people].map(([value, label]) => ({ value, label }))]} /> : null}{priorities.length ? <NotionSelect label="Planning priority" value={priority} onChange={setPriority} options={[{ value: "", label: "All priorities" }, ...priorities]} /> : null}</div>
    <NotionError message={query.error?.message ?? schema.error?.message ?? action.error} /><NotionReceiptNotice active={action.awaitingConfirmation} />
    <p className="text-ui-sm text-muted-foreground">Planning uses mapped Notion statuses, estimates and relations—not agent execution state. {partial ? "Task totals cover the current API page; load other task pages before using them as complete project totals." : "Totals cover loaded records and current filters."} Moving a task preserves memberships in other sprints.</p>
    {!mapping.sprintPlan ? <p className="rounded-lg bg-muted p-3 text-ui-sm">Configure sprint dates and completed statuses in the existing Notion mapping to enable lifecycle filtering and sprint creation.</p> : null}
    {query.isLoading ? <p role="status" className="text-ui">Loading authorized sprints…</p> : null}
    <div className="grid gap-4 lg:grid-cols-2">{groups.filter(group => phase === "all" || phase === "backlog" ? phase === "all" || !group.id : group.page && notionSprintPhase(group.page, mapping.sprintPlan, today) === phase).map(group => {
      const tasks = visibleTasks.filter(page => group.id ? selected(page).includes(group.id) : selected(page).length === 0);
      const summary = notionPlanningSummary(tasks, mapping);
      const percent = summary.total ? Math.round(100 * summary.completed / summary.total) : 0;
      const dates = group.page && mapping.sprintPlan ? [notionPropertyLabel(notionProperty(group.page.properties, mapping.sprintPlan.start ?? undefined)), notionPropertyLabel(notionProperty(group.page.properties, mapping.sprintPlan.end ?? undefined))].filter(Boolean).join(" · ") : "";
      return <section key={group.id} className="space-y-3 rounded-xl border border-border bg-muted/10 p-4" aria-label={group.title} onDragOver={event => { if (drag && !locked && (!group.id || planIds.has(group.id))) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const current = drag; setDrag(null); if (current && current.from !== group.id) move(current.page, current.from, group.id); }}>
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-ui-lg font-semibold">{group.title}</h3>{group.page ? <p className="text-ui-sm capitalize text-muted-foreground">{notionSprintPhase(group.page, mapping.sprintPlan, today)}{dates ? " · " + dates : ""}</p> : null}</div>{group.page && schema.data ? <Button size="sm" variant="ghost" disabled={locked} onClick={() => setEditing({ page: structuredClone(group.page!), source: schema.data! })}>Edit sprint</Button> : null}</div>
        <div className="flex flex-wrap gap-3 text-ui-sm"><span>{summary.completed}/{summary.total} tasks completed</span>{mapping.fields.points ? <span>{summary.completedPoints}/{summary.points} story points</span> : <span className="text-muted-foreground">Story points not mapped</span>}</div>
        <div role="progressbar" aria-label={group.title + " completion"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${percent}%` }} /></div>
        {summary.workloads.length ? <details className="text-ui-sm"><summary className="cursor-pointer text-muted-foreground">Assignee workload</summary>{summary.workloads.map(person => <p key={person.id}>{person.name}: {person.tasks} tasks · {person.points} points</p>)}<p className="text-muted-foreground">Multi-assigned tasks count toward each person's workload, once toward the sprint total.</p></details> : null}
        <h4 className="text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">{group.id ? "Sprint backlog" : "Ready to plan"}</h4>
        <div className="space-y-2">{tasks.map(page => {
          const dependencies = notionRelationIds(notionProperty(page.properties, mapping.fields.dependencies).relation);
          const blockers = dependencies.filter(id => { const dependency = records.find(record => notionString(record.id).replaceAll("-", "") === id.replaceAll("-", "")); return dependency && !notionRecordDone(dependency, mapping); });
          const unresolved = dependencies.filter(id => !records.some(record => notionString(record.id).replaceAll("-", "") === id.replaceAll("-", "")));
          return <article key={notionString(page.id)} className="space-y-2 rounded-lg border border-border bg-background p-3" draggable={!locked && notionProperty(page.properties, ref).has_more !== true} onDragStart={() => setDrag({ page: structuredClone(page), from: group.id })} onDragEnd={() => setDrag(null)}>
            <Button variant="ghost" className="max-w-full justify-start truncate" onClick={() => onOpen(notionString(page.id), "page")}>{notionTitle(page)}</Button>
            <p className="text-ui-xs text-muted-foreground">{[notionPropertyLabel(notionProperty(page.properties, mapping.fields.status)), notionPropertyLabel(notionProperty(page.properties, mapping.fields.priority)), notionPropertyLabel(notionProperty(page.properties, mapping.fields.assignee))].filter(Boolean).join(" · ")}</p>
            {dependencies.length ? <p className="text-ui-xs text-muted-foreground">{blockers.length} known blockers · {unresolved.length} dependencies outside loaded records</p> : null}
            <div className="flex flex-wrap items-center gap-2"><NotionSelect label={`Move ${notionTitle(page)} from ${group.title}`} value={group.id} onChange={target => move(page, group.id, target)} disabled={locked || notionProperty(page.properties, ref).has_more === true} options={[{ value: "", label: "Product backlog" }, ...plans.map(plan => ({ value: notionResourceId(notionString(plan.id)), label: notionTitle(plan) })), ...(!group.page && group.id ? [{ value: group.id, label: group.title }] : [])]} /><Button size="sm" variant="ghost" disabled={locked} onClick={() => setEditing({ page: structuredClone(page), source })}>Properties</Button></div>
          </article>;
        })}{!tasks.length ? <p className="rounded-lg border border-dashed border-border p-3 text-ui-sm text-muted-foreground">No loaded tasks match this backlog. Drag a task here or use its sprint selector.</p> : null}</div>
      </section>;
    })}</div>
    {query.hasNextPage ? <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more sprints</Button> : null}
    {query.data?.pages.at(-1)?.more && !query.hasNextPage ? <p role="status" className="text-ui-sm text-muted-foreground">Sprint pagination is incomplete or reached its bound. Unloaded plans and memberships are retained.</p> : null}
    {mapping.sprintPlan && schema.data ? <details className="rounded-xl border border-border p-3"><summary className="text-ui font-medium">Create a sprint</summary><form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void action.run(async () => {
      const plan = mapping.sprintPlan; if (!plan) throw new Error("Configure a sprint schema first.");
      const properties: Record<string, unknown> = { [plan.title.id]: { title: plainNotionText(title.trim()) } };
      if (from && !notionDay(from) || to && (!notionDay(to) || from && to < from)) throw new Error("Choose a valid sprint date range.");
      if (from && plan.start) properties[plan.start.id] = { date: { start: from, ...((!plan.end || plan.end.id === plan.start.id) && to ? { end: to } : {}) } };
      if (to && plan.end && plan.end.id !== plan.start?.id) properties[plan.end.id] = { date: { start: to } };
      await action.write({ connectionId, kind: "createPage", id: plan.dataSourceId, base: {}, changes: { properties } });
      setTitle(""); setFrom(""); setTo(""); await query.refetch();
    }); }}><fieldset className="grid gap-3 sm:grid-cols-3" disabled={locked}><label className="grid gap-1 text-ui-sm">Sprint name<Input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label className="grid gap-1 text-ui-sm">Start<Input type="date" value={from} disabled={!mapping.sprintPlan.start} onChange={event => setFrom(event.target.value)} /></label><label className="grid gap-1 text-ui-sm">End<Input type="date" value={to} disabled={!mapping.sprintPlan.end && !mapping.sprintPlan.start} onChange={event => setTo(event.target.value)} /></label></fieldset><div className="flex gap-2"><Button type="submit" disabled={locked || !title.trim()}>Create sprint</Button><Button type="button" variant="ghost" disabled={action.pending} onClick={() => { setTitle(""); setFrom(""); setTo(""); }}>Discard draft</Button></div></form></details> : null}
    {editing ? <NotionRecordPropertyEditor connectionId={connectionId} source={editing.source} page={editing.page} onClose={() => setEditing(null)} onSaved={() => { onSaved(); void query.refetch(); }} /> : null}
  </div>;
}
''')

path = 'apps/web/src/components/notion/NotionDatabaseWorkspace.tsx'
file = ROOT / path
text = file.read_text()
text = text.replace('import { useState } from "react";', 'import { useState } from "react";\nimport { NotionPlanningPanel } from "./NotionPlanningPanel";\nimport { NotionRecordPropertyEditor } from "./NotionRecordPropertyEditor";\nimport { moveNotionDate } from "./notionPlanning";')
text = text.replace('propertyId: string; value: string } | null>', 'propertyId: string; value: string; page: NotionObject } | null>')
text = text.replace('  const [dragId, setDragId]', '  const [propertyPage, setPropertyPage] = useState<NotionObject | null>(null);\n  const [dragId, setDragId]')
# Move the query below schema-derived columns before adding source-level filters.
a = text.index('  const query = useQuery({\n    queryKey: ["notion", "records"')
b = text.index('  const mappings = useQuery({', a)
text = text[:a] + text[b:]
marker = '  const statusOptions = notionOptions(status);'
assert text.count(marker) == 1
query = r'''
  const query = useQuery({
    queryKey: ["notion", "records", connectionId, id, cursor, filter, statusFilter, sortKey, descending],
    enabled: Boolean(schema.data), retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async () => {
      const clauses: NotionObject[] = [];
      const titleColumn = columns.find(column => column.type === "title");
      if (filter.trim() && titleColumn) clauses.push({ property: titleColumn.id, title: { contains: filter.trim() } });
      if (statusFilter && status) {
        const option = statusOptions.find(value => value.value === statusFilter);
        if (option) clauses.push({ property: status.id, [status.type]: { equals: option.label } });
      }
      const sort = sortKey === "title" ? titleColumn?.id : columns.find(column => column.id === sortKey)?.id;
      const data = (await notionApi().read({ connectionId, kind: "query", id, pageSize: 50, ...(cursor ? { cursor } : {}), ...(clauses.length ? { filter: clauses.length === 1 ? clauses[0]! : { and: clauses } } : {}), ...(sort ? { sorts: [{ property: sort, direction: descending ? "descending" : "ascending" }] } : {}) })).data;
      if (!Array.isArray(data.results) || typeof data.has_more !== "boolean" || data.has_more && !notionString(data.next_cursor)) throw new Error("Notion returned an incomplete record page. Existing drafts are preserved.");
      return data;
    },
  });
'''
text = text.replace(marker, marker + query)
# Remove the superseded first-page-only sprint reader and helpers.
a = text.index('  const sprintQuery = useQuery({')
b = text.index('  const statusOptions =', a)
text = text[:a] + text[b:]
a = text.index('  const sprintPages = notionArray(')
b = text.index('  const groupStatus =', a)
text = text[:a] + text[b:]
a = text.index('    {view === "sprints" ?')
b = text.index('    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!cursor', a)
text = text[:a] + '''    {view === "sprints" ? mapping && schema.data ? <NotionPlanningPanel connectionId={connectionId} mapping={mapping} source={schema.data} records={records} partial={Boolean(cursor || query.data?.has_more)} onOpen={onOpen} onSaved={() => void query.refetch()} /> : <p className="text-ui text-muted-foreground">Map this data source to Synara Tasks to use sprint planning.</p> : null}\n\n''' + text[b:]
text = text.replace(' ?? sprintQuery.error?.message', '')
text = text.replace('    retry: false,\n  });', '    retry: false, gcTime: 0, refetchOnWindowFocus: false,\n  });')
text = text.replace('const page = selectedPage(editing.pageId);', 'const page = editing.page;')
text = text.replace('setEditing({ pageId: notionString(page.id), propertyId: column.id, value })', 'setEditing({ pageId: notionString(page.id), propertyId: column.id, value, page: structuredClone(page) })')
text = text.replace('return <Button size="sm" variant="ghost" aria-label={"Edit "', 'return <Button size="sm" variant="ghost" disabled={action.pending || action.awaitingConfirmation} aria-label={"Edit "')
text = text.replace('if (!date || !safeDateOnly(property(page, date)) || dateKey(target) !== target) throw new Error("Only date-only values can be moved on this calendar.");\n    await save(page, date, { start: target });', 'if (!date) throw new Error("Choose a calendar date property.");\n    await save(page, date, moveNotionDate(property(page, date), target));')
text = text.replace('&& !date.end);', '&& (!date.end || dateKey(date.end) === date.end));')
text = text.replace('aria-label="Filter loaded records" placeholder="Search loaded record titles" value={filter} onChange={event => setFilter(event.target.value)}', 'aria-label="Search database record titles" placeholder="Search this database" value={filter} maxLength={200} onChange={event => { if (guard?.mayLeave() !== false) { setFilter(event.target.value); setCursor(undefined); } }}')
text = text.replace('onChange={setStatusFilter}', 'onChange={value => { if (guard?.mayLeave() !== false) { setStatusFilter(value); setCursor(undefined); } }}')
text = text.replace('onChange={setSortKey}', 'onChange={value => { if (guard?.mayLeave() !== false) { setSortKey(value); setCursor(undefined); } }}')
text = text.replace('onClick={() => setDescending(value => !value)}', 'onClick={() => { if (guard?.mayLeave() !== false) { setDescending(value => !value); setCursor(undefined); } }}')
text = text.replace('Synara-local views of the current Notion API page, not Notion saved views.', 'Synara-native views, not Notion saved-view configurations. Search, status filters and sorting run against the authorized database API.')
text = text.replace('<td className="p-2">{open(page)}</td>', '<td className="p-2"><div className="flex items-center gap-1">{open(page)}<Button size="sm" variant="ghost" aria-label={"Edit properties for " + notionTitle(page)} onClick={() => setPropertyPage(structuredClone(page))}>Properties</Button></div></td>')
text = text.replace('{updatePage(page, column)}</td>', '{["title", "rich_text", "relation", "people", "multi_select"].includes(column.type) ? <Button size="sm" variant="ghost" className="max-w-56 truncate" onClick={() => setPropertyPage(structuredClone(page))}>{notionPropertyLabel(property(page, column)) || "Edit properties"}</Button> : updatePage(page, column)}</td>')
text = text.replace('records.filter(page => dateFor(page) === key)', 'records.filter(page => { const range = notionObject(property(page, date).date); const from = dateKey(range.start); const to = dateKey(range.end) || from; return from && key >= from && key <= to; })')
text = text.replace('    <NotionReceiptNotice active={action.awaitingConfirmation} />', '    <NotionReceiptNotice active={action.awaitingConfirmation} />\n    {propertyPage && schema.data ? <NotionRecordPropertyEditor connectionId={connectionId} source={schema.data} page={propertyPage} onClose={() => setPropertyPage(null)} onSaved={() => void query.refetch()} /> : null}')
file.write_text(text)
print('Prepared native paginated sprint planning, workload summaries, remote filtering and frozen edit baselines.')
