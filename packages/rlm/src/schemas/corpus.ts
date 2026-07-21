import { Schema as S } from "effect";
import {
  RlmBoundedText,
  RlmCorpusDigest,
  RlmCorpusRef,
  RlmDigest,
  RlmEntryRef,
  RlmManifestDigest,
  RlmNonNegativeCount,
  RlmOrdinal,
  RlmRedactionClass,
  RlmRef,
  RlmScopeRef,
  RlmVisibility,
} from "./primitives.ts";

export const RLM_CORPUS_SCHEMA_ID = "openagents.ai.rlm_corpus.v1" as const;

/** Generic logical source ref — adapter-owned identity, not history-specific. */
export const RlmCorpusSourceRef = S.Struct({
  addressSchemaId: RlmRef,
  encodedAddress: RlmBoundedText,
});
export type RlmCorpusSourceRef = typeof RlmCorpusSourceRef.Type;

/** Canonical source address envelope for citations. */
export const RlmSourceAddress = S.Struct({
  addressSchemaId: RlmRef,
  encodedAddress: RlmBoundedText,
});
export type RlmSourceAddress = typeof RlmSourceAddress.Type;

export const RlmCorpusIdentity = S.Struct({
  schemaId: S.Literal(RLM_CORPUS_SCHEMA_ID),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
});
export type RlmCorpusIdentity = typeof RlmCorpusIdentity.Type;

export const RlmOrderingDescriptor = S.Struct({
  rule: S.Literals(["chronological", "source_declared", "explicit_array"]),
  note: S.optionalKey(RlmBoundedText),
});
export type RlmOrderingDescriptor = typeof RlmOrderingDescriptor.Type;

export const RlmCorpusEntry = S.Struct({
  ordinal: RlmOrdinal,
  entryRef: RlmEntryRef,
  scopeRef: RlmScopeRef,
  sourceKind: RlmRef,
  sourceAddress: RlmSourceAddress,
  text: S.optionalKey(RlmBoundedText),
  visibility: RlmVisibility,
  redactionClass: RlmRedactionClass,
  observedAt: S.optionalKey(S.String),
});
export type RlmCorpusEntry = typeof RlmCorpusEntry.Type;

export const RlmExclusionCount = S.Struct({
  reason: RlmRef,
  count: RlmNonNegativeCount,
});
export type RlmExclusionCount = typeof RlmExclusionCount.Type;

export const RlmCorpusCoverage = S.Struct({
  note: RlmBoundedText,
  entryCount: RlmNonNegativeCount,
  encodedBytes: RlmNonNegativeCount,
  exclusions: S.Array(RlmExclusionCount),
});
export type RlmCorpusCoverage = typeof RlmCorpusCoverage.Type;

export const RlmCorpusManifest = S.Struct({
  schemaId: S.Literal(RLM_CORPUS_SCHEMA_ID),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
  ordering: RlmOrderingDescriptor,
  coverage: RlmCorpusCoverage,
  scopeRef: RlmScopeRef,
  builtAt: S.optionalKey(S.String),
});
export type RlmCorpusManifest = typeof RlmCorpusManifest.Type;

export const RlmCorpusInput = S.Union([
  S.TaggedStruct("Source", { sourceRef: RlmCorpusSourceRef }),
  S.TaggedStruct("Inline", {
    manifest: RlmCorpusManifest,
    entries: S.Array(RlmCorpusEntry),
  }),
]);
export type RlmCorpusInput = typeof RlmCorpusInput.Type;

export const RlmOrdinalRange = S.Struct({
  start: RlmOrdinal,
  endInclusive: RlmOrdinal,
});
export type RlmOrdinalRange = typeof RlmOrdinalRange.Type;

export const RlmReadLimits = S.Struct({
  maxEntries: RlmNonNegativeCount,
  maxCharsPerEntry: RlmNonNegativeCount,
});
export type RlmReadLimits = typeof RlmReadLimits.Type;

export const RlmScanRequest = S.Struct({
  fromOrdinal: S.optionalKey(RlmOrdinal),
  maxEntries: RlmNonNegativeCount,
});
export type RlmScanRequest = typeof RlmScanRequest.Type;

export const RlmCitation = S.Struct({
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  scopeRef: RlmScopeRef,
  sourceAddress: RlmSourceAddress,
  entryRefStart: RlmEntryRef,
  entryRefEnd: S.optionalKey(RlmEntryRef),
  excerpt: S.optionalKey(RlmBoundedText),
  excerptDigest: S.optionalKey(RlmDigest),
});
export type RlmCitation = typeof RlmCitation.Type;
