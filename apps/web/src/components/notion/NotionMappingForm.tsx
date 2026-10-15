import type { NotionField, NotionFieldMap, NotionMapping, NotionObject, ProjectId } from "@synara/contracts";
import { NOTION_FIELD_TYPES, notionArray, notionObject, notionString, suggestNotionFields } from "@synara/shared/notion";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NotionError, NotionSelect, notionApi, useNotionAction } from "./notionUi";

export function NotionMappingForm({ connectionId, source, existing, onSaved, onCancel }: { connectionId: string; source: NotionObject; existing?: NotionMapping | undefined; onSaved: () => void; onCancel: () => void }) {
  const [fields, setFields] = useState<NotionFieldMap | null>(existing?.fields ?? suggestNotionFields(source));
  const [name, setName] = useState(existing?.name ?? "Notion tasks");
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? "");
  const [done, setDone] = useState(existing?.completedStatusIds[0] ?? "");
  const [reopen, setReopen] = useState(existing?.reopenedStatusId ?? "");
  const action = useNotionAction();
  const properties = Object.entries(notionObject(source.properties)).map(([label, raw]) => ({ ...notionObject(raw), label }));
  const status = fields?.status ? properties.find(value => value.id === fields.status?.id) : undefined;
  const statusOptions = notionArray(notionObject(status?.[fields?.status?.type ?? ""]).options).map(raw => { const item = notionObject(raw); return { value: notionString(item.id), label: notionString(item.name) }; });
  if (!fields) return <NotionError message="This data source has no title property and cannot be mapped to Tasks." />;
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={event => { event.preventDefault(); void action.run(async () => {
    await notionApi().saveMapping({ id: existing?.id ?? crypto.randomUUID(), connectionId, dataSourceId: notionString(source.id), name, projectId: projectId.trim() ? projectId.trim() as ProjectId : null, fields, completedStatusIds: done ? [done] : [], reopenedStatusId: reopen || null, priorityOptions: existing?.priorityOptions ?? {}, agentAccess: "none", enabled: true });
    await notionApi().sync(); onSaved();
  }); }}>
    <h3 className="font-medium text-foreground">Map to Synara Tasks</h3>
    <p className="text-ui text-muted-foreground">Choose properties by type. Renaming a property in Notion will not break this mapping. Agent execution and Notion status remain separate.</p>
    <label className="grid gap-1 text-ui">Source label<Input value={name} maxLength={200} required onChange={event => setName(event.target.value)} /></label>
    <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(NOTION_FIELD_TYPES) as NotionField[]).map(field => <label className="grid gap-1 text-ui" key={field}><span className="capitalize">{field}</span><NotionSelect label={`${field} property`} value={fields[field]?.id ?? ""} options={[...(field === "title" ? [] : [{ value: "", label: "Not mapped" }]), ...properties.filter(property => NOTION_FIELD_TYPES[field].includes(notionString(property.type))).map(property => ({ value: notionString(property.id), label: property.label }))]} onChange={selected => { const property = properties.find(value => value.id === selected); setFields(current => { if (!current) return current; const copy = { ...current }; if (property) copy[field] = { id: selected, type: notionString(property.type) }; else if (field !== "title") delete copy[field]; return copy; }); if (field === "status") { setDone(""); setReopen(""); } }} /></label>)}</div>
    {statusOptions.length ? <div className="grid gap-3 sm:grid-cols-2"><NotionSelect label="Completed status" value={done} options={[{ value: "", label: "No completion mapping" }, ...statusOptions]} onChange={setDone} /><NotionSelect label="Reopened status" value={reopen} options={[{ value: "", label: "No reopening mapping" }, ...statusOptions.filter(option => option.value !== done)]} onChange={setReopen} /></div> : null}
    <label className="grid gap-1 text-ui">Synara project ID for delegation (optional)<Input value={projectId} onChange={event => setProjectId(event.target.value)} placeholder="Keep tasks unassigned" /></label>
    <p className="text-ui-sm text-muted-foreground">Direct agent access is disabled. You can hand off an individual task using Synara's existing Tasks controls. This does not grant access to the workspace.</p>
    <NotionError message={action.error} /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel} disabled={action.pending}>Cancel</Button><Button type="submit" disabled={action.pending || !name.trim()}>{action.pending ? "Saving mapping…" : "Use in Tasks"}</Button></div>
  </form>;
}
