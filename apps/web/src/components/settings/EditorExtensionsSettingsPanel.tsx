import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EditorExtensionSummary,
  EditorExtensionsInput,
  EditorExtensionsResult,
} from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const stateKey = ["editor-extensions"] as const;
const UPLOAD_CHUNK = 512 * 1_024;
async function request(
  input: EditorExtensionsInput,
  signal?: AbortSignal,
): Promise<EditorExtensionsResult> {
  const extensions = ensureNativeApi().editor?.extensions;
  if (!extensions) throw new Error("This server does not provide editor extension management.");
  return extensions(input, signal ? { signal } : undefined);
}
function consentClosure(
  root: EditorExtensionSummary,
  entries: readonly EditorExtensionSummary[],
): EditorExtensionSummary[] {
  const result = new Map<string, EditorExtensionSummary>();
  const visiting = new Set<string>();
  const visit = (entry: EditorExtensionSummary) => {
    if (visiting.has(entry.id)) throw new Error("Extension dependencies contain a cycle.");
    if (result.has(entry.id)) return;
    if (entry.error) throw new Error(entry.error);
    visiting.add(entry.id);
    for (const id of entry.dependencies) {
      const dependency = entries.find((candidate) => candidate.id === id);
      if (!dependency)
        throw new Error(`Install required extension ${id} before enabling this extension.`);
      visit(dependency);
    }
    visiting.delete(entry.id);
    result.set(entry.id, entry);
  };
  visit(root);
  return [...result.values()];
}
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(text);
}
type Approval =
  | { kind: "enable"; entries: EditorExtensionSummary[]; id: string }
  | { kind: "remove"; entry: EditorExtensionSummary }
  | { kind: "trust"; cwd: string };

/** All presentation belongs to Synara. Registry text is rendered as text, never HTML. */
export function EditorExtensionsSettingsPanel() {
  const queryClient = useQueryClient();
  const searchId = useId();
  const workspaceId = useId();
  const configurationId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const live = useRef(true);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<{ id: string; json: string } | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      active.current?.abort();
    };
  }, []);
  const state = useQuery({
    queryKey: stateKey,
    queryFn: ({ signal }) => request({ operation: "list" }, signal),
    retry: false,
  });
  const results = useQuery({
    queryKey: ["editor-extension-search", submittedSearch],
    queryFn: ({ signal }) => request({ operation: "search", query: submittedSearch ?? "" }, signal),
    enabled: submittedSearch !== null,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (input: EditorExtensionsInput | { file: File }) => {
      if (active.current) throw new Error("An extension operation is already running.");
      const controller = new AbortController();
      active.current = controller;
      let uploadId: string | undefined;
      try {
        if (!("file" in input)) return await request(input, controller.signal);
        if (
          !input.file.name.toLowerCase().endsWith(".vsix") ||
          input.file.size === 0 ||
          input.file.size > 128 * 1_024 * 1_024
        ) {
          throw new Error("Choose a VSIX package no larger than 128 MiB.");
        }
        const begin = await request(
          { operation: "uploadBegin", total: input.file.size },
          controller.signal,
        );
        uploadId = begin.uploadId;
        if (!uploadId) throw new Error("The server did not create a VSIX upload.");
        for (let offset = 0; offset < input.file.size; offset += UPLOAD_CHUNK) {
          controller.signal.throwIfAborted();
          const bytes = new Uint8Array(
            await input.file.slice(offset, offset + UPLOAD_CHUNK).arrayBuffer(),
          );
          const result = await request(
            { operation: "uploadAppend", uploadId, offset, chunk: base64(bytes) },
            controller.signal,
          );
          if (result.offset !== offset + bytes.length)
            throw new Error("The server did not acknowledge the VSIX chunk.");
          if (live.current)
            setProgress(`Uploading VSIX: ${Math.round((result.offset / input.file.size) * 100)}%`);
        }
        if (live.current) setProgress("Validating and installing VSIX...");
        return await request({ operation: "uploadFinish", uploadId }, controller.signal);
      } finally {
        if (uploadId) void request({ operation: "uploadCancel", uploadId }).catch(() => undefined);
        if (active.current === controller) active.current = null;
        if (live.current) setProgress(null);
      }
    },
    onSuccess: (result) => {
      queryClient.setQueryData(stateKey, result);
      if (live.current) {
        setApproval(null);
        setLocalError(null);
      }
    },
  });
  const run = (input: EditorExtensionsInput) => {
    setLocalError(null);
    mutation.mutate(input);
  };
  const entries = state.data?.extensions ?? [];
  const error = localError ?? (mutation.error instanceof Error ? mutation.error.message : null);
  const busy = mutation.isPending;
  const approve = () => {
    if (!approval) return;
    if (approval.kind === "enable")
      run({
        operation: "setEnabled",
        id: approval.id,
        enabled: true,
        consent: approval.entries.map((entry) => ({ id: entry.id, digest: entry.digest })),
      });
    else if (approval.kind === "remove")
      run({ operation: "remove", id: approval.entry.id, version: approval.entry.version });
    else run({ operation: "setTrust", cwd: approval.cwd, trusted: true });
  };
  const inspect = async (entry: EditorExtensionSummary) => {
    try {
      const result = await mutation.mutateAsync({ operation: "inspect", id: entry.id });
      if (live.current) setConfiguration({ id: entry.id, json: result.configurationJson ?? "{}" });
    } catch {
      /* The mutation owns the visible error. */
    }
  };

  return (
    <div className="space-y-6">
      {state.error ? (
        <SettingsEmptyState tone="destructive" layout="status">
          {state.error.message}
        </SettingsEmptyState>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-ui text-destructive"
        >
          {error}
        </div>
      ) : null}
      {busy ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 text-ui text-muted-foreground"
        >
          <span>{progress ?? "Updating extensions..."}</span>
          <Button size="xs" variant="outline" onClick={() => active.current?.abort()}>
            Cancel
          </Button>
        </div>
      ) : null}
      <SettingsSectionShell
        title="Find extensions"
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !state.data}
            onClick={() => fileInput.current?.click()}
          >
            Install VSIX
          </Button>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept=".vsix"
          className="hidden"
          aria-label="Choose VSIX package"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) mutation.mutate({ file });
          }}
        />
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedSearch(search.trim());
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor={searchId} className="text-ui-sm text-muted-foreground">
              Search Open VSX
            </label>
            <Input
              id={searchId}
              value={search}
              maxLength={256}
              placeholder="Formatter, language, or publisher"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={results.isFetching || !state.data}
          >
            Search
          </Button>
        </form>
        <p className="mt-2 text-ui-sm text-muted-foreground">
          Packages are installed disabled. Installing a package does not authorize it to run.
        </p>
        {results.isFetching ? (
          <p role="status" className="mt-3 text-ui text-muted-foreground">
            Searching Open VSX...
          </p>
        ) : null}
        {results.error ? (
          <p role="alert" className="mt-3 text-ui text-destructive">
            {results.error.message}
          </p>
        ) : null}
        {submittedSearch !== null && results.data?.registryResults.length === 0 ? (
          <SettingsEmptyState layout="status">No matching extensions found.</SettingsEmptyState>
        ) : null}
        {results.data?.registryResults.length ? (
          <SettingsCard>
            {results.data.registryResults.map((extension) => {
              const id = `${extension.namespace}.${extension.name}`.toLowerCase();
              const installed = entries.find((entry) => entry.id === id);
              return (
                <SettingsListRow
                  key={id}
                  title={extension.displayName ?? id}
                  description={
                    <>
                      <span>
                        {id} · {extension.version}
                      </span>
                      <p>{extension.description}</p>
                    </>
                  }
                  actions={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || Boolean(installed)}
                      onClick={() => run({ operation: "install", id })}
                    >
                      {installed ? "Installed" : "Install compatible version"}
                    </Button>
                  }
                />
              );
            })}
          </SettingsCard>
        ) : null}
      </SettingsSectionShell>
      <SettingsSectionShell
        title="Installed extensions"
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={busy || entries.length === 0}
            onClick={() => run({ operation: "checkUpdates" })}
          >
            Check for updates
          </Button>
        }
      >
        {state.isPending ? (
          <SettingsEmptyState layout="status">Loading extensions...</SettingsEmptyState>
        ) : entries.length === 0 ? (
          <SettingsEmptyState>No editor extensions installed.</SettingsEmptyState>
        ) : (
          <SettingsCard>
            {entries.map((entry) => (
              <SettingsListRow
                key={entry.id}
                title={entry.displayName}
                description={
                  <>
                    <span>
                      {entry.id} · {entry.version} · {entry.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <p>{entry.description}</p>
                    {entry.error ? (
                      <p role="alert" className="text-destructive">
                        {entry.error}
                      </p>
                    ) : null}
                  </>
                }
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.updateVersion ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          run({ operation: "install", id: entry.id, version: entry.updateVersion })
                        }
                      >
                        Update to {entry.updateVersion}
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || Boolean(entry.error)}
                      onClick={() => {
                        if (entry.enabled)
                          run({ operation: "setEnabled", id: entry.id, enabled: false });
                        else {
                          try {
                            setApproval({
                              kind: "enable",
                              id: entry.id,
                              entries: consentClosure(entry, entries),
                            });
                          } catch (cause) {
                            setLocalError(
                              cause instanceof Error
                                ? cause.message
                                : "Unable to enable extension.",
                            );
                          }
                        }
                      }}
                    >
                      {entry.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || Boolean(entry.error)}
                      onClick={() => void inspect(entry)}
                    >
                      Configure
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setApproval({ kind: "remove", entry })}
                    >
                      Remove
                    </Button>
                  </div>
                }
              />
            ))}
          </SettingsCard>
        )}
      </SettingsSectionShell>
      {configuration ? (
        <SettingsSectionShell title={`Configuration · ${configuration.id}`}>
          <label htmlFor={configurationId} className="text-ui-sm text-muted-foreground">
            Extension settings as JSON
          </label>
          <Textarea
            id={configurationId}
            value={configuration.json}
            spellCheck={false}
            onChange={(event) => setConfiguration({ ...configuration, json: event.target.value })}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfiguration(null)}
            >
              Close
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run({
                  operation: "configure",
                  id: configuration.id,
                  configurationJson: configuration.json,
                })
              }
            >
              Save configuration
            </Button>
          </div>
        </SettingsSectionShell>
      ) : null}
      <SettingsSectionShell title="Workspace trust">
        <p className="mb-3 text-ui-sm text-muted-foreground">
          Only trust workspaces you recognize. Enabling an extension and trusting a workspace are
          separate permissions. Revoking trust stops extension hosts.
        </p>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor={workspaceId} className="text-ui-sm text-muted-foreground">
              Workspace directory
            </label>
            <Input
              id={workspaceId}
              value={workspace}
              maxLength={4_096}
              onChange={(event) => setWorkspace(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !workspace.trim()}
            onClick={() => setApproval({ kind: "trust", cwd: workspace.trim() })}
          >
            Trust workspace
          </Button>
        </div>
        {state.data?.trustedWorkspaces.length ? (
          <SettingsCard>
            {state.data.trustedWorkspaces.map((cwd) => (
              <SettingsListRow
                key={cwd}
                title={cwd}
                actions={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => run({ operation: "setTrust", cwd, trusted: false })}
                  >
                    Revoke trust
                  </Button>
                }
              />
            ))}
          </SettingsCard>
        ) : null}
      </SettingsSectionShell>
      <p role="status" className="text-ui-sm text-muted-foreground">
        Extension runtime: {state.data?.runtime ?? "unavailable"}. API target:{" "}
        {state.data?.apiVersion ?? "unknown"}.
        {state.data?.runtime === "not-built"
          ? " Installed packages cannot execute until a supported runtime is built."
          : ""}
      </p>
      <AlertDialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setApproval(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {approval?.kind === "enable"
                ? "Enable trusted extension code?"
                : approval?.kind === "remove"
                  ? "Remove extension?"
                  : "Trust this workspace?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {approval?.kind === "enable"
                ? "Extensions execute code. Approve only publishers and package versions you trust. Updates require a new approval."
                : approval?.kind === "remove"
                  ? "The installed package will be removed. Extension configuration and storage may contain separate data; workspace documents are not deleted."
                  : "Enabled, approved extensions may operate in this workspace. Trust does not enable any extension by itself."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 px-1 text-ui">
            {approval?.kind === "enable" ? (
              approval.entries.map((entry) => (
                <p key={entry.id} className="break-all">
                  {entry.id} · {entry.version}
                  <span className="block text-ui-xs text-muted-foreground">
                    SHA-256: {entry.digest}
                  </span>
                </p>
              ))
            ) : approval?.kind === "remove" ? (
              <p>
                {approval.entry.id} · {approval.entry.version}
              </p>
            ) : (
              <p className="break-all">{approval?.cwd}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={approval?.kind === "remove" ? "destructive" : "default"}
              disabled={busy}
              onClick={approve}
            >
              {approval?.kind === "enable"
                ? "Enable approved versions"
                : approval?.kind === "remove"
                  ? "Remove extension"
                  : "Trust workspace"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
