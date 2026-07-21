import { Schema as S } from "effect";
import {
  RlmDepth,
  RlmNonNegativeCount,
  RlmPositiveCount,
  RlmPositiveMilliseconds,
  RlmStrategyRef,
} from "./primitives.ts";

export const RlmBudget = S.Struct({
  maxDepth: RlmDepth,
  maxIterationsPerLoop: RlmPositiveCount,
  maxModelCalls: RlmPositiveCount,
  timeoutMs: RlmPositiveMilliseconds,
  maxInputTokens: RlmPositiveCount,
  maxOutputTokens: RlmPositiveCount,
  maxTotalTokens: RlmPositiveCount,
  maxSubcalls: RlmNonNegativeCount,
  maxProgramNodesPerIteration: RlmPositiveCount,
  maxProgramNodes: RlmPositiveCount,
  maxFanOut: RlmPositiveCount,
  maxFanIn: RlmPositiveCount,
  maxConcurrentCalls: RlmPositiveCount,
  maxValues: RlmPositiveCount,
  maxCollectionItems: RlmPositiveCount,
  maxValueBytes: RlmPositiveCount,
  maxEnvironmentBytes: RlmPositiveCount,
  maxInlineOutputBytes: RlmPositiveCount,
  maxArtifactOutputBytes: RlmNonNegativeCount,
  maxPromptTokensPerCall: RlmPositiveCount,
  maxOutputTokensPerCall: RlmPositiveCount,
  maxObservationChars: RlmPositiveCount,
  maxTranscriptChars: RlmPositiveCount,
  maxEntriesScannedPerOperation: RlmPositiveCount,
  maxSpansPerOperation: RlmPositiveCount,
  maxCharsPerSpan: RlmPositiveCount,
  requireExactUsage: S.Boolean,
});
export type RlmBudget = typeof RlmBudget.Type;

/** Conservative semantic defaults for hermetic tests and first-class rc. */
export const defaultRlmBudget: RlmBudget = {
  maxDepth: 2,
  maxIterationsPerLoop: 8,
  maxModelCalls: 32,
  timeoutMs: 60_000,
  maxInputTokens: 200_000,
  maxOutputTokens: 32_000,
  maxTotalTokens: 250_000,
  maxSubcalls: 64,
  maxProgramNodesPerIteration: 32,
  maxProgramNodes: 128,
  maxFanOut: 32,
  maxFanIn: 32,
  maxConcurrentCalls: 8,
  maxValues: 256,
  maxCollectionItems: 10_000,
  maxValueBytes: 262_144,
  maxEnvironmentBytes: 8_388_608,
  maxInlineOutputBytes: 65_536,
  maxArtifactOutputBytes: 0,
  maxPromptTokensPerCall: 32_000,
  maxOutputTokensPerCall: 4_096,
  maxObservationChars: 8_192,
  maxTranscriptChars: 32_768,
  maxEntriesScannedPerOperation: 10_000,
  maxSpansPerOperation: 64,
  maxCharsPerSpan: 2_048,
  requireExactUsage: false,
};

export const RlmEvidencePolicy = S.Struct({
  requireCitations: S.Boolean,
  minimumCitations: RlmNonNegativeCount,
  invalidCitation: S.Literals(["partial", "fail"]),
  requireCompleteCorpusCoverage: S.Boolean,
});
export type RlmEvidencePolicy = typeof RlmEvidencePolicy.Type;

export const defaultRlmEvidencePolicy: RlmEvidencePolicy = {
  requireCitations: true,
  minimumCitations: 1,
  invalidCitation: "partial",
  requireCompleteCorpusCoverage: false,
};

export const RlmStrategyProfile = S.Struct({
  strategyRef: RlmStrategyRef,
  version: RlmPositiveCount,
  note: S.optionalKey(S.String),
});
export type RlmStrategyProfile = typeof RlmStrategyProfile.Type;
