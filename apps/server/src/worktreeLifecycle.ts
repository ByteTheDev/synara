import * as path from "node:path";
import { Effect, Semaphore } from "effect";

// Git's mutation lock cannot exclude an owner restore or terminal launch. All
// server services for one data home share this short lifecycle critical section.
const gates = new Map<string, Semaphore.Semaphore>();

export function withWorktreeLifecycle<A, E, R>(
  homeDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const key = path.resolve(homeDir);
    let gate = gates.get(key);
    if (!gate) {
      gate = Semaphore.makeUnsafe(1);
      gates.set(key, gate);
    }
    return gate.withPermits(1)(effect);
  });
}
