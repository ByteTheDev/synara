import type { NotionField, NotionFieldMap, NotionMapping, NotionObject, ProjectId } from "@synara/contracts";
import { NOTION_FIELD_TYPES, suggestNotionFields } from "@synara/shared/notion";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { editNotionMapping, notionOptions, notionProperties } from "./notionProperties";
import { NotionError, NotionSelect, notionApi, useNotionAction } from "./notionUi";

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export function NotionMappingForm({ connectionId, source, existing, onSaved, onCancel }: {
  connectionId: string;
  source: NotionObject;
  existing?: NotionMapping | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [mappingId] = useState(() => existing?.id ?? crypto.randomUUID());
  const [fields, setFields] = useState<NotionFieldMap | null>(existing?.fields ?? suggestNotionFields(source));
  const [name, setName] = useState(existing?.name ?? "Notion tasks");
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? "");
  const [done, setDone] = useState<readonly string[]>(existing?.completedStatusIds ?? []);
  const [reopen, setReopen] = useState(existing?.reopenedStatusId ?? "");
  const [priorities, setPriorities] = useState<NotionMapping["priorityOptions"]>(existing?.priorityOptions ?? {});
  const action = useNotionAction();
  const properties = notionProperties(source);
  const statusOptions = notionOptions(properties.find((property) => property.id === fields?.status?.id));
  const priorityOptions = notionOptions(properties.find((property) => property.id === fields?.priority?.id));

  if (!fields) return <NotionError message="This data source has no title property and cannot be mapped to Tasks." />;

  return (
    <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => {
        const mapping = editNotionMapping(existing, source, {
          id: mappingId, connectionId, name, fields,
          projectId: projectId.trim() ? projectId.trim() as ProjectId : null,
          completedStatusIds: done, reopenedStatusId: reopen || null, priorityOptions: priorities,
        });
        await notionApi().saveMapping(mapping);
        await notionApi().sync();
        onSaved();
      });
    }}>
      <h3 className="font-medium text-foreground">Map to Synara Tasks</h3>
      <p className="text-ui text-muted-foreground">Choose properties by type. Renaming a property in Notion will not break this mapping. Agent execution and Notion status remain separate.</p>
      <fieldset className="space-y-4" disabled={action.pending}>
        <label className="grid gap-1 text-ui">Source label<Input value={name} maxLength={200} required onChange={(event) => setName(event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(NOTION_FIELD_TYPES) as NotionField[]).map((field) => (
            <div className="grid gap-1 text-ui" key={field}>
              <span className="capitalize">{field}</span>
              <NotionSelect label={`${field} property`} value={fields[field]?.id ?? ""}
                options={[
                  ...(field === "title" ? [] : [{ value: "", label: "Not mapped" }]),
                  ...properties.filter((property) => NOTION_FIELD_TYPES[field].includes(property.type)).map((property) => ({ value: property.id, label: property.label })),
                ]}
                disabled={action.pending}
                onChange={(selected) => {
                  const property = properties.find((value) => value.id === selected);
                  setFields((current) => {
                    if (!current) return current;
                    const copy = { ...current };
                    if (property) copy[field] = { id: property.id, type: property.type };
                    else if (field !== "title") delete copy[field];
                    return copy;
                  });
                  if (field === "status") { setDone([]); setReopen(""); }
                  if (field === "priority") setPriorities({});
                }} />
            </div>
          ))}
        </div>
        {statusOptions.length ? (
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-ui font-medium">Completed statuses</legend>
            <p className="text-ui-sm text-muted-foreground">Select every status that means completed. Multiple completion statuses remain distinct in Notion.</p>
            <div className="flex flex-wrap gap-3">
              {statusOptions.map((option) => <label className="flex items-center gap-2 text-ui" key={option.value}>
                <Checkbox checked={done.includes(option.value)} disabled={action.pending} onCheckedChange={(checked) => {
                  setDone((current) => checked ? [...new Set([...current, option.value])] : current.filter((id) => id !== option.value));
                  if (checked && reopen === option.value) setReopen("");
                }} />
                {option.label}
              </label>)}
            </div>
            <NotionSelect label="Reopened status" value={reopen} disabled={action.pending}
              options={[{ value: "", label: "No reopening mapping" }, ...statusOptions.filter((option) => !done.includes(option.value))]} onChange={setReopen} />
          </fieldset>
        ) : null}
        {priorityOptions.length ? (
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-ui font-medium">Priority mapping</legend>
            <p className="text-ui-sm text-muted-foreground">Choose one existing Notion option for each Synara priority. No remote options are created.</p>
            {PRIORITIES.map((priority) => <div className="grid gap-1 text-ui" key={priority}>
              <span className="capitalize">{priority}</span>
              <NotionSelect label={`${priority} priority option`} value={Object.entries(priorities).find(([, value]) => value === priority)?.[0] ?? ""} disabled={action.pending}
                options={[{ value: "", label: "Not mapped" }, ...priorityOptions.filter((option) => priorities[option.value] === undefined || priorities[option.value] === priority)]}
                onChange={(selected) => setPriorities((current) => {
                  const next = Object.fromEntries(Object.entries(current).filter(([, value]) => value !== priority));
                  if (selected) next[selected] = priority;
                  return next;
                })} />
            </div>)}
          </fieldset>
        ) : null}
        <label className="grid gap-1 text-ui">Synara project ID for delegation (optional)<Input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Keep tasks unassigned" /></label>
      </fieldset>
      {existing?.sprintPlan ? <p className="text-ui-sm text-muted-foreground">The existing sprint plan is retained when this mapping is saved.</p> : null}
      {existing?.enabled === false ? <p role="status" className="text-ui-sm text-muted-foreground">This source is paused. Saving these settings does not resume synchronization.</p> : null}
      <p className="text-ui-sm text-muted-foreground">Direct agent access is disabled. Hand off an individual task using Synara's existing Tasks controls; this does not grant access to the workspace.</p>
      <NotionError message={action.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={action.pending}>Cancel</Button>
        <Button type="submit" disabled={action.pending || !name.trim()}>{action.pending ? "Saving mapping…" : existing ? "Save mapping" : "Use in Tasks"}</Button>
      </div>
    </form>
  );
}
