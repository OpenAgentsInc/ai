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

export const RLM_CORPUS_SCHEMA_ID_V1 = "openagents.ai.rlm_corpus.v1" as const;
export const RLM_CORPUS_SCHEMA_ID = "openagents.ai.rlm_corpus.v2" as const;
export const RLM_SOURCE_PLANE_EXTENSION_SCHEMA_ID =
  "openagents.ai.rlm_source_plane_extension.v1" as const;
export const RLM_COMPOSITION_SCHEMA_ID = "openagents.ai.rlm_composition.v1" as const;

/** Generic logical source ref. The application owns this address and its authority. */
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

export const RlmStandardSourcePlane = S.Literals([
  "event_log",
  "thread_snapshot",
  "repository",
  "evidence_pack",
  "derived_graph",
  "profile_memory",
]);
export type RlmStandardSourcePlane = typeof RlmStandardSourcePlane.Type;

/** An extension plane is inert until trusted host configuration admits its schema ID. */
export const RlmExtendedSourcePlane = S.TaggedStruct("Extension", {
  schemaId: S.Literal(RLM_SOURCE_PLANE_EXTENSION_SCHEMA_ID),
  registrySchemaId: RlmRef,
  plane: RlmRef,
});
export type RlmExtendedSourcePlane = typeof RlmExtendedSourcePlane.Type;

export const RlmSourcePlane = S.Union([RlmStandardSourcePlane, RlmExtendedSourcePlane]);
export type RlmSourcePlane = typeof RlmSourcePlane.Type;

export const RlmCorpusIdentityV1 = S.Struct({
  schemaId: S.Literal(RLM_CORPUS_SCHEMA_ID_V1),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
});
export type RlmCorpusIdentityV1 = typeof RlmCorpusIdentityV1.Type;

export const RlmCorpusIdentity = S.Struct({
  schemaId: S.Literal(RLM_CORPUS_SCHEMA_ID),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
});
export type RlmCorpusIdentity = typeof RlmCorpusIdentity.Type;

export const RlmOrderingDescriptor = S.Struct({
  rule: S.Literals([
    "chronological",
    "source_declared",
    "explicit_array",
    "composite_child_then_ordinal",
  ]),
  note: S.optionalKey(RlmBoundedText),
});
export type RlmOrderingDescriptor = typeof RlmOrderingDescriptor.Type;

export const RlmCorpusPolicy = S.Struct({
  includeVisibilities: S.Array(RlmVisibility),
  includeRedactionClasses: S.Array(RlmRedactionClass),
});
export type RlmCorpusPolicy = typeof RlmCorpusPolicy.Type;

export const RlmSourcePointer = S.Struct({
  sourcePlane: RlmSourcePlane,
  sourceKind: RlmRef,
  sourceAddress: RlmSourceAddress,
});
export type RlmSourcePointer = typeof RlmSourcePointer.Type;

/** Exact non-circular origin for a source unit in an already-built corpus. */
export const RlmSourceLocator = S.Struct({
  sourcePlane: RlmSourcePlane,
  sourceKind: RlmRef,
  sourceAddress: RlmSourceAddress,
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  entryRef: RlmEntryRef,
});
export type RlmSourceLocator = typeof RlmSourceLocator.Type;

export const RlmCorpusEntryV1 = S.Struct({
  ordinal: RlmOrdinal,
  entryRef: RlmEntryRef,
  scopeRef: RlmScopeRef,
  sourceKind: RlmRef,
  sourceAddress: RlmSourceAddress,
  sourcePlane: S.optionalKey(S.Never),
  sourceOrigin: S.optionalKey(S.Never),
  supportingSources: S.optionalKey(S.Never),
  text: S.optionalKey(RlmBoundedText),
  visibility: RlmVisibility,
  redactionClass: RlmRedactionClass,
  observedAt: S.optionalKey(S.String),
});
export type RlmCorpusEntryV1 = typeof RlmCorpusEntryV1.Type;

export const RlmCorpusEntry = S.Struct({
  ordinal: RlmOrdinal,
  entryRef: RlmEntryRef,
  scopeRef: RlmScopeRef,
  sourcePlane: RlmSourcePlane,
  sourceKind: RlmRef,
  sourceAddress: RlmSourceAddress,
  sourceOrigin: S.optionalKey(RlmSourceLocator),
  supportingSources: S.optionalKey(S.Array(RlmSourceLocator)),
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

export const RlmCompositeChildIdentity = S.Struct({
  childIndex: RlmOrdinal,
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
});
export type RlmCompositeChildIdentity = typeof RlmCompositeChildIdentity.Type;

export const RlmCompositionExclusion = S.Struct({
  childCorpusRef: RlmCorpusRef,
  reason: RlmRef,
  count: RlmNonNegativeCount,
});
export type RlmCompositionExclusion = typeof RlmCompositionExclusion.Type;

export const RlmCorpusComposition = S.Struct({
  schemaId: S.Literal(RLM_COMPOSITION_SCHEMA_ID),
  children: S.Array(RlmCompositeChildIdentity),
  policy: RlmCorpusPolicy,
  orderingRule: S.Literal("composite_child_then_ordinal"),
  exclusions: S.Array(RlmCompositionExclusion),
  projectionDigest: RlmDigest,
});
export type RlmCorpusComposition = typeof RlmCorpusComposition.Type;

export const RlmCorpusManifestV1 = S.Struct({
  schemaId: S.Literal(RLM_CORPUS_SCHEMA_ID_V1),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
  ordering: RlmOrderingDescriptor,
  coverage: RlmCorpusCoverage,
  scopeRef: RlmScopeRef,
  policy: S.optionalKey(S.Never),
  composition: S.optionalKey(S.Never),
  builtAt: S.optionalKey(S.String),
});
export type RlmCorpusManifestV1 = typeof RlmCorpusManifestV1.Type;

export const RlmCorpusManifest = S.Struct({
  schemaId: S.Literal(RLM_CORPUS_SCHEMA_ID),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
  ordering: RlmOrderingDescriptor,
  coverage: RlmCorpusCoverage,
  policy: RlmCorpusPolicy,
  scopeRef: RlmScopeRef,
  composition: S.optionalKey(RlmCorpusComposition),
  builtAt: S.optionalKey(S.String),
});
export type RlmCorpusManifest = typeof RlmCorpusManifest.Type;

export const RlmCorpusInputV1 = S.Union([
  S.TaggedStruct("Source", { sourceRef: RlmCorpusSourceRef }),
  S.TaggedStruct("Inline", {
    manifest: RlmCorpusManifestV1,
    entries: S.Array(RlmCorpusEntryV1),
  }),
]);
export type RlmCorpusInputV1 = typeof RlmCorpusInputV1.Type;

export const RlmCorpusInput = S.Union([
  S.TaggedStruct("Source", { sourceRef: RlmCorpusSourceRef }),
  S.TaggedStruct("Inline", {
    manifest: RlmCorpusManifestV1,
    entries: S.Array(RlmCorpusEntryV1),
  }),
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

const RlmCitationV1Fields = {
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  scopeRef: RlmScopeRef,
  sourceAddress: RlmSourceAddress,
  entryRefStart: RlmEntryRef,
  entryRefEnd: S.optionalKey(RlmEntryRef),
};
const RlmCitationExcerptText = S.String.check(S.isMaxLength(512));
export const RlmCitationV1 = S.Union([
  S.Struct({ ...RlmCitationV1Fields, excerpt: RlmCitationExcerptText, excerptDigest: RlmDigest }),
  S.Struct({
    ...RlmCitationV1Fields,
    excerpt: S.optionalKey(S.Never),
    excerptDigest: S.optionalKey(S.Never),
  }),
]);
export type RlmCitationV1 = typeof RlmCitationV1.Type;

const RlmCitationFields = {
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  scopeRef: RlmScopeRef,
  sourcePlane: RlmSourcePlane,
  sourceAddress: RlmSourceAddress,
  sourceOrigin: RlmSourceLocator,
  supportingSources: S.Array(RlmSourceLocator),
  entryRefStart: RlmEntryRef,
  entryRefEnd: S.optionalKey(RlmEntryRef),
};
export const RlmCitation = S.Union([
  S.Struct({ ...RlmCitationFields, excerpt: RlmCitationExcerptText, excerptDigest: RlmDigest }),
  S.Struct({
    ...RlmCitationFields,
    excerpt: S.optionalKey(S.Never),
    excerptDigest: S.optionalKey(S.Never),
  }),
]);
export type RlmCitation = typeof RlmCitation.Type;
