import {
  DEFAULT_PROVIDER_PROFILE_ID,
  ProviderInstanceId,
  ProviderProfileId,
  type ModelSelection,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveTurnStartModelSelection } from "./turnStartSession.ts";

const CURRENT: ModelSelection = {
  provider: "codex",
  instanceId: ProviderInstanceId.makeUnsafe("codex_work"),
  profileId: ProviderProfileId.makeUnsafe("work"),
  model: "gpt-5.5",
};

// This exported compatibility helper is not the current ProviderCommandReactor
// routing path. Its identity rules remain explicit for callers that still use it.
describe("turn-start selection compatibility helper", () => {
  it("accepts a model change within the same provider, installation, and profile", () => {
    const requested: ModelSelection = { ...CURRENT, model: "gpt-5.4" };
    expect(deriveTurnStartModelSelection({
      currentModelSelection: CURRENT,
      requestedModelSelection: requested,
      canAdoptRequestedProvider: false,
    })).toBe(requested);
  });

  it.each([
    { ...CURRENT, profileId: DEFAULT_PROVIDER_PROFILE_ID },
    { ...CURRENT, instanceId: ProviderInstanceId.makeUnsafe("codex_other") },
  ] satisfies ModelSelection[])("preserves an established target when another identity is requested", (requested) => {
    expect(deriveTurnStartModelSelection({
      currentModelSelection: CURRENT,
      requestedModelSelection: requested,
      canAdoptRequestedProvider: false,
    })).toBe(CURRENT);
  });

  it("allows explicit first-turn adoption of a different complete target", () => {
    const requested: ModelSelection = {
      provider: "cursor",
      instanceId: ProviderInstanceId.makeUnsafe("cursor_work"),
      profileId: ProviderProfileId.makeUnsafe("personal"),
      model: "composer-2",
    };
    expect(deriveTurnStartModelSelection({
      currentModelSelection: CURRENT,
      requestedModelSelection: requested,
      canAdoptRequestedProvider: true,
    })).toBe(requested);
  });

  it("preserves the current selection when no replacement is requested", () => {
    expect(deriveTurnStartModelSelection({
      currentModelSelection: CURRENT,
      requestedModelSelection: undefined,
      canAdoptRequestedProvider: true,
    })).toBe(CURRENT);
  });
});
