import { Effect, Result, Schema as S } from "effect";
import {
  RlmCorpusDigest,
  RlmCorpusRef,
  RlmManifestDigest,
  RlmSourceAddress,
  RlmSourceLocator,
  type RlmCorpusEntry,
} from "@openagentsinc/rlm/schemas";

import { canonicalJson, compareCanonicalText, sha256Hex } from "./canonical.ts";
import {
  GraphDeleteRef,
  GraphArtifactInventory,
  GraphRankingArtifact,
  type GraphCompleteArtifactInventory,
  type GraphRankingArtifact as GraphRankingArtifactType,
} from "./deletion.ts";
import {
  GraphRlmObservation,
  GraphRlmHitCap,
  GraphRlmOperationResultSchema,
  GraphRlmRetrievalInventory,
  type GraphRlmProjection,
  type GraphRlmOperationResult,
} from "./rlm.ts";
import {
  GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
  GraphDescriptorRef,
  GraphDigest,
  GraphElementAddress,
  GraphElementRef,
  GraphRef,
  GraphScopeRef,
  graphDigest,
} from "./schemas.ts";
import { verifyBuiltGraphCorpus, type BuiltGraphCorpus } from "./builder.ts";

export const GRAPH_FEEDBACK_OBSERVATION_SCHEMA_ID =
  "openagents.ai.graph_feedback_observation.v1" as const;
export const GRAPH_RANKING_SNAPSHOT_SCHEMA_ID = "openagents.ai.graph_ranking_snapshot.v1" as const;
export const GRAPH_USED_ELEMENT_EVIDENCE_SCHEMA_ID =
  "openagents.ai.graph_used_element_evidence.v1" as const;
export const GRAPH_RANKING_OUTCOME_SCHEMA_ID = "openagents.ai.graph_ranking_outcome.v1" as const;
export const GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID =
  "openagents.ai.graph_ranking_operation_binding.v1" as const;
export const GRAPH_RANKING_ALGORITHM_VERSION =
  "openagents.ai.graph_ranking.feedback-confidence-relevance-ref.v1" as const;

const fixedMicros = S.Number.check(
  S.isInt(),
  S.makeFilter(Number.isSafeInteger, { description: "safe fixed-point integer" }),
  S.isGreaterThanOrEqualTo(-1_000_000_000),
  S.isLessThanOrEqualTo(1_000_000_000),
);
const safeInteger = S.Number.check(
  S.isInt(),
  S.makeFilter(Number.isSafeInteger, { description: "safe integer" }),
);
const operationBindingFields = {
  schemaId: S.Literal(GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID),
};
export const GraphRankingOperationBinding = S.Union([
  S.Struct({ ...operationBindingFields, _tag: S.Literal("Lookup"), elementRef: GraphElementRef }),
  S.Struct({
    ...operationBindingFields,
    _tag: S.Literal("Neighbors"),
    elementRef: GraphElementRef,
  }),
  S.Struct({
    ...operationBindingFields,
    _tag: S.Literal("ExpandSource"),
    source: RlmSourceLocator,
  }),
  S.Struct({
    ...operationBindingFields,
    _tag: S.Literal("TextSearch"),
    textQuery: S.String.check(S.isMinLength(1), S.isMaxLength(2_048)),
  }),
  S.Struct({
    ...operationBindingFields,
    _tag: S.Literal("VectorSearch"),
    descriptorRef: GraphDescriptorRef,
    vectorDigest: GraphDigest,
    artifactInventoryDigest: GraphDigest,
    retrievalDigest: GraphDigest,
  }),
  S.Struct({
    ...operationBindingFields,
    _tag: S.Literal("HybridSearch"),
    descriptorRef: GraphDescriptorRef,
    vectorDigest: GraphDigest,
    artifactInventoryDigest: GraphDigest,
    retrievalDigest: GraphDigest,
    textQuery: S.String.check(S.isMinLength(1), S.isMaxLength(2_048)),
  }),
]);
export type GraphRankingOperationBinding = typeof GraphRankingOperationBinding.Type;
export interface GraphRankingProviderContext {
  readonly inventory: GraphCompleteArtifactInventory;
  readonly retrievalInventory: GraphRlmRetrievalInventory;
}
const confidenceMicros = S.Number.check(
  S.isInt(),
  S.makeFilter(Number.isSafeInteger, { description: "safe confidence micro-units" }),
  S.isGreaterThanOrEqualTo(0),
  S.isLessThanOrEqualTo(1_000_000),
);

const rankingIdentityFields = {
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  corpusManifestDigest: RlmManifestDigest,
  classificationDigest: GraphDigest,
};

export const GraphFeedbackObservation = S.Struct({
  schemaId: S.Literal(GRAPH_FEEDBACK_OBSERVATION_SCHEMA_ID),
  ...rankingIdentityFields,
  observationRef: GraphDeleteRef,
  elementRef: GraphElementRef,
  feedbackWeightMicros: fixedMicros,
  evidenceRef: GraphDeleteRef,
  observationDigest: GraphDigest,
});
export type GraphFeedbackObservation = typeof GraphFeedbackObservation.Type;

export const GraphRankingConfidence = S.Struct({
  ...rankingIdentityFields,
  elementRef: GraphElementRef,
  confidenceMicros,
  evidenceRef: GraphDeleteRef,
});
export type GraphRankingConfidence = typeof GraphRankingConfidence.Type;

export const GraphRankingFeature = S.Struct({
  ...rankingIdentityFields,
  featureRef: GraphDeleteRef,
  elementRef: GraphElementRef,
  feedbackWeightMicros: fixedMicros,
  confidenceMicros: S.optionalKey(confidenceMicros),
  feedbackObservationRefs: S.Array(GraphDeleteRef).check(S.isMaxLength(10_000)),
  confidenceEvidenceRef: S.optionalKey(GraphDeleteRef),
  featureDigest: GraphDigest,
});
export type GraphRankingFeature = typeof GraphRankingFeature.Type;

export const GraphRankingSnapshot = S.Struct({
  schemaId: S.Literal(GRAPH_RANKING_SNAPSHOT_SCHEMA_ID),
  ...rankingIdentityFields,
  snapshotRef: GraphDeleteRef,
  algorithmVersion: S.Literal(GRAPH_RANKING_ALGORITHM_VERSION),
  feedbackObservations: S.Array(GraphFeedbackObservation).check(S.isMaxLength(10_000)),
  confidences: S.Array(GraphRankingConfidence).check(S.isMaxLength(10_000)),
  features: S.Array(GraphRankingFeature).check(S.isMaxLength(10_000)),
  snapshotDigest: GraphDigest,
});
export type GraphRankingSnapshot = typeof GraphRankingSnapshot.Type;

export const GraphUsedElement = S.Struct({
  elementRef: GraphElementRef,
  sourceAddress: RlmSourceAddress,
  supportingSources: S.Array(RlmSourceLocator).check(S.isMaxLength(10_000)),
  feedbackWeightMicros: fixedMicros,
  confidenceMicros: S.optionalKey(confidenceMicros),
  relevanceMicros: S.optionalKey(safeInteger),
});
export type GraphUsedElement = typeof GraphUsedElement.Type;

const degradationFields = {
  missingFeatureElementRefs: S.Array(GraphElementRef).check(S.isMaxLength(10_000)),
  missingConfidenceElementRefs: S.Array(GraphElementRef).check(S.isMaxLength(10_000)),
  missingRelevanceElementRefs: S.Array(GraphElementRef).check(S.isMaxLength(10_000)),
};

const usedEvidenceFields = {
  schemaId: S.Literal(GRAPH_USED_ELEMENT_EVIDENCE_SCHEMA_ID),
  ...rankingIdentityFields,
  evidenceRef: GraphDeleteRef,
  queryDigest: GraphDigest,
  operationDigest: GraphDigest,
  operationResultDigest: GraphDigest,
  limitsDigest: GraphDigest,
  operationStatus: S.Literals(["Complete", "Truncated"]),
  hitCaps: S.Array(GraphRlmHitCap).check(S.isMaxLength(6)),
  usedElements: S.Array(GraphUsedElement).check(S.isMaxLength(10_000)),
  ...degradationFields,
  evidenceDigest: GraphDigest,
};

export const GraphRankedUsedElementEvidence = S.Struct({
  ...usedEvidenceFields,
  _tag: S.Literal("Ranked"),
  rankingSnapshotDigest: GraphDigest,
  algorithmVersion: S.Literal(GRAPH_RANKING_ALGORITHM_VERSION),
  disabledReason: S.optionalKey(S.Never),
});
export type GraphRankedUsedElementEvidence = typeof GraphRankedUsedElementEvidence.Type;

export const GraphUnrankedUsedElementEvidence = S.Struct({
  ...usedEvidenceFields,
  _tag: S.Literal("Unranked"),
  disabledReason: S.Literals(["ranking_disabled", "operation_truncated"]),
  rankingSnapshotDigest: S.optionalKey(S.Never),
  algorithmVersion: S.optionalKey(S.Never),
});
export type GraphUnrankedUsedElementEvidence = typeof GraphUnrankedUsedElementEvidence.Type;

export const GraphUsedElementEvidence = S.Union([
  GraphRankedUsedElementEvidence,
  GraphUnrankedUsedElementEvidence,
]);
export type GraphUsedElementEvidence = typeof GraphUsedElementEvidence.Type;

const rankingOutcomeFields = {
  schemaId: S.Literal(GRAPH_RANKING_OUTCOME_SCHEMA_ID),
  observations: S.Array(GraphRlmObservation).check(S.isMaxLength(10_000)),
  evidence: GraphUsedElementEvidence,
  ...degradationFields,
};

export const GraphRankedOutcome = S.Struct({
  ...rankingOutcomeFields,
  _tag: S.Literal("Ranked"),
  rankingSnapshotDigest: GraphDigest,
  algorithmVersion: S.Literal(GRAPH_RANKING_ALGORITHM_VERSION),
  disabledReason: S.optionalKey(S.Never),
});
export type GraphRankedOutcome = typeof GraphRankedOutcome.Type;

export const GraphUnrankedOutcome = S.Struct({
  ...rankingOutcomeFields,
  _tag: S.Literal("Unranked"),
  disabledReason: S.Literals(["ranking_disabled", "operation_truncated"]),
  rankingSnapshotDigest: S.optionalKey(S.Never),
  algorithmVersion: S.optionalKey(S.Never),
});
export type GraphUnrankedOutcome = typeof GraphUnrankedOutcome.Type;

export const GraphRankingOutcome = S.Union([GraphRankedOutcome, GraphUnrankedOutcome]);
export type GraphRankingOutcome = typeof GraphRankingOutcome.Type;

export class GraphRankingError extends S.TaggedErrorClass<GraphRankingError>()(
  "GraphCorpus.RankingError",
  {
    reason: S.Literals([
      "invalid_graph",
      "invalid_result",
      "incomplete_result",
      "stale_graph",
      "unknown_element",
      "invalid_feedback",
      "invalid_snapshot",
      "invalid_evidence",
    ]),
    detailSafe: S.optionalKey(S.String.check(S.isMaxLength(512))),
  },
) {}

const digest = (value: unknown): GraphDigest => graphDigest(sha256Hex(canonicalJson(value)));
const ref = (prefix: string, value: unknown): GraphDeleteRef =>
  S.decodeUnknownSync(GraphDeleteRef)(`${prefix}.${digest(value)}`);
const canonicalRefs = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  [...new Set(values)].sort(compareCanonicalText);
const fail = (reason: GraphRankingError["reason"], detailSafe: string): GraphRankingError =>
  new GraphRankingError({ reason, detailSafe });
const freezeUnknown = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeUnknown(child);
  if (!Object.isFrozen(value)) Object.freeze(value);
};
const cloneFrozen = <A>(value: A): A => {
  const clone = structuredClone(value);
  freezeUnknown(clone);
  return clone;
};
const decodeResult = S.decodeUnknownResult(GraphRlmOperationResultSchema);
const decodeObservation = S.decodeUnknownResult(GraphFeedbackObservation);
const decodeSnapshot = S.decodeUnknownResult(GraphRankingSnapshot);
const decodeOutcome = S.decodeUnknownResult(GraphRankingOutcome);
const decodeEvidence = S.decodeUnknownResult(GraphUsedElementEvidence);
const decodeArtifact = S.decodeUnknownSync(GraphRankingArtifact);
const decodeElementRef = S.decodeUnknownResult(GraphElementRef);
const decodeDeleteRef = S.decodeUnknownResult(GraphDeleteRef);
const decodeOperationBinding = S.decodeUnknownResult(GraphRankingOperationBinding);

export const graphRankingQueryDigest = (binding: GraphRankingOperationBinding): GraphDigest =>
  digest({ domain: "openagents.ai.graph_ranking.query.v1", binding });

const sourceKey = (source: RlmSourceLocator): string => canonicalJson(source);
const elementSources = (
  element:
    | BuiltGraphCorpus["snapshot"]["mentions"][number]
    | BuiltGraphCorpus["snapshot"]["entities"][number]
    | BuiltGraphCorpus["snapshot"]["relations"][number],
): ReadonlyArray<RlmSourceLocator> =>
  [...new Map(element.memberships.map(({ source }) => [sourceKey(source), source])).values()].sort(
    (left, right) => compareCanonicalText(sourceKey(left), sourceKey(right)),
  );

const legacyRequest = (binding: GraphRankingOperationBinding): unknown => {
  switch (binding._tag) {
    case "Lookup":
      return { kind: "lookup", elementRef: binding.elementRef };
    case "Neighbors":
      return { kind: "neighbors", elementRef: binding.elementRef };
    case "ExpandSource":
      return { kind: "expand_source", source: binding.source };
    case "TextSearch":
      return { kind: "text_search", query: binding.textQuery };
    case "VectorSearch":
      return {
        kind: "vector_search",
        descriptorRef: binding.descriptorRef,
        vectorDigest: binding.vectorDigest,
        artifactInventoryDigest: binding.artifactInventoryDigest,
        retrievalDigest: binding.retrievalDigest,
      };
    case "HybridSearch":
      return {
        kind: "hybrid_search",
        descriptorRef: binding.descriptorRef,
        vectorDigest: binding.vectorDigest,
        artifactInventoryDigest: binding.artifactInventoryDigest,
        retrievalDigest: binding.retrievalDigest,
        textQuery: binding.textQuery,
      };
  }
};

type BuiltElement =
  | BuiltGraphCorpus["snapshot"]["mentions"][number]
  | BuiltGraphCorpus["snapshot"]["entities"][number]
  | BuiltGraphCorpus["snapshot"]["relations"][number];

const expectedGraphAddress = (
  built: BuiltGraphCorpus,
  element: BuiltElement,
): RlmSourceAddress => ({
  addressSchemaId: GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
  encodedAddress: canonicalJson(
    S.decodeUnknownSync(GraphElementAddress)({
      schemaId: GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
      graphRef: built.snapshot.graphRef,
      scopeRef: built.snapshot.scopeRef,
      graphDigest: built.snapshot.graphDigest,
      manifestDigest: built.manifest.manifestDigest,
      elementKind: element.elementKind,
      elementRef: element.elementRef,
    }),
  ),
});

const safeElementText = (element: BuiltElement): string =>
  element.elementKind === "relation"
    ? `${element.identity.canonicalKey}\n${element.relationKind}`
    : element.identity.canonicalKey;

const simulateEmission = (input: {
  readonly candidates: ReadonlyArray<BuiltElement>;
  readonly entries: ReadonlyMap<string, RlmCorpusEntry>;
  readonly limits: GraphRlmOperationResult["limits"];
  readonly initialCaps: ReadonlyArray<typeof GraphRlmHitCap.Type>;
  readonly scores?: ReadonlyMap<string, number>;
}) => {
  const observations: GraphRlmObservation[] = [];
  const caps = new Set(input.initialCaps);
  let sourceAddresses = 0;
  let observationCharacters = 0;
  for (const element of input.candidates) {
    if (observations.length >= input.limits.maxReturnedElements) {
      caps.add("max_returned_elements");
      break;
    }
    const entry = input.entries.get(element.elementRef);
    if (entry === undefined) continue;
    const sources = entry.supportingSources ?? [];
    const entrySourceAddressCount = 1 + sources.length;
    if (sourceAddresses + entrySourceAddressCount > input.limits.maxSourceAddresses) {
      caps.add("max_source_addresses");
      break;
    }
    const scoreMicros = input.scores?.get(element.elementRef);
    const baseObservation: GraphRlmObservation = {
      elementRef: element.elementRef,
      elementKind: element.elementKind,
      ...(entry.redactionClass === "none" ? { canonicalKey: element.identity.canonicalKey } : {}),
      ...(element.elementKind === "relation" && entry.redactionClass === "none"
        ? { relationKind: element.relationKind }
        : {}),
      ...(scoreMicros === undefined ? {} : { scoreMicros }),
      sourceAddress: entry.sourceAddress,
      supportingSources: sources,
    };
    let observation = baseObservation;
    const text = entry.redactionClass === "none" ? entry.text : undefined;
    if (text !== undefined) {
      const points = Array.from(text);
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const size = Array.from(
          canonicalJson({ ...baseObservation, text: points.slice(0, middle).join("") }),
        ).length;
        if (size <= input.limits.maxCharactersPerResult) low = middle;
        else high = middle - 1;
      }
      if (low < points.length) caps.add("max_characters_per_result");
      if (low > 0) observation = { ...baseObservation, text: points.slice(0, low).join("") };
    }
    const characters = Array.from(canonicalJson(observation)).length;
    if (characters > input.limits.maxCharactersPerResult) {
      caps.add("max_characters_per_result");
      break;
    }
    if (observationCharacters + characters > input.limits.maxObservationCharacters) {
      caps.add("max_observation_characters");
      break;
    }
    sourceAddresses += entrySourceAddressCount;
    observationCharacters += characters;
    observations.push(observation);
  }
  return {
    observations,
    sourceAddresses,
    observationCharacters,
    hitCaps: [...caps].sort(compareCanonicalText),
  };
};

/** Verify one unchanged #35 result against a separate exact #36 operation binding. */
export const verifyGraphRankingOperationResult = Effect.fn(
  "GraphCorpus.verifyRankingOperationResult",
)(function* (input: {
  readonly built: BuiltGraphCorpus;
  readonly projection: GraphRlmProjection;
  readonly result: GraphRlmOperationResult;
  readonly expectedOperationDigest: GraphDigest;
  readonly providerContext?: GraphRankingProviderContext;
  readonly binding: GraphRankingOperationBinding;
}) {
  yield* verifyBuiltGraphCorpus(input.built).pipe(
    Effect.mapError(() => fail("invalid_graph", "The graph snapshot or manifest is invalid.")),
  );
  const resultDecoded = decodeResult(input.result);
  const bindingDecoded = decodeOperationBinding(input.binding);
  if (Result.isFailure(resultDecoded) || Result.isFailure(bindingDecoded))
    return yield* fail("invalid_result", "The result or operation binding schema is invalid.");
  const result = resultDecoded.success;
  const binding = bindingDecoded.success;
  if (
    binding._tag === "TextSearch" &&
    binding.textQuery !== binding.textQuery.normalize("NFC").toLocaleLowerCase("en-US")
  )
    return yield* fail("invalid_result", "The text-search binding is not normalized.");
  const classification = input.projection.classification;
  const { projectionDigest, ...classificationContent } = classification;
  if (
    digest(classificationContent) !== projectionDigest ||
    result.graphDigest !== input.built.snapshot.graphDigest ||
    result.manifestDigest !== input.built.manifest.manifestDigest ||
    result.graphDigest !== classification.graphDigest ||
    result.manifestDigest !== classification.manifestDigest ||
    result.corpusRef !== input.projection.corpus.identity.corpusRef ||
    result.contentDigest !== input.projection.corpus.identity.contentDigest ||
    result.corpusManifestDigest !== input.projection.corpus.identity.manifestDigest ||
    result.classificationDigest !== projectionDigest
  )
    return yield* fail("stale_graph", "The result graph or RLM projection identity changed.");
  yield* input.projection.corpus
    .assertUnchanged()
    .pipe(Effect.mapError(() => fail("stale_graph", "The projected RLM corpus changed.")));
  const projectedEntries = yield* input.projection.corpus
    .materializeAll()
    .pipe(Effect.mapError(() => fail("stale_graph", "The projected RLM corpus is unavailable.")));
  const entries = new Map(projectedEntries.map((entry) => [entry.entryRef, entry]));
  const supportingCorpora = classification.supportingCorpora
    .map(({ identity }) => identity)
    .sort((left, right) => compareCanonicalText(canonicalJson(left), canonicalJson(right)));
  const projectionBinding = {
    corpus: input.projection.corpus.identity,
    classificationDigest: projectionDigest,
    supportingCorpora,
  };
  const { operationDigest } = result;
  const computedOperationDigest = digest({
    operation: { projectionBinding, request: legacyRequest(binding) },
    limits: result.limits,
    graphDigest: result.graphDigest,
    manifestDigest: result.manifestDigest,
    corpusRef: result.corpusRef,
    contentDigest: result.contentDigest,
    corpusManifestDigest: result.corpusManifestDigest,
    classificationDigest: result.classificationDigest,
    visitedElements: result.visitedElements,
    sourceAddresses: result.sourceAddresses,
    observationCharacters: result.observationCharacters,
    observations: result.observations,
    hitCaps: result.hitCaps,
  });
  if (
    operationDigest !== input.expectedOperationDigest ||
    operationDigest !== computedOperationDigest
  )
    return yield* fail("invalid_result", "The #35 operation receipt digest changed.");

  const graphElements = [
    ...input.built.snapshot.mentions,
    ...input.built.snapshot.entities,
    ...input.built.snapshot.relations,
  ];
  const elements = new Map<string, (typeof graphElements)[number]>(
    graphElements.map((element) => [element.elementRef, element]),
  );
  const classifications = new Map(
    classification.classifications.map((item) => [item.elementRef, item]),
  );
  const seen = new Set<string>();
  let sourceAddresses = 0;
  let observationCharacters = 0;
  for (const observation of result.observations) {
    const element = elements.get(observation.elementRef);
    const entry = entries.get(observation.elementRef);
    const elementClassification = classifications.get(observation.elementRef);
    if (
      element === undefined ||
      entry === undefined ||
      elementClassification === undefined ||
      seen.has(observation.elementRef) ||
      element.elementKind !== observation.elementKind
    )
      return yield* fail("invalid_result", "A result element ref or kind is invalid.");
    seen.add(observation.elementRef);
    const expectedAddress = expectedGraphAddress(input.built, element);
    if (
      entry.entryRef !== element.elementRef ||
      entry.scopeRef !== input.built.snapshot.scopeRef ||
      entry.sourcePlane !== "derived_graph" ||
      entry.sourceKind !== `graph_${element.elementKind}` ||
      entry.text !== safeElementText(element) ||
      entry.visibility !== elementClassification.visibility ||
      entry.redactionClass !== elementClassification.redactionClass ||
      canonicalJson(entry.sourceAddress) !== canonicalJson(expectedAddress) ||
      canonicalJson(entry.supportingSources ?? []) !== canonicalJson(elementSources(element)) ||
      canonicalJson(observation.sourceAddress) !== canonicalJson(expectedAddress) ||
      canonicalJson(observation.supportingSources) !== canonicalJson(elementSources(element)) ||
      (observation.canonicalKey !== undefined &&
        observation.canonicalKey !== element.identity.canonicalKey) ||
      (observation.relationKind !== undefined &&
        (element.elementKind !== "relation" || observation.relationKind !== element.relationKind))
    )
      return yield* fail("invalid_result", "Result graph-address or source support changed.");
    sourceAddresses += 1 + observation.supportingSources.length;
    observationCharacters += Array.from(canonicalJson(observation)).length;
  }
  const sortedElements = [...elements.values()].sort((left, right) =>
    compareCanonicalText(left.elementRef, right.elementRef),
  );
  let deterministicCandidates: ReadonlyArray<BuiltElement> | undefined;
  let deterministicVisited = 0;
  let deterministicCaps: ReadonlyArray<typeof GraphRlmHitCap.Type> = [];
  if (binding._tag === "Lookup") {
    const element = elements.get(binding.elementRef);
    if (element === undefined)
      return yield* fail("invalid_result", "The lookup binding element is absent.");
    deterministicCandidates = [element];
    deterministicVisited = 1;
  }
  if (binding._tag === "ExpandSource") {
    const key = sourceKey(binding.source);
    const candidates: BuiltElement[] = [];
    for (const element of sortedElements) {
      if (deterministicVisited >= result.limits.maxVisitedElements) break;
      deterministicVisited += 1;
      if (elementSources(element).some((source) => sourceKey(source) === key)) {
        candidates.push(element);
      }
    }
    deterministicCandidates = candidates;
    deterministicCaps =
      deterministicVisited < sortedElements.length ? ["max_visited_elements"] : [];
  }
  if (binding._tag === "TextSearch") {
    const candidates: BuiltElement[] = [];
    for (const element of sortedElements) {
      if (deterministicVisited >= result.limits.maxVisitedElements) break;
      deterministicVisited += 1;
      const fields =
        element.elementKind === "relation"
          ? [element.identity.canonicalKey, element.relationKind]
          : [element.identity.canonicalKey];
      if (fields.some((field) => field.toLocaleLowerCase("en-US").includes(binding.textQuery))) {
        candidates.push(element);
      }
    }
    deterministicCandidates = candidates;
    deterministicCaps =
      deterministicVisited < sortedElements.length ? ["max_visited_elements"] : [];
  }
  if (binding._tag === "Neighbors") {
    const mentions = new Map(input.built.snapshot.mentions.map((item) => [item.mentionRef, item]));
    const entities = new Map(input.built.snapshot.entities.map((item) => [item.entityRef, item]));
    const adjacent = new Map<string, Set<string>>(
      [...elements.keys()].map((elementRef) => [elementRef, new Set<string>()]),
    );
    for (const entity of input.built.snapshot.entities) {
      for (const mentionRef of entity.mentionRefs) {
        const mention = mentions.get(mentionRef);
        if (mention !== undefined) {
          adjacent.get(entity.elementRef)?.add(mention.elementRef);
          adjacent.get(mention.elementRef)?.add(entity.elementRef);
        }
      }
    }
    for (const relation of input.built.snapshot.relations) {
      for (const entityRef of [relation.fromEntityRef, relation.toEntityRef]) {
        const entity = entities.get(entityRef);
        if (entity !== undefined) {
          adjacent.get(relation.elementRef)?.add(entity.elementRef);
          adjacent.get(entity.elementRef)?.add(relation.elementRef);
        }
      }
    }
    const queue: Array<{ readonly ref: string; readonly depth: number }> = [
      { ref: binding.elementRef, depth: 0 },
    ];
    const visited = new Set<string>([binding.elementRef]);
    const found: BuiltElement[] = [];
    const caps = new Set<typeof GraphRlmHitCap.Type>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      const element = elements.get(current.ref);
      if (element !== undefined) found.push(element);
      const nextRefs = [...(adjacent.get(current.ref) ?? [])].sort(compareCanonicalText);
      if (current.depth >= result.limits.maxDepth) {
        if (nextRefs.some((ref) => !visited.has(ref))) caps.add("max_depth");
        continue;
      }
      for (const next of nextRefs) {
        if (visited.has(next)) continue;
        if (visited.size >= result.limits.maxVisitedElements) {
          caps.add("max_visited_elements");
          break;
        }
        visited.add(next);
        queue.push({ ref: next, depth: current.depth + 1 });
      }
    }
    deterministicCandidates = found;
    deterministicVisited = visited.size;
    deterministicCaps = [...caps];
  }
  if (deterministicCandidates !== undefined) {
    const expected = simulateEmission({
      candidates: deterministicCandidates,
      entries,
      limits: result.limits,
      initialCaps: deterministicCaps,
    });
    const expectedTag = expected.hitCaps.length === 0 ? "Complete" : "Truncated";
    if (
      result._tag !== expectedTag ||
      result.visitedElements !== deterministicVisited ||
      result.sourceAddresses !== expected.sourceAddresses ||
      result.observationCharacters !== expected.observationCharacters ||
      canonicalJson(result.observations) !== canonicalJson(expected.observations) ||
      canonicalJson(result.hitCaps) !== canonicalJson(expected.hitCaps)
    )
      return yield* fail(
        "invalid_result",
        "Deterministic result execution or cap evidence changed.",
      );
  }
  const providerSearch = binding._tag === "VectorSearch" || binding._tag === "HybridSearch";
  const descriptorRef = providerSearch ? binding.descriptorRef : undefined;
  if (providerSearch) {
    const context = input.providerContext;
    const inventoryDecoded = S.decodeUnknownResult(GraphArtifactInventory)(context?.inventory);
    const retrievalDecoded = S.decodeUnknownResult(GraphRlmRetrievalInventory)(
      context?.retrievalInventory,
    );
    if (
      context === undefined ||
      Result.isFailure(inventoryDecoded) ||
      Result.isFailure(retrievalDecoded) ||
      inventoryDecoded.success._tag !== "Complete" ||
      inventoryDecoded.success.coverage.vectors._tag !== "Complete" ||
      retrievalDecoded.success._tag !== "Complete"
    )
      return yield* fail("invalid_result", "Provider retrieval context is absent or incomplete.");
    const inventory = inventoryDecoded.success;
    const retrieval = retrievalDecoded.success;
    const { inventoryDigest, ...inventoryContent } = inventory;
    const { retrievalDigest, ...retrievalContent } = retrieval;
    const descriptor = input.built.snapshot.embeddingProjections.find(
      (item) => item.descriptorRef === binding.descriptorRef,
    );
    const allowedBindings = retrieval.bindings.filter(
      (item) => item.descriptorRef === binding.descriptorRef,
    );
    const allowedOwners = new Set(allowedBindings.map((item) => item.ownerElementRef));
    const vectors = new Map<string, (typeof inventory.vectors)[number]>(
      inventory.vectors.map((item) => [item.artifactRef, item]),
    );
    const retrievalBindingsValid = retrieval.bindings.every((item) => {
      const vector = vectors.get(item.artifactRef);
      const owner = elements.get(item.ownerElementRef);
      const itemDescriptor = input.built.snapshot.embeddingProjections.find(
        (candidate) => candidate.descriptorRef === item.descriptorRef,
      );
      return (
        vector?.ownerElementRef === item.ownerElementRef &&
        owner !== undefined &&
        itemDescriptor !== undefined &&
        itemDescriptor.projectionSchemaId === item.projectionSchemaId &&
        itemDescriptor.dimensions === item.dimensions &&
        itemDescriptor.elementKinds.includes(owner.elementKind)
      );
    });
    if (
      digest(inventoryContent) !== inventoryDigest ||
      digest(retrievalContent) !== retrievalDigest ||
      inventoryDigest !== binding.artifactInventoryDigest ||
      retrievalDigest !== binding.retrievalDigest ||
      inventory.graphDigest !== result.graphDigest ||
      inventory.manifestDigest !== result.manifestDigest ||
      retrieval.graphDigest !== result.graphDigest ||
      retrieval.manifestDigest !== result.manifestDigest ||
      retrieval.artifactInventoryDigest !== inventoryDigest ||
      retrieval.bindings.length !== inventory.vectors.length ||
      new Set(retrieval.bindings.map((item) => item.artifactRef)).size !==
        retrieval.bindings.length ||
      !retrievalBindingsValid ||
      descriptor === undefined ||
      allowedBindings.length === 0 ||
      result.observations.some(
        (item) =>
          !allowedOwners.has(item.elementRef) ||
          !descriptor.elementKinds.includes(item.elementKind),
      )
    )
      return yield* fail("invalid_result", "Provider descriptor or retrieval binding changed.");
    const providerCandidates = result.observations.flatMap((observation) => {
      const element = elements.get(observation.elementRef);
      return element === undefined ? [] : [element];
    });
    const providerScores = new Map(
      result.observations.flatMap((observation) =>
        observation.scoreMicros === undefined
          ? []
          : [[observation.elementRef, observation.scoreMicros] as const],
      ),
    );
    const emitted = simulateEmission({
      candidates: providerCandidates,
      entries,
      limits: result.limits,
      initialCaps: [],
      scores: providerScores,
    });
    if (
      canonicalJson(emitted.observations) !== canonicalJson(result.observations) ||
      emitted.sourceAddresses !== result.sourceAddresses ||
      emitted.observationCharacters !== result.observationCharacters
    )
      return yield* fail("invalid_result", "Provider projected observations changed.");
  } else if (input.providerContext !== undefined) {
    return yield* fail("invalid_result", "A deterministic operation has provider-only context.");
  }
  if (
    result.observations.some((item) =>
      providerSearch ? item.scoreMicros === undefined : item.scoreMicros !== undefined,
    ) ||
    (descriptorRef !== undefined &&
      !input.built.snapshot.embeddingProjections.some(
        (descriptor) => descriptor.descriptorRef === descriptorRef,
      )) ||
    sourceAddresses !== result.sourceAddresses ||
    observationCharacters !== result.observationCharacters ||
    result.observations.length > result.limits.maxReturnedElements ||
    result.visitedElements < result.observations.length ||
    result.visitedElements > result.limits.maxVisitedElements ||
    canonicalJson(result.hitCaps) !==
      canonicalJson([...new Set(result.hitCaps)].sort(compareCanonicalText))
  )
    return yield* fail("invalid_result", "Result scores, counters, or caps changed.");
  return cloneFrozen(result);
});

const identityFrom = (built: BuiltGraphCorpus, result: GraphRlmOperationResult) => ({
  graphRef: built.snapshot.graphRef,
  scopeRef: built.snapshot.scopeRef,
  graphDigest: result.graphDigest,
  manifestDigest: result.manifestDigest,
  corpusRef: result.corpusRef,
  contentDigest: result.contentDigest,
  corpusManifestDigest: result.corpusManifestDigest,
  classificationDigest: result.classificationDigest,
});

interface RankingIdentityLike {
  readonly graphRef: string;
  readonly scopeRef: string;
  readonly graphDigest: string;
  readonly manifestDigest: string;
  readonly corpusRef: string;
  readonly contentDigest: string;
  readonly corpusManifestDigest: string;
  readonly classificationDigest: string;
}

const sameIdentity = (left: RankingIdentityLike, right: ReturnType<typeof identityFrom>): boolean =>
  left.graphRef === right.graphRef &&
  left.scopeRef === right.scopeRef &&
  left.graphDigest === right.graphDigest &&
  left.manifestDigest === right.manifestDigest &&
  left.corpusRef === right.corpusRef &&
  left.contentDigest === right.contentDigest &&
  left.corpusManifestDigest === right.corpusManifestDigest &&
  left.classificationDigest === right.classificationDigest;

const validateCompleteResult = (
  result: GraphRlmOperationResult,
): Effect.Effect<
  Extract<GraphRlmOperationResult, { readonly _tag: "Complete" }>,
  GraphRankingError
> =>
  Effect.gen(function* () {
    const decoded = decodeResult(result);
    if (Result.isFailure(decoded))
      return yield* fail("invalid_result", "The graph operation result does not match its schema.");
    if (decoded.success._tag !== "Complete")
      return yield* fail("incomplete_result", "A truncated graph result cannot be ranked.");
    const refs = decoded.success.observations.map((item) => item.elementRef);
    if (new Set(refs).size !== refs.length)
      return yield* fail("invalid_result", "The graph result contains duplicate element refs.");
    return decoded.success;
  });

const validateAuthenticResult = (input: {
  readonly built: BuiltGraphCorpus;
  readonly projection: GraphRlmProjection;
  readonly result: GraphRlmOperationResult;
  readonly expectedOperationDigest: GraphDigest;
  readonly providerContext?: GraphRankingProviderContext;
  readonly binding: GraphRankingOperationBinding;
}): Effect.Effect<GraphRlmOperationResult, GraphRankingError> =>
  verifyGraphRankingOperationResult(input);

const feedbackContent = (
  value: Omit<GraphFeedbackObservation, "observationRef" | "observationDigest">,
) => value;

export const makeGraphFeedbackObservation = Effect.fn("GraphCorpus.makeGraphFeedbackObservation")(
  function* (input: {
    readonly built: BuiltGraphCorpus;
    readonly projection: GraphRlmProjection;
    readonly result: GraphRlmOperationResult;
    readonly expectedOperationDigest: GraphDigest;
    readonly providerContext?: GraphRankingProviderContext;
    readonly binding: GraphRankingOperationBinding;
    readonly elementRef: string;
    readonly feedbackWeightMicros: number;
    readonly evidenceRef: string;
  }) {
    const authentic = yield* validateAuthenticResult(input);
    const result = yield* validateCompleteResult(authentic);
    const known = new Set<string>([
      ...input.built.snapshot.mentions.map((item) => item.elementRef),
      ...input.built.snapshot.entities.map((item) => item.elementRef),
      ...input.built.snapshot.relations.map((item) => item.elementRef),
    ]);
    if (!known.has(input.elementRef))
      return yield* fail("unknown_element", "Feedback names an element outside the exact graph.");
    const elementRef = decodeElementRef(input.elementRef);
    const evidenceRef = decodeDeleteRef(input.evidenceRef);
    if (Result.isFailure(elementRef) || Result.isFailure(evidenceRef))
      return yield* fail("invalid_feedback", "Feedback refs do not match their schemas.");
    const content: Omit<GraphFeedbackObservation, "observationRef" | "observationDigest"> = {
      schemaId: GRAPH_FEEDBACK_OBSERVATION_SCHEMA_ID,
      ...identityFrom(input.built, result),
      elementRef: elementRef.success,
      feedbackWeightMicros: input.feedbackWeightMicros,
      evidenceRef: evidenceRef.success,
    };
    const observationDigest = digest(feedbackContent(content));
    const decoded = decodeObservation({
      ...content,
      observationRef: ref("feedback", content),
      observationDigest,
    });
    if (Result.isFailure(decoded))
      return yield* fail("invalid_feedback", "The feedback observation is invalid or unbounded.");
    return cloneFrozen(decoded.success);
  },
);

const observationValid = (value: GraphFeedbackObservation): boolean => {
  const { observationRef, observationDigest, ...content } = value;
  return (
    observationDigest === digest(feedbackContent(content)) &&
    observationRef === ref("feedback", content)
  );
};

const featureContent = (value: Omit<GraphRankingFeature, "featureRef" | "featureDigest">) => value;

const buildFeatures = (
  identity: ReturnType<typeof identityFrom>,
  observations: ReadonlyArray<GraphFeedbackObservation>,
  confidences: ReadonlyArray<GraphRankingConfidence>,
): Effect.Effect<ReadonlyArray<GraphRankingFeature>, GraphRankingError> =>
  Effect.gen(function* () {
    const confidenceByRef = new Map(confidences.map((item) => [item.elementRef, item]));
    if (confidenceByRef.size !== confidences.length)
      return yield* fail("invalid_feedback", "Confidence input contains a duplicate element ref.");
    const refs = canonicalRefs([
      ...observations.map((item) => item.elementRef),
      ...confidences.map((item) => item.elementRef),
    ]);
    const features: GraphRankingFeature[] = [];
    for (const elementRef of refs) {
      const feedback = observations.filter((item) => item.elementRef === elementRef);
      let feedbackWeight = 0n;
      for (const item of feedback) {
        feedbackWeight += BigInt(item.feedbackWeightMicros);
        if (feedbackWeight < -1_000_000_000n || feedbackWeight > 1_000_000_000n)
          return yield* fail("invalid_feedback", "Aggregated feedback exceeds fixed-point bounds.");
      }
      const feedbackWeightMicros = Number(feedbackWeight);
      if (!Number.isSafeInteger(feedbackWeightMicros))
        return yield* fail("invalid_feedback", "Aggregated feedback exceeds fixed-point bounds.");
      const confidence = confidenceByRef.get(elementRef);
      const content = {
        ...identity,
        elementRef,
        feedbackWeightMicros,
        ...(confidence === undefined ? {} : { confidenceMicros: confidence.confidenceMicros }),
        feedbackObservationRefs: canonicalRefs(feedback.map((item) => item.observationRef)),
        ...(confidence === undefined ? {} : { confidenceEvidenceRef: confidence.evidenceRef }),
      };
      const featureDigest = digest(featureContent(content));
      const candidate = {
        ...content,
        featureRef: ref("ranking-feature", content),
        featureDigest,
      };
      const decoded = S.decodeUnknownResult(GraphRankingFeature)(candidate);
      if (Result.isFailure(decoded))
        return yield* fail("invalid_feedback", "A ranking feature is invalid.");
      features.push(decoded.success);
    }
    return features;
  });

const snapshotContent = (value: Omit<GraphRankingSnapshot, "snapshotRef" | "snapshotDigest">) =>
  value;

export const makeGraphRankingSnapshot = Effect.fn("GraphCorpus.makeGraphRankingSnapshot")(
  function* (input: {
    readonly built: BuiltGraphCorpus;
    readonly projection: GraphRlmProjection;
    readonly result: GraphRlmOperationResult;
    readonly expectedOperationDigest: GraphDigest;
    readonly providerContext?: GraphRankingProviderContext;
    readonly binding: GraphRankingOperationBinding;
    readonly feedbackObservations?: ReadonlyArray<GraphFeedbackObservation>;
    readonly confidences?: ReadonlyArray<GraphRankingConfidence>;
  }) {
    const authentic = yield* validateAuthenticResult(input);
    const result = yield* validateCompleteResult(authentic);
    const identity = identityFrom(input.built, result);
    const known = new Set<string>([
      ...input.built.snapshot.mentions.map((item) => item.elementRef),
      ...input.built.snapshot.entities.map((item) => item.elementRef),
      ...input.built.snapshot.relations.map((item) => item.elementRef),
    ]);
    if (
      (input.feedbackObservations?.length ?? 0) > 10_000 ||
      (input.confidences?.length ?? 0) > 10_000
    )
      return yield* fail("invalid_feedback", "Ranking inputs exceed the snapshot array bound.");
    const feedbackObservations = [...(input.feedbackObservations ?? [])].sort((left, right) =>
      compareCanonicalText(left.observationRef, right.observationRef),
    );
    if (
      new Set(feedbackObservations.map((item) => item.observationRef)).size !==
        feedbackObservations.length ||
      new Set(feedbackObservations.map((item) => item.evidenceRef)).size !==
        feedbackObservations.length
    )
      return yield* fail(
        "invalid_feedback",
        "Feedback contains a duplicate observation or evidence ref.",
      );
    for (const observation of feedbackObservations) {
      if (!observationValid(observation) || !sameIdentity(observation, identity))
        return yield* fail("invalid_feedback", "Feedback identity or digest is invalid.");
      if (!known.has(observation.elementRef))
        return yield* fail("unknown_element", "Feedback names an unknown graph element.");
    }
    const confidences = [...(input.confidences ?? [])].sort((left, right) =>
      compareCanonicalText(left.elementRef, right.elementRef),
    );
    for (const confidence of confidences) {
      const decoded = S.decodeUnknownResult(GraphRankingConfidence)(confidence);
      if (
        Result.isFailure(decoded) ||
        !sameIdentity(confidence, identity) ||
        !known.has(confidence.elementRef)
      )
        return yield* fail("invalid_feedback", "Confidence input is invalid or stale.");
    }
    const features = yield* buildFeatures(identity, feedbackObservations, confidences);
    const content = {
      schemaId: GRAPH_RANKING_SNAPSHOT_SCHEMA_ID,
      ...identity,
      algorithmVersion: GRAPH_RANKING_ALGORITHM_VERSION,
      feedbackObservations,
      confidences,
      features,
    };
    const snapshotDigest = digest(snapshotContent(content));
    const decoded = decodeSnapshot({
      ...content,
      snapshotRef: ref("ranking-snapshot", content),
      snapshotDigest,
    });
    if (Result.isFailure(decoded))
      return yield* fail("invalid_snapshot", "The ranking snapshot does not match its schema.");
    return cloneFrozen(decoded.success);
  },
);

export const validateGraphRankingSnapshotIntegrity = (
  snapshot: GraphRankingSnapshot,
): Effect.Effect<void, GraphRankingError> =>
  Effect.gen(function* () {
    const decoded = decodeSnapshot(snapshot);
    if (Result.isFailure(decoded))
      return yield* fail("invalid_snapshot", "The ranking snapshot does not match its schema.");
    const { snapshotRef, snapshotDigest, ...content } = decoded.success;
    if (
      snapshotDigest !== digest(snapshotContent(content)) ||
      snapshotRef !== ref("ranking-snapshot", content) ||
      canonicalJson(decoded.success.feedbackObservations) !==
        canonicalJson(
          [...decoded.success.feedbackObservations].sort((left, right) =>
            compareCanonicalText(left.observationRef, right.observationRef),
          ),
        ) ||
      canonicalJson(decoded.success.confidences) !==
        canonicalJson(
          [...decoded.success.confidences].sort((left, right) =>
            compareCanonicalText(left.elementRef, right.elementRef),
          ),
        ) ||
      new Set(decoded.success.feedbackObservations.map((item) => item.observationRef)).size !==
        decoded.success.feedbackObservations.length ||
      new Set(decoded.success.feedbackObservations.map((item) => item.evidenceRef)).size !==
        decoded.success.feedbackObservations.length ||
      decoded.success.feedbackObservations.some((item) => !observationValid(item))
    )
      return yield* fail("invalid_snapshot", "The ranking snapshot digest or ordering changed.");
    const identity = {
      graphRef: decoded.success.graphRef,
      scopeRef: decoded.success.scopeRef,
      graphDigest: decoded.success.graphDigest,
      manifestDigest: decoded.success.manifestDigest,
      corpusRef: decoded.success.corpusRef,
      contentDigest: decoded.success.contentDigest,
      corpusManifestDigest: decoded.success.corpusManifestDigest,
      classificationDigest: decoded.success.classificationDigest,
    };
    if (
      decoded.success.feedbackObservations.some((item) => !sameIdentity(item, identity)) ||
      decoded.success.confidences.some((item) => !sameIdentity(item, identity))
    )
      return yield* fail("invalid_snapshot", "A snapshot child has a different identity.");
    const expected = yield* buildFeatures(
      identity,
      decoded.success.feedbackObservations,
      decoded.success.confidences,
    ).pipe(Effect.mapError(() => fail("invalid_snapshot", "Snapshot feature inputs are invalid.")));
    if (canonicalJson(expected) !== canonicalJson(decoded.success.features))
      return yield* fail("invalid_snapshot", "Snapshot features do not match their evidence.");
  });

export const validateGraphRankingSnapshot = Effect.fn("GraphCorpus.validateGraphRankingSnapshot")(
  function* (
    snapshot: GraphRankingSnapshot,
    context: {
      readonly built: BuiltGraphCorpus;
      readonly projection: GraphRlmProjection;
      readonly result: GraphRlmOperationResult;
      readonly expectedOperationDigest: GraphDigest;
      readonly providerContext?: GraphRankingProviderContext;
      readonly binding: GraphRankingOperationBinding;
    },
  ) {
    const authentic = yield* validateAuthenticResult(context);
    const result = yield* validateCompleteResult(authentic);
    yield* validateGraphRankingSnapshotIntegrity(snapshot);
    if (!sameIdentity(snapshot, identityFrom(context.built, result)))
      return yield* fail(
        "stale_graph",
        "The ranking snapshot targets another graph or RLM corpus.",
      );
    const known = new Set<string>([
      ...context.built.snapshot.mentions.map((item) => item.elementRef),
      ...context.built.snapshot.entities.map((item) => item.elementRef),
      ...context.built.snapshot.relations.map((item) => item.elementRef),
    ]);
    if (snapshot.features.some((item) => !known.has(item.elementRef)))
      return yield* fail("unknown_element", "The ranking snapshot contains an unknown element.");
  },
);

const makeUsedElement = (
  observation: GraphRlmObservation,
  feature: GraphRankingFeature | undefined,
): Effect.Effect<GraphUsedElement, GraphRankingError> => {
  const decoded = S.decodeUnknownResult(GraphUsedElement)({
    elementRef: observation.elementRef,
    sourceAddress: observation.sourceAddress,
    supportingSources: observation.supportingSources,
    feedbackWeightMicros: feature?.feedbackWeightMicros ?? 0,
    ...(feature?.confidenceMicros === undefined
      ? {}
      : { confidenceMicros: feature.confidenceMicros }),
    ...(observation.scoreMicros === undefined ? {} : { relevanceMicros: observation.scoreMicros }),
  });
  return Result.isFailure(decoded)
    ? Effect.fail(fail("invalid_evidence", "A used-element record is invalid."))
    : Effect.succeed(decoded.success);
};

const compareRanked = (
  features: ReadonlyMap<string, GraphRankingFeature>,
  left: GraphRlmObservation,
  right: GraphRlmObservation,
): number => {
  const leftFeature = features.get(left.elementRef);
  const rightFeature = features.get(right.elementRef);
  const dimensions = [
    [leftFeature?.feedbackWeightMicros ?? 0, rightFeature?.feedbackWeightMicros ?? 0],
    [leftFeature?.confidenceMicros ?? 0, rightFeature?.confidenceMicros ?? 0],
    [left.scoreMicros ?? 0, right.scoreMicros ?? 0],
  ] as const;
  for (const [leftValue, rightValue] of dimensions) {
    if (leftValue !== rightValue) return leftValue < rightValue ? 1 : -1;
  }
  return compareCanonicalText(left.elementRef, right.elementRef);
};

const degradation = (
  observations: ReadonlyArray<GraphRlmObservation>,
  features: ReadonlyMap<string, GraphRankingFeature>,
) => ({
  missingFeatureElementRefs: canonicalRefs(
    observations.filter((item) => !features.has(item.elementRef)).map((item) => item.elementRef),
  ),
  missingConfidenceElementRefs: canonicalRefs(
    observations
      .filter((item) => features.get(item.elementRef)?.confidenceMicros === undefined)
      .map((item) => item.elementRef),
  ),
  missingRelevanceElementRefs: canonicalRefs(
    observations.filter((item) => item.scoreMicros === undefined).map((item) => item.elementRef),
  ),
});

const evidenceContent = (value: Omit<GraphUsedElementEvidence, "evidenceRef" | "evidenceDigest">) =>
  value;

const computeOutcome = Effect.fn("GraphCorpus.computeRankingOutcome")(function* (input: {
  readonly built: BuiltGraphCorpus;
  readonly projection: GraphRlmProjection;
  readonly result: GraphRlmOperationResult;
  readonly expectedOperationDigest: GraphDigest;
  readonly providerContext?: GraphRankingProviderContext;
  readonly binding: GraphRankingOperationBinding;
  readonly snapshot?: GraphRankingSnapshot;
}) {
  const result = yield* validateAuthenticResult(input);
  if (result.observations.length > 10_000)
    return yield* fail("invalid_result", "The graph operation result exceeds the ranking bound.");
  if (result._tag === "Truncated" && input.snapshot !== undefined)
    return yield* fail("incomplete_result", "A truncated graph result cannot use ranking state.");
  if (input.snapshot !== undefined) {
    yield* validateGraphRankingSnapshot(input.snapshot, {
      built: input.built,
      projection: input.projection,
      result,
      expectedOperationDigest: input.expectedOperationDigest,
      ...(input.providerContext === undefined ? {} : { providerContext: input.providerContext }),
      binding: input.binding,
    });
  }
  const features = new Map((input.snapshot?.features ?? []).map((item) => [item.elementRef, item]));
  const observations =
    input.snapshot === undefined
      ? [...result.observations]
      : [...result.observations].sort((left, right) => compareRanked(features, left, right));
  const degraded = degradation(result.observations, features);
  const identity = identityFrom(input.built, result);
  const usedElements: GraphUsedElement[] = [];
  for (const observation of observations) {
    usedElements.push(yield* makeUsedElement(observation, features.get(observation.elementRef)));
  }
  const commonEvidence = {
    schemaId: GRAPH_USED_ELEMENT_EVIDENCE_SCHEMA_ID,
    ...identity,
    queryDigest: graphRankingQueryDigest(input.binding),
    operationDigest: result.operationDigest,
    operationResultDigest: digest(result),
    limitsDigest: digest(result.limits),
    operationStatus: result._tag,
    hitCaps: result.hitCaps,
    usedElements,
    ...degraded,
  };
  const evidenceWithoutRefs =
    input.snapshot === undefined
      ? {
          ...commonEvidence,
          _tag: "Unranked" as const,
          disabledReason:
            result._tag === "Truncated"
              ? ("operation_truncated" as const)
              : ("ranking_disabled" as const),
        }
      : {
          ...commonEvidence,
          _tag: "Ranked" as const,
          rankingSnapshotDigest: input.snapshot.snapshotDigest,
          algorithmVersion: GRAPH_RANKING_ALGORITHM_VERSION,
        };
  const evidenceDigest = digest(evidenceContent(evidenceWithoutRefs));
  const evidenceResult = decodeEvidence({
    ...evidenceWithoutRefs,
    evidenceRef: ref("used-elements", evidenceWithoutRefs),
    evidenceDigest,
  });
  if (Result.isFailure(evidenceResult))
    return yield* fail("invalid_evidence", "Used-element evidence does not match its schema.");
  const outcomeResult = decodeOutcome(
    input.snapshot === undefined
      ? {
          schemaId: GRAPH_RANKING_OUTCOME_SCHEMA_ID,
          _tag: "Unranked",
          observations,
          evidence: evidenceResult.success,
          ...degraded,
          disabledReason: result._tag === "Truncated" ? "operation_truncated" : "ranking_disabled",
        }
      : {
          schemaId: GRAPH_RANKING_OUTCOME_SCHEMA_ID,
          _tag: "Ranked",
          observations,
          evidence: evidenceResult.success,
          ...degraded,
          rankingSnapshotDigest: input.snapshot.snapshotDigest,
          algorithmVersion: GRAPH_RANKING_ALGORITHM_VERSION,
        },
  );
  if (Result.isFailure(outcomeResult))
    return yield* fail("invalid_evidence", "The ranking outcome does not match its schema.");
  return cloneFrozen(outcomeResult.success);
});

export const rankGraphOperationResult = Effect.fn("GraphCorpus.rankGraphOperationResult")(
  function* (input: {
    readonly built: BuiltGraphCorpus;
    readonly projection: GraphRlmProjection;
    readonly result: GraphRlmOperationResult;
    readonly expectedOperationDigest: GraphDigest;
    readonly providerContext?: GraphRankingProviderContext;
    readonly binding: GraphRankingOperationBinding;
    readonly snapshot?: GraphRankingSnapshot;
  }) {
    return yield* computeOutcome(input);
  },
);

export const validateGraphUsedElementEvidence = Effect.fn(
  "GraphCorpus.validateGraphUsedElementEvidence",
)(function* (
  evidence: GraphUsedElementEvidence,
  context: {
    readonly built: BuiltGraphCorpus;
    readonly projection: GraphRlmProjection;
    readonly result: GraphRlmOperationResult;
    readonly expectedOperationDigest: GraphDigest;
    readonly providerContext?: GraphRankingProviderContext;
    readonly binding: GraphRankingOperationBinding;
    readonly snapshot?: GraphRankingSnapshot;
  },
) {
  const expected = yield* computeOutcome(context);
  if (canonicalJson(evidence) !== canonicalJson(expected.evidence))
    return yield* fail("invalid_evidence", "Used-element evidence was substituted or changed.");
});

export const rankingArtifactsFromSnapshot = Effect.fn("GraphCorpus.rankingArtifactsFromSnapshot")(
  function* (
    snapshot: GraphRankingSnapshot,
    context: {
      readonly built: BuiltGraphCorpus;
      readonly projection: GraphRlmProjection;
      readonly result: GraphRlmOperationResult;
      readonly expectedOperationDigest: GraphDigest;
      readonly providerContext?: GraphRankingProviderContext;
      readonly binding: GraphRankingOperationBinding;
    },
  ) {
    yield* validateGraphRankingSnapshot(snapshot, context);
    return cloneFrozen(
      snapshot.features.map(
        (feature): GraphRankingArtifactType =>
          decodeArtifact({
            artifactKind: "ranking_ref",
            artifactRef: feature.featureRef,
            artifactDigest: feature.featureDigest,
            ownerElementRef: feature.elementRef,
          }),
      ),
    );
  },
);
