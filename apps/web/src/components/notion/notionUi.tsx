import type { NotionApi, NotionWriteInput } from "@synara/contracts";
import { useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";

export function notionApi(): NotionApi {
  const api = ensureNativeApi().notion;
  if (!api) throw new Error("This Synara server does not support Notion.");
  return api;
}
export function useNotionAction() {
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Notion could not complete this operation."); }
    finally { setPending(false); }
  }
  return { pending, error, run };
}
export async function writeNotion(input: Omit<NotionWriteInput, "requestId" | "createdAt">) {
  const result = await notionApi().write({ ...input, requestId: crypto.randomUUID(), createdAt: new Date().toISOString() });
  if (result.change.state !== "synced") throw new Error(result.change.message ?? "This change is retained for review in Settings → Integrations → Notion. Do not submit it again.");
  return result.data;
}
export function NotionSelect({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select value={value} onValueChange={next => { if (typeof next === "string") onChange(next); }} items={options} disabled={disabled}>
    <SelectTrigger aria-label={label} size="sm"><SelectValue /></SelectTrigger>
    <SelectPopup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
  </Select>;
}
export function NotionError({ message }: { message: string | null | undefined }) { return message ? <p role="alert" className="text-ui text-destructive">{message}</p> : null; }
