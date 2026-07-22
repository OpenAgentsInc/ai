import { Effect, Result, Schema as S } from "effect";
import { createHash } from "node:crypto";
import { RlmRedactionClass, RlmSourceLocator, RlmVisibility } from "@openagentsinc/rlm/schemas";

import { buildGraphCorpus, verifyBuiltGraphCorpus, type BuiltGraphCorpus } from "./builder.ts";
import { canonicalJson, compareCanonicalText, sha256Hex } from "./canonical.ts";
import { GraphAdapterCapabilities, requireGraphAdapterCapability } from "./capabilities.ts";
import { checkGraphArtifactInventoryIntegrity } from "./artifact-inventory-integrity.ts";
import {
  GraphArtifactInventory,
  GraphArtifactPlaneCoverage,
  GraphRankingArtifact,
  GraphSummaryArtifact,
  GraphVectorArtifact,
  makeGraphArtifactInventory,
  type GraphArtifactInventory as GraphArtifactInventoryType,
} from "./deletion.ts";
import { GraphRankingSnapshot, validateGraphRankingSnapshotIntegrity } from "./ranking.ts";
import {
  GRAPH_CANONICALIZATION_ID,
  GRAPH_SCHEMA_ID,
  GraphCanonicalEntity,
  GraphCorpusPolicy,
  GraphDerivation,
  GraphDigest,
  GraphEmbeddingProjectionDescriptor,
  GraphElementRef,
  GraphMention,
  GraphMergeEvidence,
  GraphRelation,
  GraphRef,
  GraphScopeRef,
  GraphSourceMembership,
  graphDigest,
} from "./schemas.ts";

export const GRAPH_ARCHIVE_SCHEMA_ID = "openagents.ai.graph_corpus_archive.v1" as const;
export const GRAPH_ARCHIVE_FORMAT_VERSION = 1 as const;
export const GRAPH_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const GRAPH_ARCHIVE_MAX_SECTION_ITEMS = 10_000;
export const GRAPH_ARCHIVE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const GRAPH_ARCHIVE_MAX_ENCODED_PAYLOAD_CHARACTERS = 3 * 1024 * 1024;

const boundedArray = <A extends S.Top>(schema: A) =>
  S.Array(schema).check(S.isMaxLength(GRAPH_ARCHIVE_MAX_SECTION_ITEMS));
const digest = (value: unknown) => graphDigest(sha256Hex(canonicalJson(value)));
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const GraphArchiveRef = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(512),
  S.isPattern(refPattern),
).pipe(S.brand("GraphArchiveRef"));
export type GraphArchiveRef = typeof GraphArchiveRef.Type;
const graphArchiveRef = S.decodeUnknownSync(GraphArchiveRef);

const sectionFields = { sectionDigest: GraphDigest };
export const GraphArchiveGraphSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.graph.v1"),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  policy: GraphCorpusPolicy,
  ...sectionFields,
});
export type GraphArchiveGraphSection = typeof GraphArchiveGraphSection.Type;

export const GraphArchiveNodeSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.nodes.v1"),
  mentions: boundedArray(GraphMention),
  entities: boundedArray(GraphCanonicalEntity),
  ...sectionFields,
});
export const GraphArchiveEdgeSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.edges.v1"),
  relations: boundedArray(GraphRelation),
  ...sectionFields,
});
export const GraphArchiveSourceMembershipEntry = S.Struct({
  elementRef: GraphElementRef,
  memberships: boundedArray(GraphSourceMembership),
});
export const GraphArchiveSourceMembershipSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.source_memberships.v1"),
  entries: boundedArray(GraphArchiveSourceMembershipEntry),
  ...sectionFields,
});
export const GraphArchiveMergeEvidenceSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.merge_evidence.v1"),
  merges: boundedArray(GraphMergeEvidence),
  ...sectionFields,
});

export const GraphArchiveProvenanceEntry = S.Struct({
  elementRef: GraphElementRef,
  derivation: GraphDerivation,
});
export const GraphArchiveProvenanceSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.provenance.v1"),
  entries: boundedArray(GraphArchiveProvenanceEntry),
  mergeEvidence: boundedArray(GraphMergeEvidence),
  ...sectionFields,
});
export type GraphArchiveProvenanceSection = typeof GraphArchiveProvenanceSection.Type;

export const GraphArchiveDescriptorSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.descriptors.v1"),
  descriptors: boundedArray(GraphEmbeddingProjectionDescriptor),
  ...sectionFields,
});
export type GraphArchiveDescriptorSection = typeof GraphArchiveDescriptorSection.Type;

export const GraphArchiveVectorRecord = S.Struct({
  artifact: GraphVectorArtifact,
  descriptorRef: GraphEmbeddingProjectionDescriptor.fields.descriptorRef,
  dimensions: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(4_096)),
  encoding: S.Literal("float32-le-base64"),
  payloadBase64: S.String.check(S.isMaxLength(3_000_000)),
  payloadDigest: GraphDigest,
  visibility: RlmVisibility,
  redactionClass: RlmRedactionClass,
});
export type GraphArchiveVectorRecord = typeof GraphArchiveVectorRecord.Type;
export const GraphArchiveVectorSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.vectors.v1"),
  records: boundedArray(GraphArchiveVectorRecord),
  coverage: GraphArtifactPlaneCoverage,
  ...sectionFields,
});
export type GraphArchiveVectorSection = typeof GraphArchiveVectorSection.Type;

export const GraphArchiveSummaryRecord = S.Struct({
  artifact: GraphSummaryArtifact,
  summarySchemaId: S.String.check(S.isMinLength(1), S.isMaxLength(512)),
  encoding: S.Literal("utf8-base64"),
  payloadBase64: S.String.check(S.isMaxLength(3_000_000)),
  payloadDigest: GraphDigest,
  visibility: RlmVisibility,
  redactionClass: RlmRedactionClass,
});
export type GraphArchiveSummaryRecord = typeof GraphArchiveSummaryRecord.Type;
export const GraphArchiveSummarySection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.summaries.v1"),
  records: boundedArray(GraphArchiveSummaryRecord),
  coverage: GraphArtifactPlaneCoverage,
  ...sectionFields,
});
export type GraphArchiveSummarySection = typeof GraphArchiveSummarySection.Type;

export const GraphArchiveRankingSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.ranking.v1"),
  artifacts: boundedArray(GraphRankingArtifact),
  snapshots: boundedArray(GraphRankingSnapshot),
  coverage: GraphArtifactPlaneCoverage,
  ...sectionFields,
});
export type GraphArchiveRankingSection = typeof GraphArchiveRankingSection.Type;

export const GraphArchiveContentEntry = S.Struct({
  elementRef: GraphElementRef,
  source: RlmSourceLocator,
  text: S.String.check(S.isMaxLength(262_144)),
  contentDigest: GraphDigest,
  visibility: RlmVisibility,
  redactionClass: RlmRedactionClass,
});
export type GraphArchiveContentEntry = typeof GraphArchiveContentEntry.Type;
export const GraphArchiveContentExtensionSection = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive.content_extension.v1"),
  authorizationRef: S.String.check(S.isMinLength(1), S.isMaxLength(512), S.isPattern(refPattern)),
  authorityEvidenceRef: S.String.check(
    S.isMinLength(1),
    S.isMaxLength(512),
    S.isPattern(refPattern),
  ),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  policyDigest: GraphDigest,
  allowedVisibilities: boundedArray(RlmVisibility),
  allowedRedactionClasses: boundedArray(RlmRedactionClass),
  entries: boundedArray(GraphArchiveContentEntry),
  ...sectionFields,
});
export type GraphArchiveContentExtensionSection = typeof GraphArchiveContentExtensionSection.Type;

export const GraphArchiveSections = S.Struct({
  graph: GraphArchiveGraphSection,
  nodes: GraphArchiveNodeSection,
  edges: GraphArchiveEdgeSection,
  sourceMemberships: GraphArchiveSourceMembershipSection,
  mergeEvidence: GraphArchiveMergeEvidenceSection,
  provenance: GraphArchiveProvenanceSection,
  descriptors: GraphArchiveDescriptorSection,
  vectors: S.optionalKey(GraphArchiveVectorSection),
  summaries: S.optionalKey(GraphArchiveSummarySection),
  ranking: S.optionalKey(GraphArchiveRankingSection),
  contentExtension: S.optionalKey(GraphArchiveContentExtensionSection),
});
export type GraphArchiveSections = typeof GraphArchiveSections.Type;

export const GraphArchiveExclusion = S.Struct({
  section: S.Literals(["vectors", "summaries", "ranking", "content_extension"]),
  reason: S.Literals(["not_requested", "unavailable", "policy_excluded", "unsupported"]),
});
export type GraphArchiveExclusion = typeof GraphArchiveExclusion.Type;
export const GraphArchiveSectionDigests = S.Struct({
  graph: GraphDigest,
  nodes: GraphDigest,
  edges: GraphDigest,
  sourceMemberships: GraphDigest,
  mergeEvidence: GraphDigest,
  provenance: GraphDigest,
  descriptors: GraphDigest,
  vectors: S.optionalKey(GraphDigest),
  summaries: S.optionalKey(GraphDigest),
  ranking: S.optionalKey(GraphDigest),
  contentExtension: S.optionalKey(GraphDigest),
});
export const GraphArchiveCoverage = S.Struct({
  mentions: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  entities: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  relations: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  merges: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  descriptors: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  vectors: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  summaries: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  rankingArtifacts: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  rankingSnapshots: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  contentEntries: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
});
const ArchiveOrderingItem = S.Literals([
  "graph",
  "nodes",
  "edges",
  "source_memberships",
  "merge_evidence",
  "provenance",
  "descriptors",
  "vectors",
  "summaries",
  "ranking",
  "content_extension",
]);
export const GraphArchiveManifest = S.Struct({
  schemaId: S.Literal("openagents.ai.graph_archive_manifest.v1"),
  formatVersion: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
  graphSchemaId: S.String,
  canonicalizationId: S.String,
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  graphManifestDigest: GraphDigest,
  contentDigest: GraphDigest,
  manifestDigest: GraphDigest,
  archiveRef: GraphArchiveRef,
  sectionDigests: GraphArchiveSectionDigests,
  provenanceRefs: boundedArray(S.String.check(S.isMinLength(1), S.isMaxLength(512))),
  coverage: GraphArchiveCoverage,
  exclusions: boundedArray(GraphArchiveExclusion),
  ordering: boundedArray(ArchiveOrderingItem),
});
export type GraphArchiveManifest = typeof GraphArchiveManifest.Type;
export const GraphCorpusArchive = S.Struct({
  schemaId: S.Literal(GRAPH_ARCHIVE_SCHEMA_ID),
  manifest: GraphArchiveManifest,
  sections: GraphArchiveSections,
});
export type GraphCorpusArchive = typeof GraphCorpusArchive.Type;

export class GraphArchiveError extends S.TaggedErrorClass<GraphArchiveError>()(
  "GraphCorpus.ArchiveError",
  {
    reason: S.Literals([
      "unsupported_version",
      "migration_required",
      "oversized",
      "invalid_utf8",
      "invalid_json",
      "non_canonical",
      "invalid_archive",
      "digest_mismatch",
      "reconstruction_failed",
      "stale_binding",
      "forbidden_content",
    ]),
    detailSafe: S.optionalKey(S.String.check(S.isMaxLength(512))),
  },
) {}

const fail = (reason: GraphArchiveError["reason"], detailSafe: string) =>
  new GraphArchiveError({ reason, detailSafe });
const deepFreeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const withSectionDigest = <A extends object>(
  value: A,
): A & { readonly sectionDigest: GraphDigest } =>
  deepFreeze({ ...value, sectionDigest: digest(value) });
const sectionValid = (section: { readonly sectionDigest: GraphDigest }): boolean => {
  const { sectionDigest, ...content } = section;
  return sectionDigest === digest(content);
};
const archiveRefFor = (contentDigest: GraphDigest, manifestDigest: GraphDigest) =>
  graphArchiveRef(`archive.${sha256Hex(canonicalJson({ contentDigest, manifestDigest }))}`);
const orderingFor = (
  sections: GraphArchiveSections,
): ReadonlyArray<typeof ArchiveOrderingItem.Type> => [
  "graph",
  "nodes",
  "edges",
  "source_memberships",
  "merge_evidence",
  "provenance",
  "descriptors",
  ...(sections.vectors === undefined ? [] : (["vectors"] as const)),
  ...(sections.summaries === undefined ? [] : (["summaries"] as const)),
  ...(sections.ranking === undefined ? [] : (["ranking"] as const)),
  ...(sections.contentExtension === undefined ? [] : (["content_extension"] as const)),
];
const exclusionsFor = (sections: GraphArchiveSections): ReadonlyArray<GraphArchiveExclusion> =>
  [
    ...(sections.vectors === undefined
      ? [{ section: "vectors" as const, reason: "not_requested" as const }]
      : []),
    ...(sections.summaries === undefined
      ? [{ section: "summaries" as const, reason: "not_requested" as const }]
      : []),
    ...(sections.ranking === undefined
      ? [{ section: "ranking" as const, reason: "not_requested" as const }]
      : []),
    ...(sections.contentExtension === undefined
      ? [{ section: "content_extension" as const, reason: "not_requested" as const }]
      : []),
  ].sort((left, right) => compareCanonicalText(left.section, right.section));

const provenanceEntries = (built: BuiltGraphCorpus) =>
  [...built.snapshot.mentions, ...built.snapshot.entities, ...built.snapshot.relations]
    .map(({ elementRef, derivation }) => ({ elementRef, derivation }))
    .sort((left, right) => compareCanonicalText(left.elementRef, right.elementRef));
const provenanceRefs = (built: BuiltGraphCorpus): ReadonlyArray<string> =>
  [
    ...[
      ...built.snapshot.mentions,
      ...built.snapshot.entities,
      ...built.snapshot.relations,
    ].flatMap((item) => [
      ...item.memberships.map(({ source }) => `source.${sha256Hex(canonicalJson(source))}`),
      ...(item.derivation._tag === "Deterministic"
        ? [item.derivation.parserRef, item.derivation.parserVersion]
        : [
            item.derivation.extractorKind,
            item.derivation.dseSignatureRef,
            item.derivation.compiledProgramDigest,
            item.derivation.extractionInputDigest,
            item.derivation.usageReceiptRef,
          ]),
    ]),
    ...built.snapshot.merges.flatMap((item) =>
      item.memberships.map(({ source }) => `source.${sha256Hex(canonicalJson(source))}`),
    ),
    ...built.snapshot.merges.map((item) => item.evidenceRef),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort(compareCanonicalText);
const decodePayload = (value: string): Uint8Array | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return undefined;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return btoa(binary) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};
const payloadDigest = (bytes: Uint8Array) =>
  graphDigest(createHash("sha256").update(bytes).digest("hex"));
const contentEntryDigest = (entry: Omit<GraphArchiveContentEntry, "contentDigest">) =>
  digest(entry);

export interface ExportGraphCorpusArchiveInput {
  readonly built: BuiltGraphCorpus;
  readonly capabilities: GraphAdapterCapabilities;
  readonly artifactInventory?: GraphArtifactInventoryType;
  readonly vectorRecords?: ReadonlyArray<GraphArchiveVectorSection["records"][number]>;
  readonly summaryRecords?: ReadonlyArray<GraphArchiveSummarySection["records"][number]>;
  readonly rankingSnapshots?: ReadonlyArray<GraphRankingSnapshot>;
  readonly contentExtension?: {
    readonly authorizationRef: string;
    readonly authorityEvidenceRef: string;
    readonly allowedVisibilities: ReadonlyArray<typeof RlmVisibility.Type>;
    readonly allowedRedactionClasses: ReadonlyArray<typeof RlmRedactionClass.Type>;
    readonly entries: ReadonlyArray<GraphArchiveContentEntry>;
  };
}

const rankingSnapshotValid = (
  snapshot: GraphRankingSnapshot,
  built: BuiltGraphCorpus,
  known: ReadonlySet<string>,
): boolean => {
  const { snapshotRef, snapshotDigest, ...content } = snapshot;
  const identityMatches =
    snapshot.graphRef === built.snapshot.graphRef &&
    snapshot.scopeRef === built.snapshot.scopeRef &&
    snapshot.graphDigest === built.snapshot.graphDigest &&
    snapshot.manifestDigest === built.manifest.manifestDigest;
  const childIdentities = [
    ...snapshot.feedbackObservations,
    ...snapshot.confidences,
    ...snapshot.features,
  ];
  return (
    identityMatches &&
    snapshotDigest === digest(content) &&
    snapshotRef === `ranking-snapshot.${sha256Hex(canonicalJson(content))}` &&
    childIdentities.every(
      (item) =>
        known.has(item.elementRef) &&
        item.graphRef === snapshot.graphRef &&
        item.scopeRef === snapshot.scopeRef &&
        item.graphDigest === snapshot.graphDigest &&
        item.manifestDigest === snapshot.manifestDigest &&
        item.corpusRef === snapshot.corpusRef &&
        item.contentDigest === snapshot.contentDigest &&
        item.corpusManifestDigest === snapshot.corpusManifestDigest &&
        item.classificationDigest === snapshot.classificationDigest,
    )
  );
};

const payloadSectionsValid = (
  built: BuiltGraphCorpus,
  vectorRecords: GraphArchiveVectorSection["records"],
  summaryRecords: GraphArchiveSummarySection["records"],
): boolean => {
  const descriptors = new Map(
    built.snapshot.embeddingProjections.map((item) => [item.descriptorRef, item]),
  );
  const kinds = new Map(
    [...built.snapshot.mentions, ...built.snapshot.entities, ...built.snapshot.relations].map(
      (item) => [item.elementRef, item.elementKind],
    ),
  );
  let total = 0;
  const refs = [
    ...vectorRecords.map((item) => item.artifact.artifactRef),
    ...summaryRecords.map((item) => item.artifact.artifactRef),
  ];
  if (
    new Set(refs).size !== refs.length ||
    canonicalJson(vectorRecords) !==
      canonicalJson(
        [...vectorRecords].sort((left, right) =>
          compareCanonicalText(left.artifact.artifactRef, right.artifact.artifactRef),
        ),
      ) ||
    canonicalJson(summaryRecords) !==
      canonicalJson(
        [...summaryRecords].sort((left, right) =>
          compareCanonicalText(left.artifact.artifactRef, right.artifact.artifactRef),
        ),
      )
  )
    return false;
  for (const record of vectorRecords) {
    const bytes = decodePayload(record.payloadBase64);
    const descriptor = descriptors.get(record.descriptorRef);
    const elementKind = kinds.get(record.artifact.ownerElementRef);
    if (bytes === undefined) return false;
    total += bytes.byteLength;
    if (
      bytes.byteLength !== record.dimensions * 4 ||
      record.payloadDigest !== payloadDigest(bytes) ||
      record.artifact.artifactDigest !== record.payloadDigest ||
      descriptor?.dimensions !== record.dimensions ||
      elementKind === undefined ||
      !descriptor.elementKinds.includes(elementKind) ||
      !built.snapshot.policy.includeVisibilities.includes(record.visibility) ||
      !built.snapshot.policy.includeRedactionClasses.includes(record.redactionClass)
    )
      return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += 4)
      if (!Number.isFinite(view.getFloat32(offset, true))) return false;
  }
  for (const record of summaryRecords) {
    const bytes = decodePayload(record.payloadBase64);
    if (bytes === undefined) return false;
    total += bytes.byteLength;
    if (
      record.payloadDigest !== payloadDigest(bytes) ||
      record.artifact.artifactDigest !== record.payloadDigest ||
      !kinds.has(record.artifact.ownerElementRef) ||
      !built.snapshot.policy.includeVisibilities.includes(record.visibility) ||
      !built.snapshot.policy.includeRedactionClasses.includes(record.redactionClass)
    )
      return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return false;
    }
  }
  return total <= GRAPH_ARCHIVE_MAX_PAYLOAD_BYTES;
};
const rankingArtifactsFor = (snapshots: ReadonlyArray<GraphRankingSnapshot>) =>
  snapshots
    .flatMap((snapshot) =>
      snapshot.features.map((feature) => ({
        artifactKind: "ranking_ref" as const,
        artifactRef: feature.featureRef,
        artifactDigest: feature.featureDigest,
        ownerElementRef: feature.elementRef,
      })),
    )
    .sort((left, right) => compareCanonicalText(left.artifactRef, right.artifactRef));

const validateArchiveInventory = (
  built: BuiltGraphCorpus,
  inventory: GraphArtifactInventoryType,
): Effect.Effect<void, GraphArchiveError> =>
  Effect.gen(function* () {
    const decoded = S.decodeUnknownResult(GraphArtifactInventory)(inventory);
    if (Result.isFailure(decoded))
      return yield* fail("stale_binding", "The artifact inventory schema is invalid.");
    const failure = checkGraphArtifactInventoryIntegrity(built, decoded.success);
    if (failure !== undefined) return yield* fail("stale_binding", failure.detailSafe);
  });

export const exportGraphCorpusArchive = Effect.fn("GraphCorpus.exportArchive")(function* (
  input: ExportGraphCorpusArchiveInput,
) {
  yield* requireGraphAdapterCapability(input.capabilities, "snapshot_export").pipe(
    Effect.mapError(() => fail("stale_binding", "Snapshot export capability is not declared.")),
  );
  yield* verifyBuiltGraphCorpus(input.built).pipe(
    Effect.mapError(() => fail("stale_binding", "The graph snapshot or manifest is invalid.")),
  );
  const rawVectorRecords: unknown = input.vectorRecords ?? [];
  const rawSummaryRecords: unknown = input.summaryRecords ?? [];
  const rawRankingSnapshots: unknown = input.rankingSnapshots ?? [];
  const rawContentEntries: unknown =
    typeof input.contentExtension === "object" &&
    input.contentExtension !== null &&
    "entries" in input.contentExtension
      ? input.contentExtension.entries
      : [];
  if (
    [rawVectorRecords, rawSummaryRecords, rawRankingSnapshots, rawContentEntries].some(
      (value) => Array.isArray(value) && value.length > GRAPH_ARCHIVE_MAX_SECTION_ITEMS,
    )
  )
    return yield* fail("oversized", "Archive records exceed the aggregate item limit.");
  let rawCharacters = 0;
  for (const [records, field] of [
    [rawVectorRecords, "payloadBase64"],
    [rawSummaryRecords, "payloadBase64"],
    [rawContentEntries, "text"],
  ] as const) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      const value =
        typeof record === "object" && record !== null && field in record
          ? record[field]
          : undefined;
      rawCharacters += typeof value === "string" ? value.length : 0;
      if (rawCharacters > GRAPH_ARCHIVE_MAX_ENCODED_PAYLOAD_CHARACTERS)
        return yield* fail("oversized", "Raw archive payload text exceeds its limit.");
    }
  }
  const decodedVectorRecords = S.decodeUnknownResult(boundedArray(GraphArchiveVectorRecord))(
    rawVectorRecords,
  );
  const decodedSummaryRecords = S.decodeUnknownResult(boundedArray(GraphArchiveSummaryRecord))(
    rawSummaryRecords,
  );
  const decodedRankingSnapshots = S.decodeUnknownResult(boundedArray(GraphRankingSnapshot))(
    rawRankingSnapshots,
  );
  const decodedContentEntries = S.decodeUnknownResult(boundedArray(GraphArchiveContentEntry))(
    rawContentEntries,
  );
  if (
    Result.isFailure(decodedVectorRecords) ||
    Result.isFailure(decodedSummaryRecords) ||
    Result.isFailure(decodedRankingSnapshots) ||
    Result.isFailure(decodedContentEntries)
  )
    return yield* fail("invalid_archive", "An archive input record is invalid or unbounded.");
  const vectorRecords = decodedVectorRecords.success;
  const summaryRecords = decodedSummaryRecords.success;
  const rankingSnapshots = decodedRankingSnapshots.success;
  const contentEntries = decodedContentEntries.success;
  const aggregateItems = rankingSnapshots.reduce(
    (sum, snapshot) =>
      sum +
      snapshot.feedbackObservations.length +
      snapshot.confidences.length +
      snapshot.features.length,
    0,
  );
  if (
    rankingSnapshots.length > GRAPH_ARCHIVE_MAX_SECTION_ITEMS ||
    vectorRecords.length > GRAPH_ARCHIVE_MAX_SECTION_ITEMS ||
    summaryRecords.length > GRAPH_ARCHIVE_MAX_SECTION_ITEMS ||
    contentEntries.length > GRAPH_ARCHIVE_MAX_SECTION_ITEMS ||
    aggregateItems > GRAPH_ARCHIVE_MAX_SECTION_ITEMS
  )
    return yield* fail("oversized", "Archive records exceed the aggregate item limit.");
  if (input.artifactInventory !== undefined)
    yield* validateArchiveInventory(input.built, input.artifactInventory);
  const known = new Set([
    ...input.built.snapshot.mentions.map((item) => item.elementRef),
    ...input.built.snapshot.entities.map((item) => item.elementRef),
    ...input.built.snapshot.relations.map((item) => item.elementRef),
  ]);
  for (const snapshot of rankingSnapshots) {
    yield* validateGraphRankingSnapshotIntegrity(snapshot).pipe(
      Effect.mapError(() => fail("stale_binding", "A ranking snapshot is structurally invalid.")),
    );
    if (!rankingSnapshotValid(snapshot, input.built, known))
      return yield* fail("stale_binding", "A ranking snapshot is invalid or stale.");
  }
  const contentBytes = contentEntries.reduce(
    (sum, entry) => sum + new TextEncoder().encode(entry.text).byteLength,
    0,
  );
  if (contentBytes > GRAPH_ARCHIVE_MAX_PAYLOAD_BYTES)
    return yield* fail("oversized", "Content extension bytes exceed the archive payload limit.");
  const inventoryVectors = input.artifactInventory?.vectors ?? [];
  const inventorySummaries = input.artifactInventory?.summaries ?? [];
  if (
    canonicalJson(
      vectorRecords
        .map((item) => item.artifact)
        .sort((left, right) => compareCanonicalText(left.artifactRef, right.artifactRef)),
    ) !== canonicalJson(inventoryVectors) ||
    canonicalJson(
      summaryRecords
        .map((item) => item.artifact)
        .sort((left, right) => compareCanonicalText(left.artifactRef, right.artifactRef)),
    ) !== canonicalJson(inventorySummaries)
  )
    return yield* fail("stale_binding", "Portable payload records do not match the inventory.");
  const descriptorsByRef = new Map(
    input.built.snapshot.embeddingProjections.map((item) => [item.descriptorRef, item]),
  );
  const elementKindByRef = new Map(
    [
      ...input.built.snapshot.mentions,
      ...input.built.snapshot.entities,
      ...input.built.snapshot.relations,
    ].map((item) => [item.elementRef, item.elementKind]),
  );
  let payloadBytes = 0;
  for (const record of vectorRecords) {
    const bytes = decodePayload(record.payloadBase64);
    const descriptor = descriptorsByRef.get(record.descriptorRef);
    const elementKind = elementKindByRef.get(record.artifact.ownerElementRef);
    payloadBytes += bytes?.byteLength ?? 0;
    if (
      bytes === undefined ||
      bytes.byteLength !== record.dimensions * 4 ||
      record.payloadDigest !== payloadDigest(bytes) ||
      record.artifact.artifactDigest !== record.payloadDigest ||
      descriptor?.dimensions !== record.dimensions ||
      elementKind === undefined ||
      !descriptor.elementKinds.includes(elementKind) ||
      !input.built.snapshot.policy.includeVisibilities.includes(record.visibility) ||
      !input.built.snapshot.policy.includeRedactionClasses.includes(record.redactionClass)
    )
      return yield* fail("stale_binding", "A vector payload is invalid or stale.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += 4)
      if (!Number.isFinite(view.getFloat32(offset, true)))
        return yield* fail("stale_binding", "A vector payload contains a non-finite value.");
  }
  for (const record of summaryRecords) {
    const bytes = decodePayload(record.payloadBase64);
    payloadBytes += bytes?.byteLength ?? 0;
    if (
      bytes === undefined ||
      record.payloadDigest !== payloadDigest(bytes) ||
      record.artifact.artifactDigest !== record.payloadDigest ||
      !input.built.snapshot.policy.includeVisibilities.includes(record.visibility) ||
      !input.built.snapshot.policy.includeRedactionClasses.includes(record.redactionClass)
    )
      return yield* fail("stale_binding", "A summary payload is invalid or stale.");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return yield* fail("stale_binding", "A summary payload is not valid UTF-8.");
    }
  }
  if (payloadBytes > GRAPH_ARCHIVE_MAX_PAYLOAD_BYTES)
    return yield* fail("oversized", "Portable payload bytes exceed the archive payload limit.");
  const expectedRankingArtifacts = rankingArtifactsFor(rankingSnapshots);
  if (
    canonicalJson(expectedRankingArtifacts) !==
    canonicalJson(input.artifactInventory?.rankingRefs ?? [])
  )
    return yield* fail("stale_binding", "Ranking artifacts do not match the archived snapshots.");
  const policyDigest = digest(input.built.snapshot.policy);
  if (
    input.contentExtension !== undefined &&
    (input.contentExtension.allowedVisibilities.some(
      (value) => !input.built.snapshot.policy.includeVisibilities.includes(value),
    ) ||
      input.contentExtension.allowedRedactionClasses.some(
        (value) => !input.built.snapshot.policy.includeRedactionClasses.includes(value),
      ) ||
      new Set(contentEntries.map((entry) => `${entry.elementRef}:${canonicalJson(entry.source)}`))
        .size !== contentEntries.length ||
      contentEntries.some(
        (entry) =>
          !known.has(entry.elementRef) ||
          entry.contentDigest !==
            contentEntryDigest({
              elementRef: entry.elementRef,
              source: entry.source,
              text: entry.text,
              visibility: entry.visibility,
              redactionClass: entry.redactionClass,
            }) ||
          !input.contentExtension!.allowedVisibilities.includes(entry.visibility) ||
          !input.contentExtension!.allowedRedactionClasses.includes(entry.redactionClass) ||
          !input.built.snapshot.policy.includeVisibilities.includes(entry.visibility) ||
          !input.built.snapshot.policy.includeRedactionClasses.includes(entry.redactionClass) ||
          ![
            ...input.built.snapshot.mentions,
            ...input.built.snapshot.entities,
            ...input.built.snapshot.relations,
          ]
            .find((item) => item.elementRef === entry.elementRef)
            ?.memberships.some(
              (item) => canonicalJson(item.source) === canonicalJson(entry.source),
            ),
      ))
  )
    return yield* fail("forbidden_content", "Content extension data exceeds the graph policy.");
  const inventory = input.artifactInventory;
  const graph = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.graph.v1" as const,
    graphRef: input.built.snapshot.graphRef,
    scopeRef: input.built.snapshot.scopeRef,
    graphDigest: input.built.snapshot.graphDigest,
    manifestDigest: input.built.manifest.manifestDigest,
    policy: input.built.snapshot.policy,
  });
  const nodes = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.nodes.v1" as const,
    mentions: input.built.snapshot.mentions,
    entities: input.built.snapshot.entities,
  });
  const edges = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.edges.v1" as const,
    relations: input.built.snapshot.relations,
  });
  const sourceMemberships = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.source_memberships.v1" as const,
    entries: [
      ...input.built.snapshot.mentions,
      ...input.built.snapshot.entities,
      ...input.built.snapshot.relations,
    ]
      .map(({ elementRef, memberships }) => ({ elementRef, memberships }))
      .sort((left, right) => compareCanonicalText(left.elementRef, right.elementRef)),
  });
  const mergeEvidence = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.merge_evidence.v1" as const,
    merges: input.built.snapshot.merges,
  });
  const provenance = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.provenance.v1" as const,
    entries: provenanceEntries(input.built),
    mergeEvidence: input.built.snapshot.merges,
  });
  const descriptors = withSectionDigest({
    schemaId: "openagents.ai.graph_archive.descriptors.v1" as const,
    descriptors: input.built.snapshot.embeddingProjections,
  });
  const vectors =
    inventory === undefined
      ? undefined
      : withSectionDigest({
          schemaId: "openagents.ai.graph_archive.vectors.v1" as const,
          records: [...vectorRecords].sort((left, right) =>
            compareCanonicalText(left.artifact.artifactRef, right.artifact.artifactRef),
          ),
          coverage: structuredClone(inventory.coverage.vectors),
        });
  const summaries =
    inventory === undefined
      ? undefined
      : withSectionDigest({
          schemaId: "openagents.ai.graph_archive.summaries.v1" as const,
          records: [...summaryRecords].sort((left, right) =>
            compareCanonicalText(left.artifact.artifactRef, right.artifact.artifactRef),
          ),
          coverage: structuredClone(inventory.coverage.summaries),
        });
  const ranking =
    inventory === undefined && rankingSnapshots.length === 0
      ? undefined
      : withSectionDigest({
          schemaId: "openagents.ai.graph_archive.ranking.v1" as const,
          artifacts: structuredClone(inventory?.rankingRefs ?? []),
          snapshots: [...structuredClone(rankingSnapshots)].sort((left, right) =>
            compareCanonicalText(left.snapshotRef, right.snapshotRef),
          ),
          coverage:
            inventory?.coverage.rankingRefs ??
            S.decodeUnknownSync(GraphArtifactPlaneCoverage)({
              _tag: "Incomplete" as const,
              gaps: [
                {
                  artifactKind: "ranking_ref" as const,
                  reason: "inventory_partial" as const,
                  evidenceRef: "archive.inventory.not-requested",
                },
              ],
            }),
        });
  const contentExtension =
    input.contentExtension === undefined
      ? undefined
      : withSectionDigest({
          schemaId: "openagents.ai.graph_archive.content_extension.v1" as const,
          authorizationRef: input.contentExtension.authorizationRef,
          authorityEvidenceRef: input.contentExtension.authorityEvidenceRef,
          graphRef: input.built.snapshot.graphRef,
          scopeRef: input.built.snapshot.scopeRef,
          graphDigest: input.built.snapshot.graphDigest,
          policyDigest,
          allowedVisibilities: [...new Set(input.contentExtension.allowedVisibilities)].sort(
            compareCanonicalText,
          ),
          allowedRedactionClasses: [
            ...new Set(input.contentExtension.allowedRedactionClasses),
          ].sort(compareCanonicalText),
          entries: [...structuredClone(contentEntries)].sort((left, right) =>
            compareCanonicalText(
              `${left.elementRef}:${canonicalJson(left.source)}`,
              `${right.elementRef}:${canonicalJson(right.source)}`,
            ),
          ),
        });
  const sections = deepFreeze({
    graph,
    nodes,
    edges,
    sourceMemberships,
    mergeEvidence,
    provenance,
    descriptors,
    ...(vectors === undefined ? {} : { vectors }),
    ...(summaries === undefined ? {} : { summaries }),
    ...(ranking === undefined ? {} : { ranking }),
    ...(contentExtension === undefined ? {} : { contentExtension }),
  });
  const sectionDigests = {
    graph: graph.sectionDigest,
    nodes: nodes.sectionDigest,
    edges: edges.sectionDigest,
    sourceMemberships: sourceMemberships.sectionDigest,
    mergeEvidence: mergeEvidence.sectionDigest,
    provenance: provenance.sectionDigest,
    descriptors: descriptors.sectionDigest,
    ...(vectors === undefined ? {} : { vectors: vectors.sectionDigest }),
    ...(summaries === undefined ? {} : { summaries: summaries.sectionDigest }),
    ...(ranking === undefined ? {} : { ranking: ranking.sectionDigest }),
    ...(contentExtension === undefined ? {} : { contentExtension: contentExtension.sectionDigest }),
  };
  const contentDigest = digest(sections);
  const manifestContent = {
    schemaId: "openagents.ai.graph_archive_manifest.v1" as const,
    formatVersion: GRAPH_ARCHIVE_FORMAT_VERSION,
    graphSchemaId: GRAPH_SCHEMA_ID,
    canonicalizationId: GRAPH_CANONICALIZATION_ID,
    graphRef: input.built.snapshot.graphRef,
    scopeRef: input.built.snapshot.scopeRef,
    graphDigest: input.built.snapshot.graphDigest,
    graphManifestDigest: input.built.manifest.manifestDigest,
    contentDigest,
    sectionDigests,
    coverage: {
      mentions: nodes.mentions.length,
      entities: nodes.entities.length,
      relations: edges.relations.length,
      merges: mergeEvidence.merges.length,
      descriptors: descriptors.descriptors.length,
      vectors: vectors?.records.length ?? 0,
      summaries: summaries?.records.length ?? 0,
      rankingArtifacts: ranking?.artifacts.length ?? 0,
      rankingSnapshots: ranking?.snapshots.length ?? 0,
      contentEntries: contentExtension?.entries.length ?? 0,
    },
    exclusions: exclusionsFor(sections),
    ordering: orderingFor(sections),
    provenanceRefs: provenanceRefs(input.built),
  };
  const manifestDigest = digest(manifestContent);
  const archive = S.decodeUnknownSync(GraphCorpusArchive)({
    schemaId: GRAPH_ARCHIVE_SCHEMA_ID,
    manifest: {
      ...manifestContent,
      manifestDigest,
      archiveRef: archiveRefFor(contentDigest, manifestDigest),
    },
    sections,
  });
  if (new TextEncoder().encode(canonicalJson(archive)).byteLength > GRAPH_ARCHIVE_MAX_BYTES)
    return yield* fail("oversized", "The graph archive exceeds its canonical byte limit.");
  return deepFreeze(archive);
});

export const encodeGraphCorpusArchive = Effect.fn("GraphCorpus.encodeArchive")(function* (
  input: ExportGraphCorpusArchiveInput,
) {
  const archive = yield* exportGraphCorpusArchive(input);
  const bytes = new TextEncoder().encode(canonicalJson(archive));
  if (bytes.byteLength > GRAPH_ARCHIVE_MAX_BYTES)
    return yield* fail("oversized", "The encoded graph archive exceeds its byte limit.");
  return bytes;
});

export interface ImportedGraphCorpusArchive {
  readonly archive: GraphCorpusArchive;
  readonly built: BuiltGraphCorpus;
  readonly artifactInventory?: GraphArtifactInventoryType;
  readonly rankingSnapshots: ReadonlyArray<GraphRankingSnapshot>;
  readonly contentExtension?: GraphArchiveContentExtensionSection;
}
export interface ImportGraphCorpusArchiveOptions {
  readonly contentAuthorization?: {
    readonly authorizationRef: string;
    readonly authorityEvidenceRef: string;
    readonly allowedVisibilities: ReadonlyArray<typeof RlmVisibility.Type>;
    readonly allowedRedactionClasses: ReadonlyArray<typeof RlmRedactionClass.Type>;
    readonly classifications: ReadonlyArray<
      Pick<GraphArchiveContentEntry, "elementRef" | "source" | "visibility" | "redactionClass">
    >;
  };
}

const parseArchive = (bytes: Uint8Array): Effect.Effect<unknown, GraphArchiveError> =>
  Effect.gen(function* () {
    if (bytes.byteLength > GRAPH_ARCHIVE_MAX_BYTES)
      return yield* fail("oversized", "The graph archive exceeds its byte limit.");
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => fail("invalid_utf8", "The graph archive is not valid UTF-8."),
    });
    const unknownValue = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => fail("invalid_json", "The graph archive is not valid JSON."),
    });
    if (typeof unknownValue !== "object" || unknownValue === null || Array.isArray(unknownValue))
      return yield* fail("migration_required", "The graph archive has no v1 object envelope.");
    {
      if (
        !("manifest" in unknownValue) ||
        typeof unknownValue.manifest !== "object" ||
        unknownValue.manifest === null ||
        !("formatVersion" in unknownValue.manifest)
      )
        return yield* fail("migration_required", "The graph archive has no v1 version header.");
      if (
        typeof unknownValue.manifest.formatVersion === "number" &&
        unknownValue.manifest.formatVersion !== GRAPH_ARCHIVE_FORMAT_VERSION
      )
        return yield* fail("unsupported_version", "The graph archive version is not supported.");
      if (
        ("graphSchemaId" in unknownValue.manifest &&
          typeof unknownValue.manifest.graphSchemaId === "string" &&
          unknownValue.manifest.graphSchemaId !== GRAPH_SCHEMA_ID) ||
        ("canonicalizationId" in unknownValue.manifest &&
          typeof unknownValue.manifest.canonicalizationId === "string" &&
          unknownValue.manifest.canonicalizationId !== GRAPH_CANONICALIZATION_ID)
      )
        return yield* fail(
          "unsupported_version",
          "The graph schema or canonicalization version is not supported.",
        );
    }
    return unknownValue;
  });

export const importGraphCorpusArchive = Effect.fn("GraphCorpus.importArchive")(function* (
  bytes: Uint8Array,
  options: ImportGraphCorpusArchiveOptions = {},
) {
  const unknownValue = yield* parseArchive(bytes);
  const decoded = S.decodeUnknownResult(GraphCorpusArchive)(unknownValue);
  if (Result.isFailure(decoded))
    return yield* fail("invalid_archive", "The graph archive does not match the v1 schema.");
  const archive = decoded.success;
  if (canonicalJson(archive) !== new TextDecoder().decode(bytes))
    return yield* fail("non_canonical", "The graph archive bytes are not canonical JSON.");
  const { manifestDigest, archiveRef, ...manifestContent } = archive.manifest;
  const sectionDigestMap = archive.manifest.sectionDigests;
  const sectionChecks = [
    archive.sections.graph.sectionDigest === sectionDigestMap.graph &&
      sectionValid(archive.sections.graph),
    archive.sections.nodes.sectionDigest === sectionDigestMap.nodes &&
      sectionValid(archive.sections.nodes),
    archive.sections.edges.sectionDigest === sectionDigestMap.edges &&
      sectionValid(archive.sections.edges),
    archive.sections.sourceMemberships.sectionDigest === sectionDigestMap.sourceMemberships &&
      sectionValid(archive.sections.sourceMemberships),
    archive.sections.mergeEvidence.sectionDigest === sectionDigestMap.mergeEvidence &&
      sectionValid(archive.sections.mergeEvidence),
    archive.sections.provenance.sectionDigest === sectionDigestMap.provenance &&
      sectionValid(archive.sections.provenance),
    archive.sections.descriptors.sectionDigest === sectionDigestMap.descriptors &&
      sectionValid(archive.sections.descriptors),
    archive.sections.vectors === undefined
      ? sectionDigestMap.vectors === undefined
      : archive.sections.vectors.sectionDigest === sectionDigestMap.vectors &&
        sectionValid(archive.sections.vectors),
    archive.sections.summaries === undefined
      ? sectionDigestMap.summaries === undefined
      : archive.sections.summaries.sectionDigest === sectionDigestMap.summaries &&
        sectionValid(archive.sections.summaries),
    archive.sections.ranking === undefined
      ? sectionDigestMap.ranking === undefined
      : archive.sections.ranking.sectionDigest === sectionDigestMap.ranking &&
        sectionValid(archive.sections.ranking),
    archive.sections.contentExtension === undefined
      ? sectionDigestMap.contentExtension === undefined
      : archive.sections.contentExtension.sectionDigest === sectionDigestMap.contentExtension &&
        sectionValid(archive.sections.contentExtension),
  ];
  if (
    sectionChecks.includes(false) ||
    archive.manifest.contentDigest !== digest(archive.sections) ||
    manifestDigest !== digest(manifestContent) ||
    archiveRef !== archiveRefFor(archive.manifest.contentDigest, manifestDigest)
  )
    return yield* fail("digest_mismatch", "An archive or section digest changed.");
  if (
    canonicalJson(archive.manifest.ordering) !== canonicalJson(orderingFor(archive.sections)) ||
    canonicalJson(archive.manifest.exclusions) !== canonicalJson(exclusionsFor(archive.sections)) ||
    archive.manifest.graphSchemaId !== GRAPH_SCHEMA_ID ||
    archive.manifest.canonicalizationId !== GRAPH_CANONICALIZATION_ID
  )
    return yield* fail("invalid_archive", "The archive ordering, exclusions, or schema changed.");
  const graph = archive.sections.graph;
  const built = yield* buildGraphCorpus({
    graphRef: graph.graphRef,
    scopeRef: graph.scopeRef,
    policy: graph.policy,
    mentions: archive.sections.nodes.mentions,
    entities: archive.sections.nodes.entities,
    relations: archive.sections.edges.relations,
    merges: archive.sections.mergeEvidence.merges,
    embeddingProjections: archive.sections.descriptors.descriptors,
  }).pipe(
    Effect.mapError(() => fail("reconstruction_failed", "The graph sections cannot rebuild.")),
  );
  if (
    built.snapshot.graphDigest !== graph.graphDigest ||
    built.manifest.manifestDigest !== graph.manifestDigest ||
    archive.manifest.graphRef !== built.snapshot.graphRef ||
    archive.manifest.scopeRef !== built.snapshot.scopeRef ||
    archive.manifest.graphDigest !== built.snapshot.graphDigest ||
    archive.manifest.graphManifestDigest !== built.manifest.manifestDigest ||
    canonicalJson(archive.sections.nodes.mentions) !== canonicalJson(built.snapshot.mentions) ||
    canonicalJson(archive.sections.nodes.entities) !== canonicalJson(built.snapshot.entities) ||
    canonicalJson(archive.sections.edges.relations) !== canonicalJson(built.snapshot.relations) ||
    canonicalJson(archive.sections.mergeEvidence.merges) !== canonicalJson(built.snapshot.merges) ||
    canonicalJson(archive.sections.descriptors.descriptors) !==
      canonicalJson(built.snapshot.embeddingProjections) ||
    canonicalJson(archive.sections.provenance.entries) !==
      canonicalJson(provenanceEntries(built)) ||
    canonicalJson(archive.sections.provenance.mergeEvidence) !==
      canonicalJson(built.snapshot.merges) ||
    canonicalJson(archive.sections.sourceMemberships.entries) !==
      canonicalJson(
        [...built.snapshot.mentions, ...built.snapshot.entities, ...built.snapshot.relations]
          .map(({ elementRef, memberships }) => ({ elementRef, memberships }))
          .sort((left, right) => compareCanonicalText(left.elementRef, right.elementRef)),
      ) ||
    canonicalJson(archive.manifest.provenanceRefs) !== canonicalJson(provenanceRefs(built))
  )
    return yield* fail("stale_binding", "The archive sections do not bind the rebuilt graph.");
  const ranking = archive.sections.ranking;
  const hasVectorPlane = archive.sections.vectors !== undefined;
  const hasSummaryPlane = archive.sections.summaries !== undefined;
  if (
    hasVectorPlane !== hasSummaryPlane ||
    ((hasVectorPlane || hasSummaryPlane) && ranking === undefined)
  )
    return yield* fail("invalid_archive", "Artifact inventory sections must be all present.");
  if (
    !payloadSectionsValid(
      built,
      archive.sections.vectors?.records ?? [],
      archive.sections.summaries?.records ?? [],
    ) ||
    (ranking !== undefined &&
      (canonicalJson(rankingArtifactsFor(ranking.snapshots)) !== canonicalJson(ranking.artifacts) ||
        canonicalJson(ranking.snapshots) !==
          canonicalJson(
            [...ranking.snapshots].sort((left, right) =>
              compareCanonicalText(left.snapshotRef, right.snapshotRef),
            ),
          ))) ||
    [
      archive.sections.vectors?.coverage,
      archive.sections.summaries?.coverage,
      ranking?.coverage,
    ].some(
      (coverage) =>
        coverage?._tag === "Incomplete" &&
        canonicalJson(coverage.gaps) !==
          canonicalJson(
            [...coverage.gaps].sort((left, right) =>
              compareCanonicalText(canonicalJson(left), canonicalJson(right)),
            ),
          ),
    )
  )
    return yield* fail("stale_binding", "Optional payload or ranking records are invalid.");
  const inventoryCandidate =
    archive.sections.vectors === undefined ||
    archive.sections.summaries === undefined ||
    ranking === undefined
      ? undefined
      : makeGraphArtifactInventory({
          built,
          vectors: archive.sections.vectors.records.map((item) => item.artifact),
          summaries: archive.sections.summaries.records.map((item) => item.artifact),
          rankingRefs: ranking.artifacts,
          coverage: {
            vectors: archive.sections.vectors.coverage,
            summaries: archive.sections.summaries.coverage,
            rankingRefs: ranking.coverage,
          },
        });
  const artifactInventory =
    inventoryCandidate === undefined
      ? undefined
      : S.decodeUnknownSync(GraphArtifactInventory)(inventoryCandidate);
  if (artifactInventory !== undefined) yield* validateArchiveInventory(built, artifactInventory);
  const known = new Set([
    ...built.snapshot.mentions.map((item) => item.elementRef),
    ...built.snapshot.entities.map((item) => item.elementRef),
    ...built.snapshot.relations.map((item) => item.elementRef),
  ]);
  for (const snapshot of ranking?.snapshots ?? [])
    yield* validateGraphRankingSnapshotIntegrity(snapshot).pipe(
      Effect.mapError(() => fail("stale_binding", "An archived ranking snapshot is invalid.")),
    );
  if ((ranking?.snapshots ?? []).some((snapshot) => !rankingSnapshotValid(snapshot, built, known)))
    return yield* fail("stale_binding", "An optional archive section is invalid or stale.");
  const contentExtension = archive.sections.contentExtension;
  const contentKeys =
    contentExtension?.entries.map(
      (entry) => `${entry.elementRef}:${canonicalJson(entry.source)}`,
    ) ?? [];
  if (
    contentExtension !== undefined &&
    (options.contentAuthorization === undefined ||
      contentExtension.authorizationRef !== options.contentAuthorization.authorizationRef ||
      contentExtension.authorityEvidenceRef !== options.contentAuthorization.authorityEvidenceRef ||
      canonicalJson(contentExtension.allowedVisibilities) !==
        canonicalJson(
          [...new Set(options.contentAuthorization.allowedVisibilities)].sort(compareCanonicalText),
        ) ||
      canonicalJson(contentExtension.allowedRedactionClasses) !==
        canonicalJson(
          [...new Set(options.contentAuthorization.allowedRedactionClasses)].sort(
            compareCanonicalText,
          ),
        ) ||
      canonicalJson(
        contentExtension.entries.map(({ elementRef, source, visibility, redactionClass }) => ({
          elementRef,
          source,
          visibility,
          redactionClass,
        })),
      ) !==
        canonicalJson(
          [...options.contentAuthorization.classifications].sort((left, right) =>
            compareCanonicalText(
              `${left.elementRef}:${canonicalJson(left.source)}`,
              `${right.elementRef}:${canonicalJson(right.source)}`,
            ),
          ),
        ) ||
      contentExtension.graphRef !== built.snapshot.graphRef ||
      contentExtension.scopeRef !== built.snapshot.scopeRef ||
      contentExtension.graphDigest !== built.snapshot.graphDigest ||
      contentExtension.policyDigest !== digest(built.snapshot.policy) ||
      contentExtension.allowedVisibilities.some(
        (value) => !built.snapshot.policy.includeVisibilities.includes(value),
      ) ||
      contentExtension.allowedRedactionClasses.some(
        (value) => !built.snapshot.policy.includeRedactionClasses.includes(value),
      ) ||
      new Set(contentKeys).size !== contentKeys.length ||
      canonicalJson(contentExtension.entries) !==
        canonicalJson(
          [...contentExtension.entries].sort((left, right) =>
            compareCanonicalText(
              `${left.elementRef}:${canonicalJson(left.source)}`,
              `${right.elementRef}:${canonicalJson(right.source)}`,
            ),
          ),
        ) ||
      contentExtension.entries.some(
        (entry) =>
          !known.has(entry.elementRef) ||
          entry.contentDigest !==
            contentEntryDigest({
              elementRef: entry.elementRef,
              source: entry.source,
              text: entry.text,
              visibility: entry.visibility,
              redactionClass: entry.redactionClass,
            }) ||
          !contentExtension.allowedVisibilities.includes(entry.visibility) ||
          !contentExtension.allowedRedactionClasses.includes(entry.redactionClass) ||
          !built.snapshot.policy.includeVisibilities.includes(entry.visibility) ||
          !built.snapshot.policy.includeRedactionClasses.includes(entry.redactionClass) ||
          ![...built.snapshot.mentions, ...built.snapshot.entities, ...built.snapshot.relations]
            .find((item) => item.elementRef === entry.elementRef)
            ?.memberships.some(
              (item) => canonicalJson(item.source) === canonicalJson(entry.source),
            ),
      ))
  )
    return yield* fail("forbidden_content", "The content extension is not policy-bound.");
  const expectedCoverage = {
    mentions: built.snapshot.mentions.length,
    entities: built.snapshot.entities.length,
    relations: built.snapshot.relations.length,
    merges: built.snapshot.merges.length,
    descriptors: built.snapshot.embeddingProjections.length,
    vectors: archive.sections.vectors?.records.length ?? 0,
    summaries: archive.sections.summaries?.records.length ?? 0,
    rankingArtifacts: ranking?.artifacts.length ?? 0,
    rankingSnapshots: ranking?.snapshots.length ?? 0,
    contentEntries: contentExtension?.entries.length ?? 0,
  };
  if (canonicalJson(expectedCoverage) !== canonicalJson(archive.manifest.coverage))
    return yield* fail("invalid_archive", "The archive coverage changed.");
  return deepFreeze({
    archive,
    built,
    ...(artifactInventory === undefined ? {} : { artifactInventory }),
    rankingSnapshots: ranking?.snapshots ?? [],
    ...(contentExtension === undefined ? {} : { contentExtension }),
  }) satisfies ImportedGraphCorpusArchive;
});
