import { Effect, Stream } from "effect";
import {
  buildTextDelta,
  buildTurnFinished,
  buildTurnStarted,
  type HarnessStreamEvent,
} from "@openagentsinc/agent-harness-contract";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";

/**
 * Shared, deterministic fixtures for the conformance kit's law suites. Every
 * builder here is pure and clock-free: identical inputs give identical events,
 * so a law suite is reproducible against any implementation under test.
 */

/** The canonical source label the kit stamps on every fixture event. */
export const TEST_SOURCE: KhalaRuntimeSource = { lane: "test_fixture" };

/** The `sequence` list of a run of events — the shape most laws assert over. */
export const sequencesOf = (events: ReadonlyArray<HarnessStreamEvent>): ReadonlyArray<number> =>
  events.map((event) => event.sequence);

/**
 * A full scripted turn: `turn.started`, one `text.delta` per word, then
 * `turn.finished`. Sequences are contiguous from `startSeq`. This is the same
 * scripted turn shape the in-repo reference suites use, hoisted so a consumer
 * building its own store/log fixtures reuses the exact event vocabulary.
 */
export const scriptTurn = (params: {
  readonly turnId: string;
  readonly threadId: string;
  readonly words: ReadonlyArray<string>;
  readonly startSeq?: number;
  readonly source?: KhalaRuntimeSource;
}): ReadonlyArray<HarnessStreamEvent> => {
  const source = params.source ?? TEST_SOURCE;
  const events: Array<HarnessStreamEvent> = [];
  let seq = params.startSeq ?? 0;
  events.push(
    buildTurnStarted({ turnId: params.turnId, threadId: params.threadId, sequence: seq++, source }),
  );
  for (const word of params.words) {
    events.push(
      buildTextDelta({
        turnId: params.turnId,
        threadId: params.threadId,
        sequence: seq++,
        source,
        messageId: `msg.${params.turnId}`,
        text: word,
      }),
    );
  }
  events.push(
    buildTurnFinished({
      turnId: params.turnId,
      threadId: params.threadId,
      sequence: seq++,
      source,
      finishReason: "stop",
    }),
  );
  return events;
};

/** Collect a finite harness stream into an array. */
export const collect = <E>(
  stream: Stream.Stream<HarnessStreamEvent, E>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, E> => Stream.runCollect(stream);

/**
 * Run an effect and report whether it succeeded or failed, without letting the
 * typed failure escape. Law suites use this to probe optional behavior: a
 * refused capability must fail with a specific typed error, and the suite must
 * be able to observe that failure and assert on it rather than aborting.
 */
export type Attempt<A, E> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "failed"; readonly error: E };

export const attempt = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Attempt<A, E>> =>
  effect.pipe(
    Effect.map((value): Attempt<A, E> => ({ _tag: "ok", value })),
    Effect.catch((error: E) => Effect.succeed<Attempt<A, E>>({ _tag: "failed", error })),
  );

/**
 * Assert a run of events is a contiguous, gap-free, duplicate-free ascending
 * sequence. Returns the sequence list so a caller can chain further checks.
 */
export const assertContiguous = (
  events: ReadonlyArray<HarnessStreamEvent>,
  params: { readonly from: number },
): ReadonlyArray<number> => {
  const seqs = sequencesOf(events);
  const expected = seqs.map((_, index) => params.from + index);
  if (JSON.stringify(seqs) !== JSON.stringify(expected)) {
    throw new Error(
      `expected contiguous sequences from ${params.from}: got ${JSON.stringify(seqs)}`,
    );
  }
  if (new Set(seqs).size !== seqs.length) {
    throw new Error(`expected no duplicate sequences: got ${JSON.stringify(seqs)}`);
  }
  return seqs;
};
