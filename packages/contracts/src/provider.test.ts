import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ProviderEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts explicit per-thread computer control provisioning", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-computer",
      provider: "codex",
      enableComputerControl: true,
      runtimeMode: "full-access",
    });
    expect(parsed.enableComputerControl).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("carries explicit profile identity through start and session payloads", () => {
    const start = decodeProviderSessionStartInput({
      threadId: "thread-profile",
      provider: "codex",
      profileId: "work",
      runtimeMode: "full-access",
    });
    const session = Schema.decodeUnknownSync(ProviderSession)({
      provider: "codex",
      profileId: "work",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-profile",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });

    expect(start.profileId).toBe("work");
    expect(session.profileId).toBe("work");
  });

  it("keeps profile identity observable on native provider events", () => {
    const event = Schema.decodeUnknownSync(ProviderEvent)({
      id: "event-profile",
      kind: "session",
      provider: "codex",
      profileId: "work",
      threadId: "thread-profile",
      createdAt: "2026-08-10T00:00:00.000Z",
      method: "session.started",
    });

    expect(event.profileId).toBe("work");
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "ultrathink",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.effort).toBe("ultrathink");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });
});
