import { Effect } from "effect";
import {
  buildTextDelta,
  buildTurnFinished,
  buildTurnStarted,
  type HarnessStreamEvent,
  makeInMemoryEventLogStore,
} from "@openagentsinc/agent-harness-contract";
import {
  buildHistoryCorpus,
  type HistoryCorpusEntry,
  type HistoryCorpusPolicy,
  HistoryRecallError,
  historyRecallDefaultCaps,
  type HistoryRecallCaps,
  type HistoryRecallQuestion,
  type HistoryRecallResponse,
} from "@openagentsinc/history-corpus";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

const SOURCE: KhalaRuntimeSource = { lane: "test_fixture" };
const BUILT_AT = "2026-07-21T12:00:00.000Z";
const THREAD_ID = "t1";
const TURN_COUNT = 120;
const PLANTED_TURN = 80;
const LONG_TURN = 100;
const PLANTED_TEXT = "DECISION: adopt the blue protocol";
const LONG_TEXT = `LONGSPAN ${"x".repeat(600)}`;

const ownerPolicy: HistoryCorpusPolicy = {
  includeVisibilities: ["public", "operator", "private"],
  includeRedactionClasses: ["public_ref", "redacted_summary", "operator_summary", "private_ref"],
};

const turnIdOf = (turn: number): string => `t1.turn-${String(turn).padStart(3, "0")}`;

const scriptTurn = (turn: number, words: ReadonlyArray<string>): Array<HarnessStreamEvent> => {
  const turnId = turnIdOf(turn);
  const events: Array<HarnessStreamEvent> = [];
  let seq = 0;
  events.push(buildTurnStarted({ turnId, threadId: THREAD_ID, sequence: seq++, source: SOURCE }));
  for (const word of words) {
    events.push(
      buildTextDelta({
        turnId,
        threadId: THREAD_ID,
        sequence: seq++,
        source: SOURCE,
        messageId: `msg.${turnId}`,
        text: word,
      }),
    );
  }
  events.push(
    buildTurnFinished({
      turnId,
      threadId: THREAD_ID,
      sequence: seq++,
      source: SOURCE,
      finishReason: "stop",
    }),
  );
  return events;
};

interface RecallFixture {
  readonly entries: ReadonlyArray<HistoryCorpusEntry>;
  readonly coverageNote: string;
}

/**
 * A deep, deterministic corpus: many turns on one thread, with a decision
 * planted hundreds of sequences in, and a 600-plus-character text that
 * overflows the default per-span character cap.
 */
const buildRecallFixture = async (): Promise<RecallFixture> => {
  const store = makeInMemoryEventLogStore();
  const turnIds: Array<string> = [];
  const events: Array<HarnessStreamEvent> = [];
  for (let turn = 0; turn < TURN_COUNT; turn++) {
    turnIds.push(turnIdOf(turn));
    if (turn === PLANTED_TURN) {
      events.push(...scriptTurn(turn, ["alpha", PLANTED_TEXT, "beta"]));
    } else if (turn === LONG_TURN) {
      events.push(...scriptTurn(turn, [LONG_TEXT]));
    } else {
      events.push(...scriptTurn(turn, ["alpha", "beta"]));
    }
  }
  await Effect.runPromise(Effect.forEach(events, (event) => store.append(event)));
  const corpus = await Effect.runPromise(
    buildHistoryCorpus({
      scope: { _tag: "Thread", threadId: THREAD_ID },
      eventLog: store,
      turnIds,
      policy: ownerPolicy,
      builtAt: BUILT_AT,
    }),
  );
  return { entries: corpus.entries, coverageNote: corpus.manifest.coverage.note };
};

let cachedFixture: Promise<RecallFixture> | undefined;
const recallFixture = (): Promise<RecallFixture> => (cachedFixture ??= buildRecallFixture());

/** The recall query surface under test — matches the Tier D input signature. */
export interface RecallSource {
  readonly recall: (params: {
    readonly entries: ReadonlyArray<HistoryCorpusEntry>;
    readonly coverageNote: string;
    readonly question: HistoryRecallQuestion;
    readonly caps?: HistoryRecallCaps | undefined;
  }) => Effect.Effect<HistoryRecallResponse, HistoryRecallError>;
}

/** Configuration for {@link runRecallLaws}. */
export interface RecallLawsConfig extends RecallSource {
  /** A short label naming the implementation under test, used in test titles. */
  readonly label: string;
}

/**
 * The recall honesty laws, parameterized over any recall source.
 *
 * Promoted, published form of `history-corpus/src/recall.test.ts`. Recall is a
 * deterministic query over a durable corpus; the laws hold the source to the
 * honesty contract: caps TRUNCATE (they never fail), and the response must
 * state exactly what it scanned, which caps it hit, and the corpus coverage
 * bound. A source that answers correctly but lies about coverage — or that
 * fabricates a model call behind a "deterministic" answer — is not conformant.
 *
 * - **Correctness anchor.** A decision planted deep is found with its exact
 *   cursor span and zero model calls.
 * - **Caps truncate and report.** `maxEntriesScanned`, `maxSpans`, and
 *   `maxCharsPerSpan` each truncate; `truncated` is true exactly when `capsHit`
 *   is non-empty, and `capsHit` names the cap.
 * - **`cost.modelCalls` is always 0** for every deterministic question kind.
 * - **Coverage note carry-through.** The corpus coverage bound rides on every
 *   response's `honesty.coverageNote`.
 * - **Invalid input fails typed.** An uncompilable grep pattern is a typed
 *   `invalid_pattern` error, never a crash.
 */
export const runRecallLaws = (config: RecallLawsConfig): void => {
  const { label, recall } = config;

  const ask = async (question: HistoryRecallQuestion, caps?: HistoryRecallCaps) => {
    const { entries, coverageNote } = await recallFixture();
    return Effect.runPromise(recall({ entries, coverageNote, question, caps }));
  };

  describe(`[${label}] recall — correctness and cost`, () => {
    test("finds a decision planted deep with its exact cursor span and zero model calls", async () => {
      const { entries } = await recallFixture();
      const response = await ask({ _tag: "Grep", pattern: "DECISION: adopt" });
      expect(response.answers.length).toBe(1);
      expect(response.answers[0]).toMatchObject({
        turnId: turnIdOf(PLANTED_TURN),
        sequenceStart: 2,
        sequenceEnd: 2,
        excerpt: PLANTED_TEXT,
      });
      expect(response.honesty.tier).toBe("deterministic");
      expect(response.honesty.entriesScanned).toBe(entries.length);
      expect(response.honesty.entriesTotal).toBe(entries.length);
      expect(response.honesty.truncated).toBe(false);
      expect(response.honesty.capsHit).toEqual([]);
      expect(response.cost.modelCalls).toBe(0);
    });

    test("every question kind answers with zero model calls", async () => {
      const questions: ReadonlyArray<HistoryRecallQuestion> = [
        { _tag: "Grep", pattern: "alpha" },
        { _tag: "CursorSlice", fromSequence: 0, toSequence: 1 },
        { _tag: "KeyTurns", limit: 2 },
        { _tag: "TurnSummary", turnId: turnIdOf(0) },
      ];
      for (const question of questions) {
        const response = await ask(question, { maxSpans: 3 });
        expect(response.cost.modelCalls).toBe(0);
        expect(response.honesty.tier).toBe("deterministic");
      }
    });
  });

  describe(`[${label}] recall — caps truncate and report honestly`, () => {
    test("maxEntriesScanned stops the scan and honesty names the cap, across cap values", async () => {
      const { entries } = await recallFixture();
      const total = entries.length;
      for (const cap of [1, 5, 137, total, total + 1000]) {
        const response = await ask(
          { _tag: "Grep", pattern: "zzz-no-such-text" },
          {
            maxEntriesScanned: cap,
          },
        );
        expect(response.honesty.entriesScanned).toBe(Math.min(cap, total));
        expect(response.honesty.entriesTotal).toBe(total);
        const expectTruncated = cap < total;
        expect(response.honesty.truncated).toBe(expectTruncated);
        expect(response.honesty.capsHit).toEqual(expectTruncated ? ["maxEntriesScanned"] : []);
      }
    });

    test("maxSpans caps the answers and honesty names the cap", async () => {
      // Every turn matches sequence 0, so there are TURN_COUNT candidate spans.
      const question: HistoryRecallQuestion = {
        _tag: "CursorSlice",
        fromSequence: 0,
        toSequence: 0,
      };
      const capped = await ask(question, { maxSpans: 7 });
      expect(capped.answers.length).toBe(7);
      expect(capped.honesty.truncated).toBe(true);
      expect(capped.honesty.capsHit).toEqual(["maxSpans"]);

      const defaulted = await ask(question);
      expect(defaulted.answers.length).toBe(historyRecallDefaultCaps.maxSpans);
      expect(defaulted.honesty.capsHit).toEqual(["maxSpans"]);
    });

    test("maxCharsPerSpan truncates the excerpt and honesty names the cap", async () => {
      const defaulted = await ask({ _tag: "Grep", pattern: "LONGSPAN" });
      expect(defaulted.answers.length).toBe(1);
      expect(defaulted.answers[0]!.excerpt.length).toBe(historyRecallDefaultCaps.maxCharsPerSpan);
      expect(defaulted.honesty.truncated).toBe(true);
      expect(defaulted.honesty.capsHit).toEqual(["maxCharsPerSpan"]);

      const tight = await ask({ _tag: "Grep", pattern: "LONGSPAN" }, { maxCharsPerSpan: 100 });
      expect(tight.answers[0]!.excerpt.length).toBe(100);
      expect(tight.honesty.capsHit).toEqual(["maxCharsPerSpan"]);
    });

    test("truncated is true exactly when capsHit is non-empty", async () => {
      const complete = await ask({ _tag: "Grep", pattern: "DECISION: adopt" });
      expect(complete.honesty.capsHit).toEqual([]);
      expect(complete.honesty.truncated).toBe(false);

      const truncated = await ask(
        { _tag: "CursorSlice", fromSequence: 0, toSequence: 0 },
        {
          maxSpans: 2,
        },
      );
      expect(truncated.honesty.capsHit.length).toBeGreaterThan(0);
      expect(truncated.honesty.truncated).toBe(true);
    });
  });

  describe(`[${label}] recall — coverage and typed failure`, () => {
    test("honesty carries the corpus coverage note through every response", async () => {
      const { coverageNote } = await recallFixture();
      const response = await ask({ _tag: "Grep", pattern: "alpha" }, { maxSpans: 1 });
      expect(response.honesty.coverageNote).toBe(coverageNote);
    });

    test("an invalid grep pattern is a typed invalid_pattern error, never a crash", async () => {
      const { entries, coverageNote } = await recallFixture();
      const error = await Effect.runPromise(
        recall({
          entries,
          coverageNote,
          question: { _tag: "Grep", pattern: "(unclosed" },
        }).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(HistoryRecallError);
      expect(error.reason).toBe("invalid_pattern");
    });
  });
};
