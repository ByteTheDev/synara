import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createApnsSender } from "./apns";

const wire = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:http2", () => ({ connect: wire.connect }));
describe("APNs HTTP/2 boundary", () => {
  it.each([
    [200, "", "delivered", "sandbox"],
    [200, "", "delivered", "production"],
    [410, "Unregistered", "invalid-token", "sandbox"],
    [400, "BadDeviceToken", "invalid-token", "production"],
    [429, "TooManyRequests", "retry", "sandbox"],
    [403, "InvalidProviderToken", "rejected", "production"],
  ] as const)(
    "classifies %s without exposing tokens or response data",
    async (status, reason, expected, environment) => {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      let headers: Record<string, string> = {};
      let payload = "";
      wire.connect.mockImplementation((origin: string) => {
        expect(origin).toBe(
          environment === "sandbox"
            ? "https://api.sandbox.push.apple.com"
            : "https://api.push.apple.com",
        );
        const session = new EventEmitter() as EventEmitter & {
          request: (value: Record<string, string>) => unknown;
          destroy: () => void;
        };
        session.destroy = vi.fn();
        session.request = (value) => {
          headers = value;
          const stream = new EventEmitter() as EventEmitter & { end: (value: string) => void };
          stream.end = (value) => {
            payload = value;
            queueMicrotask(() => {
              stream.emit("response", { ":status": status });
              stream.emit("data", Buffer.from(JSON.stringify({ reason })));
              stream.emit("end");
            });
          };
          return stream;
        };
        queueMicrotask(() => session.emit("connect"));
        return session;
      });
      const send = createApnsSender({
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        keyId: "ABCD123456",
        teamId: "TEAM123456",
        bundleId: "com.example.synara",
        environment: "both",
      });
      expect(
        await send({
          environment,
          token: "a".repeat(64),
          activityId: "example-activity",
          timestamp: 1790000000,
          event: "end",
          contentState: { updatedAt: 811692800 },
        }),
      ).toBe(expected);
      expect(headers["apns-topic"]).toBe("com.example.synara.push-type.liveactivity");
      expect(headers["apns-push-type"]).toBe("liveactivity");
      const verified = await jwtVerify(
        headers.authorization!.slice(7),
        await importSPKI(publicKey.export({ type: "spki", format: "pem" }).toString(), "ES256"),
        { issuer: "TEAM123456", algorithms: ["ES256"] },
      );
      expect(verified.protectedHeader.kid).toBe("ABCD123456");
      expect(JSON.parse(payload)).toMatchObject({
        aps: {
          event: "end",
          timestamp: 1790000000,
          "content-state": { updatedAt: 811692800 },
          "dismissal-date": expect.any(Number),
        },
      });
    },
  );
});
