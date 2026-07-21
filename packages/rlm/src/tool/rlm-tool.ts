/**
 * Effect Tool-shaped bridge for RLM (SDK-RLM-06).
 * Lightweight authoring surface without depending on harness packages.
 */
import { Effect, Schema as S } from "effect";
import type { RlmShape } from "../engine/rlm.ts";
import type { RlmRequest, RlmTerminalResult } from "../schemas/request-result.ts";
import { RlmError } from "../schemas/errors.ts";
import { defaultRlmBudget, defaultRlmEvidencePolicy } from "../schemas/budget.ts";
import { defaultRlmDeterministicLimits } from "../schemas/request-result.ts";
// re-export path ok
import type { RlmCorpusInput } from "../schemas/corpus.ts";

export const RlmToolParams = S.Struct({
  mode: S.Literals(["deterministic", "semantic"]),
  runRef: S.String,
  question: S.optionalKey(S.String),
  /** Pre-authorized corpus input supplied by the host — never model-trusted source alone. */
  corpus: S.Unknown,
  pattern: S.optionalKey(S.String),
});
export type RlmToolParams = typeof RlmToolParams.Type;

export const makeRlmToolHandler = (rlm: RlmShape) => {
  const handle = (raw: unknown): Effect.Effect<RlmTerminalResult, RlmError> =>
    Effect.gen(function* () {
      const params = yield* S.decodeUnknownEffect(RlmToolParams)(raw).pipe(
        Effect.mapError(
          () =>
            new RlmError({
              reason: "invalid_request",
              retryable: false,
              detailSafe: "invalid Rlm tool parameters",
            }),
        ),
      );
      const corpus = params.corpus as RlmCorpusInput;
      if (params.mode === "deterministic") {
        const request: RlmRequest = {
          _tag: "Deterministic",
          schemaId: "openagents.ai.rlm_request.v1",
          runRef: params.runRef,
          corpus,
          operation: {
            _tag: "Grep",
            pattern: params.pattern ?? params.question ?? ".*",
          },
          limits: defaultRlmDeterministicLimits,
        };
        return yield* rlm.run(request);
      }
      const request: RlmRequest = {
        _tag: "Semantic",
        schemaId: "openagents.ai.rlm_request.v1",
        runRef: params.runRef,
        corpus,
        question: params.question ?? "",
        budget: defaultRlmBudget,
        evidence: defaultRlmEvidencePolicy,
      };
      return yield* rlm.run(request);
    });

  return {
    name: "rlm" as const,
    description:
      "Run a bounded Recursive Language Model query over an authorized corpus. Deterministic mode makes zero model calls.",
    parameters: RlmToolParams,
    handle,
  };
};
