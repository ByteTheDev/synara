import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ModelSelection } from "./orchestration";
import { DEFAULT_PROVIDER_PROFILE_ID } from "./providerProfile";

const PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
  "devin",
  "omp",
] as const;

const decode = Schema.decodeUnknownSync(ModelSelection);
const encode = Schema.encodeSync(ModelSelection);

describe("model selection profile serialization boundary", () => {
  it.each(PROVIDERS)("preserves a named profile and distinct instance through %s storage and wire encoding", (provider) => {
    const input = {
      provider,
      instanceId: provider + "_executable",
      profileId: "work",
      model: "account-scoped-model",
    };
    const decoded = decode(input);
    expect(decoded).toEqual(input);
    const encoded = encode(decoded);
    expect(encoded).toEqual(input);
    expect(decode(JSON.parse(JSON.stringify(encoded)))).toEqual(input);
  });

  it.each(PROVIDERS)("adds only the default profile to legacy %s selections", (provider) => {
    const input = { provider, instanceId: provider + "_legacy", model: "retained-model" };
    const decoded = decode(input);
    expect(decoded).toEqual({ ...input, profileId: DEFAULT_PROVIDER_PROFILE_ID });
    expect(encode(decoded)).toEqual({ ...input, profileId: DEFAULT_PROVIDER_PROFILE_ID });
  });

  it.each([null, "", "bad/profile", 42, { id: "work" }])(
    "rejects the explicit invalid profile %j instead of executing the default account",
    (profileId) => {
      for (const provider of PROVIDERS) {
        expect(() =>
          decode({
            provider,
            instanceId: provider + "_executable",
            profileId,
            model: "retained-model",
          }),
        ).toThrow();
      }
    },
  );

  it.each([
    ["gemini", "antigravity"],
    ["kilo", "opencode"],
  ] as const)("retains named profile and instance while migrating %s to %s", (legacy, current) => {
    const decoded = decode({
      provider: legacy,
      instanceId: legacy + "_saved",
      profileId: "unavailable-but-retained",
      model: "retained-model",
    });
    expect(decoded).toEqual({
      provider: current,
      instanceId: legacy + "_saved",
      profileId: "unavailable-but-retained",
      model: "retained-model",
    });
    expect(decode(encode(decoded))).toEqual(decoded);
  });
});
