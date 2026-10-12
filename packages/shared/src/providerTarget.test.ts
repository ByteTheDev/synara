import assert from "node:assert/strict";

import { ProviderInstanceId, ProviderProfileId } from "@synara/contracts";
import { it } from "@effect/vitest";

import {
  defaultProviderTarget,
  providerTargetFromModelSelection,
  providerTargetFromSource,
  providerTargetsEqual,
} from "./providerTarget";

it("resolves legacy provider sources to the default provider profile", () => {
  assert.deepEqual(
    providerTargetFromSource({
      provider: "codex",
    }),
    {
      provider: "codex",
      profileId: "default",
    },
  );
});

it("preserves explicit provider profile routing", () => {
  const target = providerTargetFromModelSelection({
    provider: "codex",
    profileId: ProviderProfileId.makeUnsafe("work"),
    model: "gpt-5.6-codex",
  });

  assert.deepEqual(target, {
    provider: "codex",
    profileId: "work",
  });
  assert.equal(providerTargetsEqual(target, defaultProviderTarget("codex")), false);
  assert.equal(providerTargetsEqual(target, { ...target }), true);
});

it("keeps executable instances distinct even when their profile names match", () => {
  const work = providerTargetFromModelSelection({
    provider: "codex",
    instanceId: ProviderInstanceId.makeUnsafe("codex-work"),
    profileId: ProviderProfileId.makeUnsafe("primary"),
    model: "gpt-5.6-codex",
  });
  const personal = { ...work, instanceId: ProviderInstanceId.makeUnsafe("codex-personal") };
  assert.deepEqual(work, {
    provider: "codex",
    instanceId: "codex-work",
    profileId: "primary",
  });
  assert.equal(providerTargetsEqual(work, personal), false);
  assert.equal(providerTargetsEqual(work, { ...work }), true);
  assert.equal(
    providerTargetsEqual(
      defaultProviderTarget("codex"),
      defaultProviderTarget("codex", ProviderInstanceId.makeUnsafe("codex")),
    ),
    true,
  );
});
