import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import {
  buildTextDelta,
  buildTurnFinished,
  buildTurnStarted,
  type HarnessEventLogStore,
  makeHarnessEventLog,
} from "@openagentsinc/agent-harness-contract";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import { scriptTurn, sequencesOf, TEST_SOURCE } from "./fixtures.ts";

/**
 * Configuration for {@link runEventLogLaws}. The implementation under test is a
 * factory that produces a fresh {@link HarnessEventLogStore} — the persistence
 * port a real backend (the desktop local-turn journal, the managed-sandbox
 * event store, or a third party's store) implements. The kit builds the
 * {@link makeHarnessEventLog} runtime over the store, so a store that satisfies
 * the port passes both the store-level and the live-attach laws.
 */
export interface EventLogLawsConfig {
  /** A short label naming the implementation under test, used in test titles. */
  readonly label: string;
  /** Produce a fresh, empty store. Called once per law so laws never share state. */
  readonly makeStore: () => Effect.Effect<HarnessEventLogStore>;
  /** The event source label. Defaults to the shared `test_fixture` source. */
  readonly source?: KhalaRuntimeSource;
}

/**
 * The durable event-log laws, parameterized over any store.
 *
 * Promoted, published form of `agent-harness-contract/src/event-log.test.ts`:
 *
 * - **Append monotonicity / dup-free.** A non-increasing sequence for a turn
 *   (duplicate or out-of-order) is rejected with a typed error — this is what
 *   makes replay duplicate-free.
 * - **Gap-free, dup-free replay from a cursor.** `read` / `replay` return
 *   exactly the events after the cursor, ascending, no gap and no duplicate.
 * - **Durable replay after process death.** A fresh log runtime over the SAME
 *   store replays everything a dead producer persisted.
 * - **Rerun boundaries are recorded and reported** so a recomputed tail is
 *   distinguishable from an exact attach.
 * - **Live attach** replays the persisted tail then follows new events with no
 *   gap or duplicate at the seam.
 * - **Single-flight attach.** A newer attach for the same `(turn, class)`
 *   supersedes the older so a reconnecting consumer never double-runs.
 */
export const runEventLogLaws = (config: EventLogLawsConfig): void => {
  const { label, makeStore } = config;
  const source = config.source ?? TEST_SOURCE;

  const turn = (turnId: string, words: ReadonlyArray<string>, startSeq = 0) =>
    scriptTurn({ turnId, threadId: "s1", words, startSeq, source });

  describe(`[${label}] event log — durable replay`, () => {
    test("rejects a duplicate or out-of-order sequence for a turn", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const store = yield* makeStore();
          const [first] = turn("t1", []); // just turn.started at seq 0
          yield* store.append(first!);
          // Re-append the same sequence 0 — must be rejected.
          yield* store.append(first!);
        }),
      );
      expect(exit._tag).toBe("Failure");
    });

    test("read returns exactly the tail after a cursor, ascending, gap-free and dup-free", async () => {
      const tail = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeStore();
          yield* Effect.forEach(turn("t1", ["a", "b", "c"]), (event) => store.append(event));
          return yield* store.read({ turnId: "t1", fromCursor: 1 });
        }),
      );
      expect(sequencesOf(tail)).toEqual([2, 3, 4]);
      expect(new Set(sequencesOf(tail)).size).toBe(tail.length);
    });

    test("lastCursor is -1 when empty and the greatest stored sequence otherwise", async () => {
      const cursors = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeStore();
          const empty = yield* store.lastCursor({ turnId: "t1" });
          yield* Effect.forEach(turn("t1", ["a", "b"]), (event) => store.append(event));
          const filled = yield* store.lastCursor({ turnId: "t1" });
          return { empty, filled };
        }),
      );
      expect(cursors.empty).toBe(-1);
      expect(cursors.filled).toBe(3);
    });

    test("replays the tail from a cursor after process death (fresh runtime, same store)", async () => {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeStore();
          const script = turn("t1", ["a", "b", "c"]); // sequences 0..4

          // Producer runtime appends the whole turn, then "dies".
          const producer = yield* makeHarnessEventLog(store);
          yield* Effect.forEach(script, (event) => producer.appendEvent(event));

          // A different runtime rehydrates over the SAME store and replays from 1.
          const recovered = yield* makeHarnessEventLog(store);
          const tail = yield* Stream.runCollect(recovered.replay({ turnId: "t1", fromCursor: 1 }));
          const last = yield* recovered.lastCursor({ turnId: "t1" });
          const all = yield* Stream.runCollect(recovered.replay({ turnId: "t1", fromCursor: -1 }));
          return { tail, last, all };
        }),
      );
      expect(sequencesOf(outcome.tail)).toEqual([2, 3, 4]);
      expect(new Set(sequencesOf(outcome.tail)).size).toBe(outcome.tail.length);
      expect(outcome.last).toBe(4);
      // A full replay from -1 returns the entire turn exactly once.
      expect(sequencesOf(outcome.all)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe(`[${label}] event log — rerun boundary visibility`, () => {
    test("records and reports a rerun boundary so a recomputed tail is distinguishable", async () => {
      const boundaries = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeStore();
          const log = yield* makeHarnessEventLog(store);
          yield* Effect.forEach(turn("t1", ["a"]), (event) => log.appendEvent(event));
          yield* log.markRerunBoundary({ turnId: "t1", atCursor: 1 });
          return yield* log.rerunBoundaries({ turnId: "t1" });
        }),
      );
      expect(boundaries).toEqual([1]);
    });
  });

  describe(`[${label}] event log — live attach`, () => {
    test("attach replays the persisted tail then follows new events with no gap or duplicate", async () => {
      const collected = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeStore();
          const log = yield* makeHarnessEventLog(store);

          // Persist the first two events (seq 0, 1).
          yield* log.appendEvent(
            buildTurnStarted({ turnId: "t1", threadId: "s1", sequence: 0, source }),
          );
          yield* log.appendEvent(
            buildTextDelta({
              turnId: "t1",
              threadId: "s1",
              sequence: 1,
              source,
              messageId: "m",
              text: "a",
            }),
          );

          // Attach from cursor 0 (want seq 1 onward): replay 1, then live 2..3.
          const sink = yield* Ref.make<ReadonlyArray<number>>([]);
          const wantCount = 3; // seq 1, 2, 3
          const done = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            log.attach({ turnId: "t1", fromCursor: 0, consumerClass: "renderer" }).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  const next = yield* Ref.updateAndGet(sink, (xs) => [...xs, event.sequence]);
                  if (next.length >= wantCount) {
                    yield* Deferred.succeed(done, undefined);
                  }
                }),
              ),
            ),
          );

          // Append two more live events after the attach is running.
          yield* log.appendEvent(
            buildTextDelta({
              turnId: "t1",
              threadId: "s1",
              sequence: 2,
              source,
              messageId: "m",
              text: "b",
            }),
          );
          yield* log.appendEvent(
            buildTurnFinished({
              turnId: "t1",
              threadId: "s1",
              sequence: 3,
              source,
              finishReason: "stop",
            }),
          );

          yield* Deferred.await(done);
          yield* Fiber.interrupt(fiber);
          return yield* Ref.get(sink);
        }),
      );

      expect(collected).toEqual([1, 2, 3]);
      expect(new Set(collected).size).toBe(collected.length);
    });

    test("single-flight: a newer attach for the same (turn, class) supersedes the older", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeStore();
          const log = yield* makeHarnessEventLog(store);
          yield* log.appendEvent(
            buildTurnStarted({ turnId: "t1", threadId: "s1", sequence: 0, source }),
          );

          const sinkA = yield* Ref.make<ReadonlyArray<number>>([]);
          const sinkB = yield* Ref.make<ReadonlyArray<number>>([]);
          const bGot = yield* Deferred.make<void>();
          const aReplayed = yield* Deferred.make<void>();

          // Attach A replays seq 0 then follows. Receiving seq 0 proves A is the
          // active subscriber — deterministic, no sleep needed.
          const fiberA = yield* Effect.forkChild(
            log.attach({ turnId: "t1", fromCursor: -1, consumerClass: "renderer" }).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  yield* Ref.update(sinkA, (xs) => [...xs, event.sequence]);
                  yield* Deferred.succeed(aReplayed, undefined);
                }),
              ),
            ),
          );
          yield* Deferred.await(aReplayed);

          // Attach B for the SAME (turn, class) — supersedes A.
          const fiberB = yield* Effect.forkChild(
            log.attach({ turnId: "t1", fromCursor: 0, consumerClass: "renderer" }).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  yield* Ref.update(sinkB, (xs) => [...xs, event.sequence]);
                  yield* Deferred.succeed(bGot, undefined);
                }),
              ),
            ),
          );

          // A should be interrupted by the supersede; await its fiber.
          yield* Fiber.await(fiberA);

          // Publish a new event; only B (the live subscriber) should receive it.
          yield* log.appendEvent(
            buildTextDelta({
              turnId: "t1",
              threadId: "s1",
              sequence: 1,
              source,
              messageId: "m",
              text: "b",
            }),
          );
          yield* Deferred.await(bGot);
          yield* Fiber.interrupt(fiberB);

          return { a: yield* Ref.get(sinkA), b: yield* Ref.get(sinkB) };
        }),
      );

      expect(result.a).toEqual([0]);
      expect(result.b).toContain(1);
    });
  });
};
