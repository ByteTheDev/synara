// FILE: modelSelectionCompatibility.test.ts
// Purpose: Protects provider inference and option normalization for persisted model selections.
// Layer: Persistence compatibility tests
// Depends on: modelSelectionCompatibility.

import { DEFAULT_PROVIDER_PROFILE_ID, ModelSelection } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import { Schema } from "effect";

import { normalizePersistedModelSelection } from "./modelSelectionCompatibility.ts";

it("preserves explicit provider instance ids during compatibility normalization", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "claudeAgent",
      instanceId: "work",
      model: "claude-sonnet-4-6",
    }),
    {
      provider: "claudeAgent",
      instanceId: "work",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "claude-sonnet-4-6",
    },
  );
});

it("uses settings to resolve opaque provider instance ids", () => {
  assert.deepEqual(
    normalizePersistedModelSelection(
      {
        instanceId: "work",
        model: "company-model",
      },
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          work: {
            driver: "claudeAgent",
            enabled: true,
          },
        },
      },
    ),
    {
      provider: "claudeAgent",
      instanceId: "work",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "company-model",
    },
  );
});

it("migrates legacy Kilo provider values and labels to OpenCode", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
      options: { kilo: { variant: "high" } },
    }),
    {
      provider: "opencode",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "kilo/kilo-auto/free",
      options: { variant: "high" },
    },
  );
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "Kilo Code local runtime",
      model: "custom/provider-model",
    }),
    {
      provider: "opencode",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "custom/provider-model",
    },
  );
});

it("migrates combined Antigravity model and effort labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "antigravity",
      model: "Gemini 3.5 Flash (High)",
    }),
    {
      provider: "antigravity",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "Gemini 3.5 Flash",
      options: { reasoningEffort: "high" },
    },
  );
});

it("prefers an explicit Antigravity instance over a model vendor in its label", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "Antigravity Claude runtime",
      model: "Claude Sonnet 4.6 (Thinking)",
    }),
    {
      provider: "antigravity",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "Claude Sonnet 4.6",
      options: { reasoningEffort: "thinking" },
    },
  );
});

it("migrates known Gemini models without discarding the saved selection", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
    }),
    {
      provider: "antigravity",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "Gemini 3.1 Pro",
    },
  );
});

it("preserves unknown Gemini models as custom Antigravity selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "gemini",
      model: "gemini-custom-preview",
    }),
    {
      provider: "antigravity",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gemini-custom-preview",
    },
  );
});

it("infers Pi from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-pi-runtime-instance",
      model: "openai/gpt-5.5",
    }),
    {
      provider: "pi",
      instanceId: "local-pi-runtime-instance",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "openai/gpt-5.5",
    },
  );
});

it("preserves canonical Devin model selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "devin",
      model: "swe-1-7",
      options: { reasoningEffort: "high" },
    }),
    {
      provider: "devin",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "swe-1-7",
      options: { reasoningEffort: "high" },
    },
  );
});

it("infers Devin from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "Devin CLI",
      model: "adaptive",
    }),
    {
      provider: "devin",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "adaptive",
    },
  );
});

it("infers Droid only for Factory-exclusive provider-less model slugs", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "minimax-m3" }), {
    provider: "droid",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "minimax-m3",
  });
});

it("does not steal ambiguous provider-less Claude slugs from Claude Agent", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "claude-opus-4-8" }), {
    provider: "claudeAgent",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "claude-opus-4-8",
  });
});

it("infers Devin from provider-less model slugs containing devin", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "devin-core" }), {
    provider: "devin",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "devin-core",
  });
});

it("preserves explicit provider profile routing", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "codex",
      profileId: "work",
      model: "gpt-5.6-codex",
    }),
    {
      provider: "codex",
      profileId: "work",
      model: "gpt-5.6-codex",
    },
  );
});

it("does not replace an invalid explicit profile with the default", () => {
  const normalized = normalizePersistedModelSelection({
    provider: "codex",
    profileId: "../work",
    model: "gpt-5.6-codex",
  });

  assert.equal(Schema.decodeUnknownExit(ModelSelection)(normalized)._tag, "Failure");
});
