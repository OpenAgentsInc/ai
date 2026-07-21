import { Effect, type Layer } from "effect";
import {
  buildInlineCorpusInput,
  type MakeRlmOptions,
  RLM_REQUEST_SCHEMA_ID,
  RlmCorpusSource,
  type RlmDeterministicRequest,
  type RlmShape,
  type RlmTerminalResult,
} from "@openagentsinc/rlm";
import { describe, expect, test } from "vite-plus/test";

/** A small inline corpus: four public entries that all contain the word "fact". */
const corpus = buildInlineCorpusInput({
  corpusRef: "corpus.conformance",
  scopeRef: "scope.conformance",
  entries: [
    {
      scopeRef: "scope.conformance",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a0" },
      text: "alpha fact one",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.conformance",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a1" },
      text: "beta fact two",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.conformance",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a2" },
      text: "gamma fact three",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.conformance",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a3" },
      text: "delta fact four",
      visibility: "public",
      redactionClass: "none",
    },
  ],
});

const GENEROUS = {
  maxEntriesScanned: 10_000,
  maxSpans: 64,
  maxCharsPerSpan: 2_048,
  maxObservationChars: 8_192,
} as const;

const deterministicRequest = (params: {
  readonly runRef: string;
  readonly limits: RlmDeterministicRequest["limits"];
}): RlmDeterministicRequest => ({
  _tag: "Deterministic",
  schemaId: RLM_REQUEST_SCHEMA_ID,
  runRef: params.runRef,
  corpus,
  operation: { _tag: "Grep", pattern: "fact" },
  limits: params.limits,
});

/**
 * Configuration for {@link runRlmCapLaws}. The implementation under test is the
 * recursive-language-model engine, supplied as its factory plus the corpus
 * source layer it runs against. The kit drives deterministic runs whose caps
 * bite, and asserts every cap surfaces as an honest `Partial` — never a
 * `Completed` result that quietly dropped work.
 */
export interface RlmCapLawsConfig {
  /** A short label naming the implementation under test, used in test titles. */
  readonly label: string;
  /** Build the engine shape (reference: `makeRlm`). */
  readonly makeEngine: (options: MakeRlmOptions) => Effect.Effect<RlmShape, never, RlmCorpusSource>;
  /** The corpus source layer the engine resolves against (reference: `rlmInlineCorpusSourceLayer`). */
  readonly corpusSourceLayer: Layer.Layer<RlmCorpusSource>;
}

/**
 * The RLM cap laws, parameterized over any engine + corpus source.
 *
 * Promoted from `rlm/src/conformance/paper-fidelity.test.ts` and the honesty
 * contract in `rlm/src/schemas/request-result.ts`. The single invariant these
 * laws defend is **no laundering**: every budget/cap that bites must surface as
 * an honest `Partial` whose `honesty.capsHit` names the cap — the engine must
 * never present a truncated run as a `Completed` result.
 *
 * - **Every deterministic cap → honest Partial.** A tight `maxSpans` or
 *   `maxEntriesScanned` yields `Partial(cap_truncated)` with the cap in
 *   `capsHit` and a `bestOutput` (the partial findings are surfaced, not
 *   silently dropped).
 * - **Generous caps → Completed with empty `capsHit`.**
 * - **No laundering.** Across a matrix of limits, a non-empty `capsHit` is
 *   never a `Completed` result, and a `Completed` result always has empty
 *   `capsHit`.
 * - **Deterministic never touches a model.** A deterministic run reports
 *   `usage.modelCalls === 0` and never invokes the supplied model plan.
 */
export const runRlmCapLaws = (config: RlmCapLawsConfig): void => {
  const { label, makeEngine, corpusSourceLayer } = config;

  const run = (
    request: RlmDeterministicRequest,
    options: MakeRlmOptions = {},
  ): Promise<RlmTerminalResult> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeEngine(options);
        return yield* shape.run(request);
      }).pipe(Effect.provide(corpusSourceLayer)),
    );

  describe(`[${label}] rlm — every cap yields an honest Partial`, () => {
    test("maxSpans truncation is Partial(cap_truncated) naming the cap with a bestOutput", async () => {
      const result = await run(
        deterministicRequest({ runRef: "run.cap.spans", limits: { ...GENEROUS, maxSpans: 2 } }),
      );
      expect(result._tag).toBe("Partial");
      if (result._tag === "Partial") {
        expect(result.reason).toBe("cap_truncated");
        expect(result.honesty.capsHit).toContain("maxSpans");
        expect(result.bestOutput).toBeDefined();
      }
    });

    test("maxEntriesScanned truncation is Partial(cap_truncated) naming the cap", async () => {
      const result = await run(
        deterministicRequest({
          runRef: "run.cap.scanned",
          limits: { ...GENEROUS, maxEntriesScanned: 2 },
        }),
      );
      expect(result._tag).toBe("Partial");
      if (result._tag === "Partial") {
        expect(result.reason).toBe("cap_truncated");
        expect(result.honesty.capsHit).toContain("maxEntriesScanned");
      }
    });

    test("generous caps complete with an empty capsHit", async () => {
      const result = await run(
        deterministicRequest({ runRef: "run.complete", limits: { ...GENEROUS } }),
      );
      expect(result._tag).toBe("Completed");
      if (result._tag === "Completed") {
        expect(result.honesty.capsHit).toEqual([]);
      }
    });
  });

  describe(`[${label}] rlm — no laundering`, () => {
    test("across a matrix of limits, capsHit is non-empty iff the result is Partial", async () => {
      const cases: ReadonlyArray<{
        readonly runRef: string;
        readonly limits: RlmDeterministicRequest["limits"];
      }> = [
        { runRef: "m.0", limits: { ...GENEROUS } },
        { runRef: "m.1", limits: { ...GENEROUS, maxSpans: 1 } },
        { runRef: "m.2", limits: { ...GENEROUS, maxSpans: 3 } },
        { runRef: "m.3", limits: { ...GENEROUS, maxEntriesScanned: 1 } },
        { runRef: "m.4", limits: { ...GENEROUS, maxEntriesScanned: 3 } },
      ];
      for (const c of cases) {
        const result = await run(deterministicRequest(c));
        const capped = result.honesty.capsHit.length > 0;
        if (capped) {
          // A truncated run is never presented as Completed.
          expect(result._tag).toBe("Partial");
        } else {
          expect(result._tag).toBe("Completed");
        }
      }
    });
  });

  describe(`[${label}] rlm — deterministic never touches a model`, () => {
    test("a deterministic run reports zero model calls and never invokes the model plan", async () => {
      let modelTouched = false;
      const result = await run(
        deterministicRequest({ runRef: "run.no-model", limits: { ...GENEROUS } }),
        {
          admitSemantic: true,
          model: {
            completeRoot: () =>
              Effect.sync(() => {
                modelTouched = true;
                return { text: "{}" };
              }),
          },
        },
      );
      expect(modelTouched).toBe(false);
      if (result._tag === "Completed" || result._tag === "Partial") {
        expect(result.usage.modelCalls).toBe(0);
      }
    });
  });
};
