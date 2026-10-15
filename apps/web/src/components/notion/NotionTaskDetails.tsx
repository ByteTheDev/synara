import type { Todo } from "@synara/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { NotionBrowser } from "./NotionBrowser";

export function NotionTaskDetails({ todo }: { todo: Todo }) {
  const [open, setOpen] = useState(false); const external = todo.external;
  if (!external) return null;
  return <div className="space-y-2 rounded-xl border border-border p-3 text-ui-sm"><div className="flex items-center justify-between gap-2"><span className="font-medium">Notion · {external.workspaceName}</span><Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Page details</Button></div><p className="text-muted-foreground">{external.status ?? "No mapped status"} · {external.syncState}{external.assignees.length ? ` · ${external.assignees.join(", ")}` : ""}</p>{external.sprintIds.length ? <p className="break-words text-muted-foreground">Sprint: {external.sprintIds.join(", ")}</p> : null}{external.storyPoints !== null ? <p className="text-muted-foreground">{external.storyPoints} story points</p> : null}{external.syncMessage ? <p role="status">{external.syncMessage}</p> : null}<p className="text-muted-foreground">Finishing an agent run does not complete this Notion task.</p>{open ? <NotionBrowser connectionId={external.connectionId} pageId={external.pageId} onClose={() => setOpen(false)} /> : null}</div>;
}
