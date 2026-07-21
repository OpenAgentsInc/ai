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

/**
 * Operation class the host authorizes. Deterministic Tier-D runs are read-only
 * recall (zero model calls) and may be pre-authorized. Semantic runs are
 * effectful (they drive language-model calls and their side effects) and may
 * NOT self-authorize — the host must admit each one.
 */
export type RlmToolOperationClass = "read_only_recall" | "effectful";

export interface RlmToolAuthorizationRequest {
  readonly runRef: string;
  readonly mode: "deterministic" | "semantic";
  readonly operationClass: RlmToolOperationClass;
}

export interface RlmToolAuthorizationDecision {
  readonly granted: boolean;
  readonly detailSafe?: string;
}

/**
 * Injected authority seam. The engine proposes an operation; the host
 * authorizes it. This keeps leases/caps/approvals OUTSIDE the engine, per the
 * SDK's standing no-authority boundary.
 */
export interface RlmToolAuthorizer {
  readonly authorize: (
    request: RlmToolAuthorizationRequest,
  ) => Effect.Effect<RlmToolAuthorizationDecision, RlmError>;
}

/**
 * Default deny-by-default authorizer: read-only recall is pre-authorized;
 * effectful (semantic) operations are refused unless the host injects an
 * authorizer that grants them.
 */
export const denyEffectfulRlmToolAuthorizer: RlmToolAuthorizer = {
  authorize: (request) =>
    Effect.succeed(
      request.operationClass === "read_only_recall"
        ? { granted: true }
        : {
            granted: false,
            detailSafe: "effectful RLM tool operation requires explicit host authorization",
          },
    ),
};

export interface MakeRlmToolHandlerOptions {
  /**
   * Host authority seam. When omitted, effectful (semantic) operations are
   * denied by default and only read-only recall runs.
   */
  readonly authorizer?: RlmToolAuthorizer;
}

export const makeRlmToolHandler = (rlm: RlmShape, options: MakeRlmToolHandlerOptions = {}) => {
  const authorizer = options.authorizer ?? denyEffectfulRlmToolAuthorizer;
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
      const operationClass: RlmToolOperationClass =
        params.mode === "deterministic" ? "read_only_recall" : "effectful";
      const decision = yield* authorizer.authorize({
        runRef: params.runRef,
        mode: params.mode,
        operationClass,
      });
      if (!decision.granted) {
        return yield* new RlmError({
          reason: "authority_not_granted",
          retryable: false,
          detailSafe: decision.detailSafe ?? "RLM tool operation not authorized by host",
        });
      }
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
