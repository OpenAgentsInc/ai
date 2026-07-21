import { Effect, Stream } from "effect";
import {
  type AgentHarness,
  HarnessCapabilityUnsupported,
  type HarnessSession,
} from "@openagentsinc/agent-harness-contract";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import { attempt, collect, sequencesOf, TEST_SOURCE } from "./fixtures.ts";

/**
 * Configuration for {@link runAdapterLaws}. The implementation under test is a
 * factory that produces a fresh {@link AgentHarness}; the kit starts the
 * sessions and drives the turns itself, so the laws are content-agnostic and
 * hold for any conforming adapter (the in-repo reference adapter, Codex,
 * Claude Code, an ACP peer, a third-party runtime).
 */
export interface AdapterLawsConfig {
  /** A short label naming the implementation under test, used in test titles. */
  readonly label: string;
  /** Produce a fresh harness. Called once per law so laws never share state. */
  readonly makeHarness: () => Effect.Effect<AgentHarness>;
  /** The prompt driven through each turn. Defaults to a neutral fixture prompt. */
  readonly prompt?: string;
  /** The event source label. Defaults to the shared `test_fixture` source. */
  readonly source?: KhalaRuntimeSource;
  /**
   * How many events to pull before the suspend/continue law suspends the turn.
   * Defaults to 2, enough to prove a mid-turn cursor is exact.
   */
  readonly prefixTake?: number;
}

/**
 * The reference-adapter session-verb laws, parameterized over any adapter.
 *
 * These are the promoted, published form of
 * `agent-harness-contract/src/reference-adapter.test.ts`. A third-party adapter
 * either passes these or it is not conformant:
 *
 * 1. **Turn framing.** A full turn streams `turn.started` first and
 *    `turn.finished` last, with session-global sequences contiguous from 0 and
 *    no duplicate; the turn result's `lastCursor` is exactly the last event's
 *    sequence.
 * 2. **Capability refusal is fail-closed and named.** An optional verb an
 *    adapter cannot satisfy fails with a typed
 *    {@link HarnessCapabilityUnsupported} naming the exact missing capability —
 *    never a silent success and never an untyped defect.
 * 3. **Suspend/continue cursor exactness.** When an adapter supports
 *    suspend+continue losslessly, the continuation cursor is exactly the last
 *    event delivered before the suspend, and the continued slice attaches at
 *    `cursor + 1` with no gap and no duplicate. When the adapter reports the
 *    continuation as lossy, the degradation is honestly flagged rather than
 *    presented as an exact attach.
 */
export const runAdapterLaws = (config: AdapterLawsConfig): void => {
  const { label, makeHarness } = config;
  const prompt = config.prompt ?? "hello";
  const source = config.source ?? TEST_SOURCE;
  const prefixTake = config.prefixTake ?? 2;

  describe(`[${label}] adapter — turn framing`, () => {
    test("a full turn streams turn.started -> ... -> turn.finished with contiguous sequences from 0", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const session = yield* harness.start({ sessionId: "s1", source });
          const control = yield* session.promptTurn({ turnId: "t1", prompt });
          const events = yield* collect(control.events);
          const done = yield* control.done;
          return { events, done };
        }),
      );

      const { events, done } = result;
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]?.kind).toBe("turn.started");
      expect(events.at(-1)?.kind).toBe("turn.finished");

      const seqs = sequencesOf(events);
      // Session-global sequences: fresh session starts at 0 so a replay from
      // cursor -1 recovers the whole turn.
      expect(seqs[0]).toBe(0);
      expect(seqs).toEqual(seqs.map((_, index) => index));
      expect(new Set(seqs).size).toBe(seqs.length);

      expect(done.lastCursor).toBe(events.at(-1)?.sequence);
      expect(typeof done.finishReason).toBe("string");
      expect(done.finishReason.length).toBeGreaterThan(0);
    });
  });

  describe(`[${label}] adapter — capability refusal is fail-closed`, () => {
    // The verbs whose refusal must be a named, typed capability error. Each
    // returns a value on support, or fails with CapabilityUnsupported.
    const verbs: ReadonlyArray<{
      readonly capability: "compact" | "detach" | "suspend_turn";
      readonly attemptVerb: (session: HarnessSession) => Effect.Effect<unknown, unknown>;
    }> = [
      { capability: "compact", attemptVerb: (session) => session.compact() },
      { capability: "detach", attemptVerb: (session) => session.detach() },
      { capability: "suspend_turn", attemptVerb: (session) => session.suspendTurn() },
    ];

    const startSession = (harness: AgentHarness) => harness.start({ sessionId: "s1", source });

    for (const verb of verbs) {
      test(`${verb.capability}: either succeeds or fails with a named CapabilityUnsupported error`, async () => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const harness = yield* makeHarness();
            const session = yield* startSession(harness);
            return yield* attempt(verb.attemptVerb(session));
          }),
        );

        if (outcome._tag === "failed") {
          expect(outcome.error).toBeInstanceOf(HarnessCapabilityUnsupported);
          expect((outcome.error as HarnessCapabilityUnsupported).capability).toBe(verb.capability);
        }
        // An `ok` outcome is a conformant adapter that supports the verb.
      });
    }
  });

  describe(`[${label}] adapter — suspend/continue cursor exactness`, () => {
    test("continuation cursor is exact and a lossless continue attaches at cursor + 1", async () => {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const session = yield* harness.start({ sessionId: "s1", source });
          const control = yield* session.promptTurn({ turnId: "t1", prompt });

          // Pull a prefix, then attempt to suspend.
          const phase1 = yield* collect(control.events.pipe(Stream.take(prefixTake)));
          const suspend = yield* attempt(session.suspendTurn());
          if (suspend._tag === "failed") {
            return { supported: false as const, error: suspend.error };
          }
          const continuation = suspend.value;

          // A FRESH session (different process) resumes from the cursor.
          const session2 = yield* harness.start({
            sessionId: "s1",
            source,
            continueFrom: continuation,
          });
          const continued = yield* attempt(session2.continueTurn({}));
          if (continued._tag === "failed") {
            return { supported: false as const, error: continued.error, continuation };
          }
          const phase2 = yield* collect(continued.value.events);
          return { supported: true as const, phase1, continuation, phase2 };
        }),
      );

      if (outcome.supported === false) {
        // A refusal must be the named, typed capability error — never a defect.
        expect(outcome.error).toBeInstanceOf(HarnessCapabilityUnsupported);
        const capability = (outcome.error as HarnessCapabilityUnsupported).capability;
        expect(["suspend_turn", "continue_turn"]).toContain(capability);
        return;
      }

      const { phase1, continuation, phase2 } = outcome;
      // The cursor is exactly the last event delivered in phase 1.
      expect(continuation.cursor).toBe(phase1.at(-1)?.sequence);
      expect(typeof continuation.lossy).toBe("boolean");

      if (continuation.lossy === false) {
        // No gap, no duplicate at the seam.
        expect(phase2[0]?.sequence).toBe(continuation.cursor + 1);
        const merged = sequencesOf([...phase1, ...phase2]);
        expect(merged).toEqual(merged.map((_, index) => index));
        expect(new Set(merged).size).toBe(merged.length);
      } else {
        // Honest degradation: a lossy continue re-drives the tail. The adapter
        // must flag it rather than present a recomputed tail as an exact attach.
        expect(continuation.lossy).toBe(true);
      }
    });
  });
};
