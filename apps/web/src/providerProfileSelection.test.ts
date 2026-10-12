import {
  DEFAULT_PROVIDER_PROFILE_ID,
  ProviderInstanceId,
  ProviderProfileId,
  type ProviderKind,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveEffectiveComposerModelState,
  makeModelSelection,
  resolveProfileIdForProviderInstance,
} from "./composerDraftModels";
import { buildModelSelection, buildModelSelectionForTarget } from "./providerModelOptions";

const PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "devin",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
  "omp",
] as const satisfies readonly ProviderKind[];
const WORK_PROFILE = ProviderProfileId.makeUnsafe("work");
const PERSONAL_PROFILE = ProviderProfileId.makeUnsafe("personal");
const WORK_INSTANCE = ProviderInstanceId.makeUnsafe("codex_work");
const OTHER_INSTANCE = ProviderInstanceId.makeUnsafe("codex_other");
const CUSTOM_MODELS: Record<ProviderKind, readonly string[]> = {
  codex: [],
  claudeAgent: [],
  cursor: [],
  devin: [],
  antigravity: [],
  grok: [],
  droid: [],
  opencode: [],
  pi: [],
  omp: [],
};

describe("provider profile selection boundaries", () => {
  it.each(PROVIDERS)("preserves separate instance and profile identities in every %s builder", (provider) => {
    const instanceId = ProviderInstanceId.makeUnsafe(`${provider}_installation`);
    const target = { provider, instanceId, profileId: WORK_PROFILE };
    const model = "account-scoped-model";
    const expected = { ...target, model };

    expect(buildModelSelection(provider, model, undefined, { instanceId, profileId: WORK_PROFILE })).toEqual(expected);
    expect(buildModelSelectionForTarget({ target, model })).toEqual(expected);
    expect(makeModelSelection(provider, model, undefined, undefined, instanceId, WORK_PROFILE)).toEqual(expected);
  });

  it("uses the first matching installation's profile without borrowing another installation's profile", () => {
    const other = makeModelSelection("codex", "gpt-5.5", undefined, undefined, OTHER_INSTANCE, PERSONAL_PROFILE);
    const matching = makeModelSelection("codex", "gpt-5.5", undefined, undefined, WORK_INSTANCE, WORK_PROFILE);
    const later = makeModelSelection("codex", "gpt-5.5", undefined, undefined, WORK_INSTANCE, PERSONAL_PROFILE);

    expect(resolveProfileIdForProviderInstance("codex", WORK_INSTANCE, [null, other, matching, later])).toBe(WORK_PROFILE);
  });

  it("treats an omitted instance as the provider default instead of an arbitrary named installation", () => {
    const other = makeModelSelection("codex", "gpt-5.5", undefined, undefined, WORK_INSTANCE, WORK_PROFILE);

    expect(resolveProfileIdForProviderInstance("codex", undefined, [other])).toBe(DEFAULT_PROVIDER_PROFILE_ID);
  });

  it("keeps model and options from the requested profile when another profile has newer thread and draft selections", () => {
    const project = makeModelSelection("codex", "gpt-5.5", { reasoningEffort: "low" }, undefined, WORK_INSTANCE, WORK_PROFILE);
    const other = makeModelSelection("codex", "gpt-5.4", { reasoningEffort: "high" }, undefined, WORK_INSTANCE, PERSONAL_PROFILE);
    const actual = deriveEffectiveComposerModelState({
      draft: { modelSelectionByProvider: { [WORK_INSTANCE]: other }, activeProvider: WORK_INSTANCE },
      selectedProvider: "codex",
      selectedProviderInstanceId: WORK_INSTANCE,
      selectedTarget: { provider: "codex", instanceId: WORK_INSTANCE, profileId: WORK_PROFILE },
      threadModelSelection: other,
      projectModelSelection: project,
      customModelsByProvider: CUSTOM_MODELS,
    });

    expect(actual.selectedModel).toBe(project.model);
    expect(actual.modelOptions).toEqual({ codex: { reasoningEffort: "low" } });
  });

  it("keeps model and options from the requested installation when profile names match across installations", () => {
    const project = makeModelSelection("codex", "gpt-5.5", { reasoningEffort: "low" }, undefined, WORK_INSTANCE, WORK_PROFILE);
    const other = makeModelSelection("codex", "gpt-5.4", { reasoningEffort: "high" }, undefined, OTHER_INSTANCE, WORK_PROFILE);
    const actual = deriveEffectiveComposerModelState({
      draft: { modelSelectionByProvider: { [OTHER_INSTANCE]: other }, activeProvider: OTHER_INSTANCE },
      selectedProvider: "codex",
      selectedProviderInstanceId: WORK_INSTANCE,
      selectedTarget: { provider: "codex", instanceId: WORK_INSTANCE, profileId: WORK_PROFILE },
      threadModelSelection: other,
      projectModelSelection: project,
      customModelsByProvider: CUSTOM_MODELS,
    });

    expect(actual.selectedModel).toBe(project.model);
    expect(actual.modelOptions).toEqual({ codex: { reasoningEffort: "low" } });
  });

  it("respects an explicit target's default installation despite an ambient named installation", () => {
    const project = makeModelSelection("codex", "gpt-5.5", { reasoningEffort: "low" }, undefined, undefined, WORK_PROFILE);
    const other = makeModelSelection("codex", "gpt-5.4", { reasoningEffort: "high" }, undefined, WORK_INSTANCE, WORK_PROFILE);
    const actual = deriveEffectiveComposerModelState({
      draft: { modelSelectionByProvider: { [WORK_INSTANCE]: other }, activeProvider: WORK_INSTANCE },
      selectedProvider: "codex",
      selectedProviderInstanceId: WORK_INSTANCE,
      selectedTarget: { provider: "codex", profileId: WORK_PROFILE },
      threadModelSelection: other,
      projectModelSelection: project,
      customModelsByProvider: CUSTOM_MODELS,
    });

    expect(actual.selectedModel).toBe(project.model);
    expect(actual.modelOptions).toEqual({ codex: { reasoningEffort: "low" } });
  });
});
