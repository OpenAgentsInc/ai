import { Schema as S } from "effect";
import {
  RlmBoundedOutput,
  RlmBoundedText,
  RlmDigest,
  RlmNonNegativeCount,
  RlmPositiveCount,
  RlmRef,
  RlmRunRef,
  RlmStrategyRef,
  RlmValueRef,
} from "./primitives.ts";
import { RlmBudget, RlmEvidencePolicy } from "./budget.ts";
import { RlmCitation, RlmCorpusInput } from "./corpus.ts";

export const RLM_REQUEST_SCHEMA_ID = "openagents.ai.rlm_request.v1" as const;

export const RlmDeterministicOperation = S.Union([
  S.TaggedStruct("Grep", {
    pattern: RlmBoundedText,
    caseSensitive: S.optionalKey(S.Boolean),
  }),
  S.TaggedStruct("OrdinalSlice", {
    start: RlmNonNegativeCount,
    endInclusive: RlmNonNegativeCount,
  }),
  S.TaggedStruct("InspectMetadata", {}),
]);
export type RlmDeterministicOperation = typeof RlmDeterministicOperation.Type;

export const RlmDeterministicLimits = S.Struct({
  maxEntriesScanned: RlmPositiveCount,
  maxSpans: RlmPositiveCount,
  maxCharsPerSpan: RlmPositiveCount,
  maxObservationChars: RlmPositiveCount,
});
export type RlmDeterministicLimits = typeof RlmDeterministicLimits.Type;

export const defaultRlmDeterministicLimits: RlmDeterministicLimits = {
  maxEntriesScanned: 10_000,
  maxSpans: 64,
  maxCharsPerSpan: 2_048,
  maxObservationChars: 8_192,
};

export const RlmDeterministicRequest = S.TaggedStruct("Deterministic", {
  schemaId: S.Literal(RLM_REQUEST_SCHEMA_ID),
  runRef: RlmRunRef,
  corpus: RlmCorpusInput,
  operation: RlmDeterministicOperation,
  limits: RlmDeterministicLimits,
});
export type RlmDeterministicRequest = typeof RlmDeterministicRequest.Type;

export const RlmSemanticRequest = S.TaggedStruct("Semantic", {
  schemaId: S.Literal(RLM_REQUEST_SCHEMA_ID),
  runRef: RlmRunRef,
  corpus: RlmCorpusInput,
  question: RlmBoundedText,
  budget: RlmBudget,
  evidence: RlmEvidencePolicy,
  strategyRef: S.optionalKey(RlmStrategyRef),
});
export type RlmSemanticRequest = typeof RlmSemanticRequest.Type;

export const RlmRequest = S.Union([RlmDeterministicRequest, RlmSemanticRequest]);
export type RlmRequest = typeof RlmRequest.Type;

export const RlmTokenUsage = S.Struct({
  inputTokens: S.optionalKey(RlmNonNegativeCount),
  outputTokens: S.optionalKey(RlmNonNegativeCount),
  totalTokens: S.optionalKey(RlmNonNegativeCount),
  completeness: S.Literals(["complete", "partial", "unavailable"]),
  modelCalls: RlmNonNegativeCount,
  subcalls: RlmNonNegativeCount,
});
export type RlmTokenUsage = typeof RlmTokenUsage.Type;

export const emptyRlmTokenUsage = (opts?: {
  modelCalls?: number;
  subcalls?: number;
}): RlmTokenUsage => ({
  completeness: "unavailable",
  modelCalls: opts?.modelCalls ?? 0,
  subcalls: opts?.subcalls ?? 0,
});

export const RlmHonesty = S.Struct({
  capsHit: S.Array(RlmRef),
  usageCompleteness: S.Literals(["complete", "partial", "unavailable"]),
  citationValidated: RlmNonNegativeCount,
  citationInvalid: RlmNonNegativeCount,
  programNodes: RlmNonNegativeCount,
  valuesPublished: RlmNonNegativeCount,
  modelMapCalls: RlmNonNegativeCount,
  rlmMapCalls: RlmNonNegativeCount,
  strategyRef: S.optionalKey(RlmStrategyRef),
  note: S.optionalKey(RlmBoundedText),
});
export type RlmHonesty = typeof RlmHonesty.Type;

export const RlmFinding = S.Struct({
  entryRef: RlmRef,
  ordinal: RlmNonNegativeCount,
  excerpt: RlmBoundedText,
  citation: RlmCitation,
});
export type RlmFinding = typeof RlmFinding.Type;

export const RlmArtifactDescriptor = S.Struct({
  artifactRef: RlmRef,
  digest: RlmDigest,
  encodedBytes: RlmNonNegativeCount,
  mediaType: RlmRef,
  retentionClass: S.Literals(["ephemeral", "run_scoped", "durable"]),
});
export type RlmArtifactDescriptor = typeof RlmArtifactDescriptor.Type;

export const RlmOutput = S.Union([
  S.TaggedStruct("DeterministicFindings", {
    findings: S.Array(RlmFinding),
  }),
  S.TaggedStruct("InlineValue", {
    value: RlmBoundedOutput,
    valueRef: RlmValueRef,
    digest: RlmDigest,
  }),
  S.TaggedStruct("Artifact", {
    artifact: RlmArtifactDescriptor,
    valueRef: RlmValueRef,
  }),
]);
export type RlmOutput = typeof RlmOutput.Type;

export const RlmRunSummary = S.Struct({
  runRef: RlmRunRef,
  depth: RlmNonNegativeCount,
  iterations: RlmNonNegativeCount,
  corpusRef: RlmRef,
  contentDigest: RlmDigest,
});
export type RlmRunSummary = typeof RlmRunSummary.Type;

export const RlmPartialReason = S.Literals([
  "budget_exhausted",
  "timeout",
  "invalid_citations",
  "oversized_inline_output",
  "cap_truncated",
  "incomplete_evidence",
]);
export type RlmPartialReason = typeof RlmPartialReason.Type;

export const RlmRefusalReason = S.Literals(["semantic_not_admitted", "policy", "corpus_empty"]);
export type RlmRefusalReason = typeof RlmRefusalReason.Type;

export const RlmCompleted = S.TaggedStruct("Completed", {
  run: RlmRunSummary,
  output: RlmOutput,
  citations: S.Array(RlmCitation),
  usage: RlmTokenUsage,
  honesty: RlmHonesty,
});
export type RlmCompleted = typeof RlmCompleted.Type;

export const RlmPartial = S.TaggedStruct("Partial", {
  run: RlmRunSummary,
  reason: RlmPartialReason,
  bestOutput: S.optionalKey(RlmOutput),
  citations: S.Array(RlmCitation),
  usage: RlmTokenUsage,
  honesty: RlmHonesty,
});
export type RlmPartial = typeof RlmPartial.Type;

export const RlmRefused = S.TaggedStruct("Refused", {
  run: RlmRunSummary,
  reason: RlmRefusalReason,
  usage: RlmTokenUsage,
  honesty: RlmHonesty,
});
export type RlmRefused = typeof RlmRefused.Type;

export const RlmTerminalResult = S.Union([RlmCompleted, RlmPartial, RlmRefused]);
export type RlmTerminalResult = typeof RlmTerminalResult.Type;
