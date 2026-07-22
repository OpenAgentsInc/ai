import { Schema as S } from "effect";
import { RlmRedactionClass, RlmSourceLocator, RlmVisibility } from "@openagentsinc/rlm/schemas";

export const GRAPH_SCHEMA_ID = "openagents.ai.graph_snapshot.v1" as const;
export const GRAPH_MANIFEST_SCHEMA_ID = "openagents.ai.graph_manifest.v1" as const;
export const GRAPH_CANONICALIZATION_ID = "openagents.ai.graph_canonicalization.v1" as const;
export const GRAPH_ELEMENT_ADDRESS_SCHEMA_ID = "openagents.ai.graph_element_address.v1" as const;

const graphRef = <const Brand extends string>(brand: Brand) =>
  S.String.check(
    S.isMinLength(1),
    S.isMaxLength(512),
    S.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  ).pipe(S.brand(brand));

export const GraphRef = graphRef("GraphRef");
export type GraphRef = typeof GraphRef.Type;
export const GraphScopeRef = graphRef("GraphScopeRef");
export type GraphScopeRef = typeof GraphScopeRef.Type;
export const GraphElementRef = graphRef("GraphElementRef");
export type GraphElementRef = typeof GraphElementRef.Type;
export const GraphMentionRef = graphRef("GraphMentionRef");
export type GraphMentionRef = typeof GraphMentionRef.Type;
export const GraphEntityRef = graphRef("GraphEntityRef");
export type GraphEntityRef = typeof GraphEntityRef.Type;
export const GraphRelationRef = graphRef("GraphRelationRef");
export type GraphRelationRef = typeof GraphRelationRef.Type;
export const GraphMergeRef = graphRef("GraphMergeRef");
export type GraphMergeRef = typeof GraphMergeRef.Type;
export const GraphDescriptorRef = graphRef("GraphDescriptorRef");
export type GraphDescriptorRef = typeof GraphDescriptorRef.Type;
export const GraphDigest = S.String.check(S.isPattern(/^[a-f0-9]{64}$/)).pipe(
  S.brand("GraphDigest"),
);
export type GraphDigest = typeof GraphDigest.Type;

export const GraphElementKind = S.Literals(["mention", "entity", "relation"]);
export type GraphElementKind = typeof GraphElementKind.Type;

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return value.normalize("NFC") === value;
};

export const GraphCanonicalKey = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(2048),
  S.makeFilter(isWellFormedUnicode, {
    description: "well-formed NFC Unicode graph canonical key",
  }),
);
export type GraphCanonicalKey = typeof GraphCanonicalKey.Type;

export const GraphIdentityScope = S.Union([
  S.TaggedStruct("Global", {}),
  S.TaggedStruct("Scoped", { scopeRef: GraphScopeRef }),
]);
export type GraphIdentityScope = typeof GraphIdentityScope.Type;

export const GraphIdentity = S.Struct({
  schemaId: S.Literal(GRAPH_SCHEMA_ID),
  canonicalizationId: S.Literal(GRAPH_CANONICALIZATION_ID),
  elementKind: GraphElementKind,
  identityNamespace: graphRef("GraphIdentityNamespace"),
  canonicalKey: GraphCanonicalKey,
  identityScope: GraphIdentityScope,
});
export type GraphIdentity = typeof GraphIdentity.Type;

/** One ref-only membership in an immutable source corpus. */
export const GraphSourceMembership = S.Struct({
  source: RlmSourceLocator,
});
export type GraphSourceMembership = typeof GraphSourceMembership.Type;

export const GraphDecodeOutcome = S.Literals(["decoded", "repaired", "rejected"]);
export type GraphDecodeOutcome = typeof GraphDecodeOutcome.Type;

export const GraphDeterministicDerivation = S.TaggedStruct("Deterministic", {
  parserRef: graphRef("GraphParserRef"),
  parserVersion: graphRef("GraphParserVersion"),
  extractorKind: S.optionalKey(S.Never),
  dseSignatureRef: S.optionalKey(S.Never),
  compiledProgramDigest: S.optionalKey(S.Never),
  extractionInputDigest: S.optionalKey(S.Never),
  decodeOutcome: S.optionalKey(S.Never),
  usageReceiptRef: S.optionalKey(S.Never),
});
export type GraphDeterministicDerivation = typeof GraphDeterministicDerivation.Type;

export const GraphModelDerivation = S.TaggedStruct("Model", {
  extractorKind: graphRef("GraphExtractorKind"),
  dseSignatureRef: graphRef("GraphDseSignatureRef"),
  compiledProgramDigest: GraphDigest,
  extractionInputDigest: GraphDigest,
  decodeOutcome: GraphDecodeOutcome,
  usageReceiptRef: graphRef("GraphUsageReceiptRef"),
  parserRef: S.optionalKey(S.Never),
  parserVersion: S.optionalKey(S.Never),
});
export type GraphModelDerivation = typeof GraphModelDerivation.Type;

export const GraphDerivation = S.Union([GraphDeterministicDerivation, GraphModelDerivation]);
export type GraphDerivation = typeof GraphDerivation.Type;

const commonElementFields = {
  schemaId: S.Literal(GRAPH_SCHEMA_ID),
  elementRef: GraphElementRef,
  identity: GraphIdentity,
  memberships: S.Array(GraphSourceMembership),
  derivation: GraphDerivation,
};

export const GraphMention = S.Struct({
  ...commonElementFields,
  elementKind: S.Literal("mention"),
  mentionRef: GraphMentionRef,
  source: RlmSourceLocator,
});
export type GraphMention = typeof GraphMention.Type;

export const GraphCanonicalEntity = S.Struct({
  ...commonElementFields,
  elementKind: S.Literal("entity"),
  entityRef: GraphEntityRef,
  mentionRefs: S.Array(GraphMentionRef),
});
export type GraphCanonicalEntity = typeof GraphCanonicalEntity.Type;

export const GraphRelation = S.Struct({
  ...commonElementFields,
  elementKind: S.Literal("relation"),
  relationRef: GraphRelationRef,
  relationKind: graphRef("GraphRelationKind"),
  fromEntityRef: GraphEntityRef,
  toEntityRef: GraphEntityRef,
});
export type GraphRelation = typeof GraphRelation.Type;

export const GraphMergeEvidence = S.Struct({
  schemaId: S.Literal(GRAPH_SCHEMA_ID),
  mergeRef: GraphMergeRef,
  entityRef: GraphEntityRef,
  mentionRefs: S.Array(GraphMentionRef),
  evidenceRef: graphRef("GraphEvidenceRef"),
  memberships: S.Array(GraphSourceMembership),
});
export type GraphMergeEvidence = typeof GraphMergeEvidence.Type;

export const GraphEmbeddingProjectionDescriptor = S.Struct({
  schemaId: S.Literal(GRAPH_SCHEMA_ID),
  descriptorRef: GraphDescriptorRef,
  projectionSchemaId: graphRef("GraphProjectionSchemaRef"),
  elementKinds: S.Array(GraphElementKind),
  embeddableFields: S.Array(graphRef("GraphEmbeddableFieldRef")),
  dimensions: S.Number.check(S.isFinite(), S.isInt(), S.isGreaterThanOrEqualTo(1)),
});
export type GraphEmbeddingProjectionDescriptor = typeof GraphEmbeddingProjectionDescriptor.Type;

export const GraphCorpusPolicy = S.Struct({
  includeVisibilities: S.Array(RlmVisibility),
  includeRedactionClasses: S.Array(RlmRedactionClass),
});
export type GraphCorpusPolicy = typeof GraphCorpusPolicy.Type;

export const GraphSnapshot = S.Struct({
  schemaId: S.Literal(GRAPH_SCHEMA_ID),
  canonicalizationId: S.Literal(GRAPH_CANONICALIZATION_ID),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  policy: GraphCorpusPolicy,
  graphDigest: GraphDigest,
  mentions: S.Array(GraphMention),
  entities: S.Array(GraphCanonicalEntity),
  relations: S.Array(GraphRelation),
  merges: S.Array(GraphMergeEvidence),
  embeddingProjections: S.Array(GraphEmbeddingProjectionDescriptor),
});
export type GraphSnapshot = typeof GraphSnapshot.Type;

export const GraphCoverage = S.Struct({
  mentionCount: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  entityCount: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  relationCount: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  mergeCount: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});
export type GraphCoverage = typeof GraphCoverage.Type;

export const GraphManifest = S.Struct({
  schemaId: S.Literal(GRAPH_MANIFEST_SCHEMA_ID),
  canonicalizationId: S.Literal(GRAPH_CANONICALIZATION_ID),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  policy: GraphCorpusPolicy,
  coverage: GraphCoverage,
});
export type GraphManifest = typeof GraphManifest.Type;

export const graphRefValue = S.decodeUnknownSync(GraphRef);
export const graphScopeRef = S.decodeUnknownSync(GraphScopeRef);
export const graphElementRef = S.decodeUnknownSync(GraphElementRef);
export const graphMentionRef = S.decodeUnknownSync(GraphMentionRef);
export const graphEntityRef = S.decodeUnknownSync(GraphEntityRef);
export const graphRelationRef = S.decodeUnknownSync(GraphRelationRef);
export const graphMergeRef = S.decodeUnknownSync(GraphMergeRef);
export const graphDescriptorRef = S.decodeUnknownSync(GraphDescriptorRef);
export const graphDigest = S.decodeUnknownSync(GraphDigest);
