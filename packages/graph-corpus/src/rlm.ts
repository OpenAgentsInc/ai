import { Effect, Schema as S, Stream } from "effect";
import {
  buildInlineCorpusInput,
  makeInlineCorpusHandle,
  type RlmCorpusHandle,
  type RlmCorpusSourceShape,
} from "@openagentsinc/rlm/corpus";
import type { RlmCorpusEntry, RlmCorpusInput } from "@openagentsinc/rlm/schemas";
import {
  RlmCorpusCoverage,
  RlmCorpusError,
  RlmCorpusIdentity,
  RlmCorpusPolicy,
  RlmCorpusRef,
  RlmCorpusDigest,
  RlmManifestDigest,
  RlmRedactionClass,
  RlmSourceAddress,
  RlmSourceLocator,
  RlmVisibility,
} from "@openagentsinc/rlm/schemas";

import { canonicalJson, compareCanonicalText, sha256Hex } from "./canonical.ts";
import {
  requireGraphAdapterCapability,
  type GraphAdapterCapabilities,
  type GraphAdapterCapabilityError,
} from "./capabilities.ts";
import type { GraphCompleteArtifactInventory } from "./deletion.ts";
import type { GraphReadableElement, GraphSnapshotHandle } from "./handle.ts";
import {
  GRAPH_CANONICALIZATION_ID,
  GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
  GraphDigest,
  GraphDescriptorRef,
  GraphElementAddress,
  GraphElementRef,
  GraphRef,
  GraphScopeRef,
  graphDigest,
  graphElementRef,
  type GraphCorpusPolicy,
  type GraphElementKind,
} from "./schemas.ts";
import type { GraphCorpusError } from "./builder.ts";

export const GRAPH_RLM_CLASSIFICATION_SCHEMA_ID =
  "openagents.ai.graph_rlm_classification.v1" as const;
export const GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID =
  "openagents.ai.graph_rlm_source_address.v1" as const;
export const GRAPH_RLM_OPERATION_SCHEMA_ID = "openagents.ai.graph_rlm_operation.v1" as const;
export const GRAPH_RLM_RESULT_SCHEMA_ID = "openagents.ai.graph_rlm_result.v1" as const;
export const GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID =
  "openagents.ai.graph_rlm_search_response.v1" as const;

export const GraphRlmElementClassification = S.Struct({
  elementRef: GraphElementRef,
  visibility: RlmVisibility,
  redactionClass: RlmRedactionClass,
});
export type GraphRlmElementClassification = typeof GraphRlmElementClassification.Type;

/** A complete policy projection. Partial classification never produces an RLM corpus. */
export const GraphRlmClassificationProjection = S.Struct({
  schemaId: S.Literal(GRAPH_RLM_CLASSIFICATION_SCHEMA_ID),
  canonicalizationId: S.Literal(GRAPH_CANONICALIZATION_ID),
  _tag: S.Literal("Complete"),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  classifications: S.Array(GraphRlmElementClassification),
  supportingCorpora: S.Array(
    S.Struct({
      identity: RlmCorpusIdentity,
      policy: RlmCorpusPolicy,
      coverage: RlmCorpusCoverage,
    }),
  ),
  projectionDigest: GraphDigest,
});
export type GraphRlmClassificationProjection = typeof GraphRlmClassificationProjection.Type;

export const GraphRlmRetrievalBinding = S.Struct({
  artifactRef: S.String.check(S.isMinLength(1), S.isMaxLength(512)),
  ownerElementRef: GraphElementRef,
  descriptorRef: GraphDescriptorRef,
  projectionSchemaId: S.String.check(S.isMinLength(1), S.isMaxLength(512)),
  dimensions: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(4_096)),
});
export type GraphRlmRetrievalBinding = typeof GraphRlmRetrievalBinding.Type;
export const GraphRlmRetrievalInventory = S.Struct({
  _tag: S.Literal("Complete"),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  artifactInventoryDigest: GraphDigest,
  bindings: S.Array(GraphRlmRetrievalBinding),
  retrievalDigest: GraphDigest,
});
export type GraphRlmRetrievalInventory = typeof GraphRlmRetrievalInventory.Type;

export const GraphRlmSourceAddress = S.Struct({
  schemaId: S.Literal(GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  graphManifestDigest: GraphDigest,
  classificationDigest: GraphDigest,
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
});
export type GraphRlmSourceAddress = typeof GraphRlmSourceAddress.Type;

const safeBounded = (minimum: number) =>
  S.Number.check(
    S.isInt(),
    S.makeFilter(Number.isSafeInteger, { description: "safe integer" }),
    S.isGreaterThanOrEqualTo(minimum),
    S.isLessThanOrEqualTo(1_000_000),
  );
const positive = safeBounded(1);
export const GraphRlmOperationLimits = S.Struct({
  maxDepth: safeBounded(0),
  maxVisitedElements: positive,
  maxReturnedElements: positive,
  maxSourceAddresses: positive,
  maxCharactersPerResult: positive,
  maxObservationCharacters: positive,
});
export type GraphRlmOperationLimits = typeof GraphRlmOperationLimits.Type;

export const GraphRlmHitCap = S.Literals([
  "max_depth",
  "max_visited_elements",
  "max_returned_elements",
  "max_source_addresses",
  "max_characters_per_result",
  "max_observation_characters",
]);
export type GraphRlmHitCap = typeof GraphRlmHitCap.Type;

export class GraphRlmError extends S.TaggedErrorClass<GraphRlmError>()("GraphCorpus.RlmError", {
  reason: S.Literals([
    "invalid_projection",
    "projection_changed",
    "invalid_limits",
    "not_found",
    "incomplete_citation",
    "invalid_inventory",
    "unsupported_callback",
  ]),
  detailSafe: S.optionalKey(S.String.check(S.isMaxLength(512))),
}) {}

export const GraphRlmObservation = S.Struct({
  elementRef: GraphElementRef,
  elementKind: S.Literals(["mention", "entity", "relation"]),
  canonicalKey: S.optionalKey(S.String.check(S.isMaxLength(2_048))),
  relationKind: S.optionalKey(S.String.check(S.isMaxLength(512))),
  scoreMicros: S.optionalKey(
    S.Number.check(S.isInt(), S.makeFilter(Number.isSafeInteger, { description: "safe integer" })),
  ),
  sourceAddress: RlmSourceAddress,
  supportingSources: S.Array(RlmSourceLocator),
  text: S.optionalKey(S.String.check(S.isMaxLength(1_000_000))),
});
export type GraphRlmObservation = typeof GraphRlmObservation.Type;

export const GraphRlmOperationRequest = S.Union([
  S.Struct({
    schemaId: S.Literal(GRAPH_RLM_OPERATION_SCHEMA_ID),
    operation: S.Literal("lookup"),
    elementRef: GraphElementRef,
    limits: GraphRlmOperationLimits,
  }),
  S.Struct({
    schemaId: S.Literal(GRAPH_RLM_OPERATION_SCHEMA_ID),
    operation: S.Literal("neighbors"),
    elementRef: GraphElementRef,
    limits: GraphRlmOperationLimits,
  }),
  S.Struct({
    schemaId: S.Literal(GRAPH_RLM_OPERATION_SCHEMA_ID),
    operation: S.Literal("expand_source"),
    source: RlmSourceLocator,
    limits: GraphRlmOperationLimits,
  }),
  S.Struct({
    schemaId: S.Literal(GRAPH_RLM_OPERATION_SCHEMA_ID),
    operation: S.Literal("text_search"),
    query: S.String.check(S.isMinLength(1), S.isMaxLength(2_048)),
    limits: GraphRlmOperationLimits,
  }),
]);
export type GraphRlmOperationRequest = typeof GraphRlmOperationRequest.Type;

export type GraphRlmOperationResult =
  | {
      readonly _tag: "Complete";
      readonly schemaId: typeof GRAPH_RLM_RESULT_SCHEMA_ID;
      readonly operationDigest: GraphDigest;
      readonly graphDigest: GraphDigest;
      readonly manifestDigest: GraphDigest;
      readonly corpusRef: string;
      readonly contentDigest: string;
      readonly corpusManifestDigest: string;
      readonly classificationDigest: GraphDigest;
      readonly limits: GraphRlmOperationLimits;
      readonly visitedElements: number;
      readonly sourceAddresses: number;
      readonly observationCharacters: number;
      readonly observations: ReadonlyArray<GraphRlmObservation>;
      readonly hitCaps: readonly [];
    }
  | {
      readonly _tag: "Truncated";
      readonly schemaId: typeof GRAPH_RLM_RESULT_SCHEMA_ID;
      readonly operationDigest: GraphDigest;
      readonly graphDigest: GraphDigest;
      readonly manifestDigest: GraphDigest;
      readonly corpusRef: string;
      readonly contentDigest: string;
      readonly corpusManifestDigest: string;
      readonly classificationDigest: GraphDigest;
      readonly limits: GraphRlmOperationLimits;
      readonly visitedElements: number;
      readonly sourceAddresses: number;
      readonly observationCharacters: number;
      readonly observations: ReadonlyArray<GraphRlmObservation>;
      readonly hitCaps: ReadonlyArray<GraphRlmHitCap>;
    };

const graphRlmResultFields = {
  schemaId: S.Literal(GRAPH_RLM_RESULT_SCHEMA_ID),
  operationDigest: GraphDigest,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  corpusRef: S.String,
  contentDigest: GraphDigest,
  corpusManifestDigest: GraphDigest,
  classificationDigest: GraphDigest,
  limits: GraphRlmOperationLimits,
  visitedElements: safeBounded(0),
  sourceAddresses: safeBounded(0),
  observationCharacters: safeBounded(0),
  observations: S.Array(GraphRlmObservation),
};
export const GraphRlmOperationResultSchema = S.Union([
  S.Struct({ ...graphRlmResultFields, _tag: S.Literal("Complete"), hitCaps: S.Tuple([]) }),
  S.Struct({
    ...graphRlmResultFields,
    _tag: S.Literal("Truncated"),
    hitCaps: S.Array(GraphRlmHitCap).check(S.isMinLength(1)),
  }),
]);

export const GraphScoredElement = S.Struct({
  elementRef: GraphElementRef,
  scoreMicros: S.Number.check(
    S.isInt(),
    S.makeFilter(Number.isSafeInteger, { description: "safe integer" }),
  ),
});
export type GraphScoredElement = typeof GraphScoredElement.Type;

export interface GraphRlmSearchCallbacks {
  readonly vectorSearch?: (
    request: GraphRlmVectorSearchRequest,
  ) => Effect.Effect<GraphRlmSearchResponse, GraphRlmError>;
  readonly hybridSearch?: (
    request: GraphRlmHybridSearchRequest,
  ) => Effect.Effect<GraphRlmSearchResponse, GraphRlmError>;
}

const graphRlmSearchBindingFields = {
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  inventoryDigest: GraphDigest,
  retrievalDigest: GraphDigest,
  descriptorRef: GraphDescriptorRef,
  limits: GraphRlmOperationLimits,
  maxResults: positive,
};
export const GraphRlmSearchBinding = S.Struct(graphRlmSearchBindingFields);
export type GraphRlmSearchBinding = typeof GraphRlmSearchBinding.Type;
const GraphRlmSearchVector = S.Array(S.Number.check(S.isFinite())).check(
  S.isMinLength(1),
  S.isMaxLength(4_096),
);
export const GraphRlmVectorSearchRequest = S.Struct({
  ...graphRlmSearchBindingFields,
  vector: GraphRlmSearchVector,
});
export type GraphRlmVectorSearchRequest = typeof GraphRlmVectorSearchRequest.Type;
export const GraphRlmHybridSearchRequest = S.Struct({
  ...graphRlmSearchBindingFields,
  vector: GraphRlmSearchVector,
  textQuery: S.String.check(S.isMinLength(1), S.isMaxLength(2_048)),
});
export type GraphRlmHybridSearchRequest = typeof GraphRlmHybridSearchRequest.Type;
export const GraphRlmSearchResponse = S.Struct({
  schemaId: S.Literal(GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID),
  ...graphRlmSearchBindingFields,
  results: S.Array(GraphScoredElement),
});
export type GraphRlmSearchResponse = typeof GraphRlmSearchResponse.Type;

export interface GraphRlmOperators {
  readonly lookup: (
    elementRef: string,
    limits: GraphRlmOperationLimits,
  ) => Effect.Effect<GraphRlmOperationResult, GraphRlmError | GraphCorpusError>;
  readonly neighbors: (
    elementRef: string,
    limits: GraphRlmOperationLimits,
  ) => Effect.Effect<GraphRlmOperationResult, GraphRlmError | GraphCorpusError>;
  readonly expandSource: (
    source: RlmSourceLocator,
    limits: GraphRlmOperationLimits,
  ) => Effect.Effect<GraphRlmOperationResult, GraphRlmError | GraphCorpusError>;
  readonly searchText: (
    query: string,
    limits: GraphRlmOperationLimits,
  ) => Effect.Effect<GraphRlmOperationResult, GraphRlmError | GraphCorpusError>;
  readonly searchVector: (
    descriptorRef: string,
    vector: ReadonlyArray<number>,
    limits: GraphRlmOperationLimits,
  ) => Effect.Effect<
    GraphRlmOperationResult,
    GraphRlmError | GraphCorpusError | GraphAdapterCapabilityError
  >;
  readonly searchHybrid: (
    descriptorRef: string,
    vector: ReadonlyArray<number>,
    textQuery: string,
    limits: GraphRlmOperationLimits,
  ) => Effect.Effect<
    GraphRlmOperationResult,
    GraphRlmError | GraphCorpusError | GraphAdapterCapabilityError
  >;
}

export interface GraphRlmProjection {
  readonly classification: GraphRlmClassificationProjection;
  readonly corpus: RlmCorpusHandle;
  readonly sourceRef: { readonly addressSchemaId: string; readonly encodedAddress: string };
  readonly operators: GraphRlmOperators;
}

const digest = (value: unknown): GraphDigest => graphDigest(sha256Hex(canonicalJson(value)));
const freezeUnknown = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeUnknown(child);
  Object.freeze(value);
};
const cloneFrozen = <A>(value: A): A => {
  const clone = structuredClone(value);
  freezeUnknown(clone);
  return clone;
};
const compareRef = (
  left: { readonly elementRef: string },
  right: { readonly elementRef: string },
) => compareCanonicalText(left.elementRef, right.elementRef);
const sourceKey = (source: RlmSourceLocator): string => canonicalJson(source);
const canonicalSources = (element: GraphReadableElement): ReadonlyArray<RlmSourceLocator> =>
  [...new Map(element.memberships.map(({ source }) => [sourceKey(source), source])).values()].sort(
    (left, right) => compareCanonicalText(sourceKey(left), sourceKey(right)),
  );
const allElements = (handle: GraphSnapshotHandle): ReadonlyArray<GraphReadableElement> =>
  [...handle.snapshot.mentions, ...handle.snapshot.entities, ...handle.snapshot.relations].sort(
    compareRef,
  );

const graphAddress = (
  handle: GraphSnapshotHandle,
  element: GraphReadableElement,
): RlmSourceAddress => ({
  addressSchemaId: GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
  encodedAddress: canonicalJson(
    S.decodeUnknownSync(GraphElementAddress)({
      schemaId: GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
      graphRef: handle.snapshot.graphRef,
      scopeRef: handle.snapshot.scopeRef,
      graphDigest: handle.snapshot.graphDigest,
      manifestDigest: handle.manifest.manifestDigest,
      elementKind: element.elementKind,
      elementRef: element.elementRef,
    }),
  ),
});

const safeText = (element: GraphReadableElement): string =>
  element.elementKind === "relation"
    ? `${element.identity.canonicalKey}\n${element.relationKind}`
    : element.identity.canonicalKey;
const visibilityOrder = ["public", "operator", "private"] as const;
const redactionOrder = ["none", "private_ref", "redacted", "secret"] as const;

const classificationContent = (
  value: Omit<GraphRlmClassificationProjection, "projectionDigest">,
): unknown => value;

/** Build the complete, digest-bound classification required by the RLM projection. */
export const makeGraphRlmClassificationProjection = (
  handle: GraphSnapshotHandle,
  classifications: ReadonlyArray<GraphRlmElementClassification>,
  supportingCorpora: ReadonlyArray<RlmCorpusHandle>,
): GraphRlmClassificationProjection => {
  const canonical = [...classifications].sort(compareRef);
  const canonicalSupporting = supportingCorpora
    .map(({ identity, manifest }) => ({
      identity: structuredClone(identity),
      policy: structuredClone(manifest.policy),
      coverage: structuredClone(manifest.coverage),
    }))
    .sort((left, right) =>
      compareCanonicalText(canonicalJson(left.identity), canonicalJson(right.identity)),
    );
  const withoutDigest = {
    schemaId: GRAPH_RLM_CLASSIFICATION_SCHEMA_ID,
    canonicalizationId: GRAPH_CANONICALIZATION_ID,
    _tag: "Complete" as const,
    graphRef: handle.snapshot.graphRef,
    scopeRef: handle.snapshot.scopeRef,
    graphDigest: handle.snapshot.graphDigest,
    manifestDigest: handle.manifest.manifestDigest,
    classifications: canonical,
    supportingCorpora: canonicalSupporting,
  };
  return S.decodeUnknownSync(GraphRlmClassificationProjection)({
    ...withoutDigest,
    projectionDigest: digest(classificationContent(withoutDigest)),
  });
};

export const makeGraphRlmRetrievalInventory = Effect.fn("GraphCorpus.makeRlmRetrievalInventory")(
  function* (
    handle: GraphSnapshotHandle,
    inventory: GraphCompleteArtifactInventory,
    bindings: ReadonlyArray<GraphRlmRetrievalBinding>,
  ) {
    yield* handle.assertUnchanged();
    if (!inventoryValid(handle, inventory)) {
      return yield* fail("invalid_inventory", "The vector inventory is stale or incomplete.");
    }
    const canonicalBindings = [...bindings].sort((left, right) =>
      compareCanonicalText(
        `${left.descriptorRef}:${left.ownerElementRef}:${left.artifactRef}`,
        `${right.descriptorRef}:${right.ownerElementRef}:${right.artifactRef}`,
      ),
    );
    const artifactRefs = canonicalBindings.map(({ artifactRef }) => artifactRef);
    const ownerDescriptors = canonicalBindings.map(
      ({ ownerElementRef, descriptorRef }) => `${ownerElementRef}:${descriptorRef}`,
    );
    const expectedArtifacts = inventory.vectors
      .map(({ artifactRef }) => artifactRef)
      .sort(compareCanonicalText);
    if (
      new Set(artifactRefs).size !== artifactRefs.length ||
      new Set(ownerDescriptors).size !== ownerDescriptors.length ||
      canonicalJson([...artifactRefs].sort(compareCanonicalText)) !==
        canonicalJson(expectedArtifacts)
    ) {
      return yield* fail(
        "invalid_inventory",
        "A complete retrieval inventory must bind each vector artifact exactly once.",
      );
    }
    const vectors = new Map<string, GraphCompleteArtifactInventory["vectors"][number]>(
      inventory.vectors.map((item) => [item.artifactRef, item]),
    );
    const elements = new Map(allElements(handle).map((element) => [element.elementRef, element]));
    for (const binding of canonicalBindings) {
      const vector = vectors.get(binding.artifactRef);
      const owner = elements.get(binding.ownerElementRef);
      const descriptors = handle.snapshot.embeddingProjections.filter(
        ({ descriptorRef }) => descriptorRef === binding.descriptorRef,
      );
      const descriptor = descriptors[0];
      if (
        vector?.ownerElementRef !== binding.ownerElementRef ||
        descriptors.length !== 1 ||
        descriptor === undefined ||
        descriptor.projectionSchemaId !== binding.projectionSchemaId ||
        descriptor.dimensions !== binding.dimensions ||
        owner === undefined ||
        !descriptor.elementKinds.includes(owner.elementKind)
      ) {
        return yield* fail("invalid_inventory", "A retrieval binding is dangling or substituted.");
      }
    }
    const withoutDigest = {
      _tag: "Complete" as const,
      graphRef: handle.snapshot.graphRef,
      scopeRef: handle.snapshot.scopeRef,
      graphDigest: handle.snapshot.graphDigest,
      manifestDigest: handle.manifest.manifestDigest,
      artifactInventoryDigest: inventory.inventoryDigest,
      bindings: canonicalBindings,
    };
    return S.decodeUnknownSync(GraphRlmRetrievalInventory)({
      ...withoutDigest,
      retrievalDigest: digest(withoutDigest),
    });
  },
);

const fail = (reason: GraphRlmError["reason"], detailSafe: string): GraphRlmError =>
  new GraphRlmError({ reason, detailSafe });

const validateClassification = (
  handle: GraphSnapshotHandle,
  projection: GraphRlmClassificationProjection,
  supportingCorpora: ReadonlyArray<RlmCorpusHandle>,
): Effect.Effect<Map<string, GraphRlmElementClassification>, GraphRlmError> =>
  Effect.gen(function* () {
    let decoded: GraphRlmClassificationProjection;
    try {
      decoded = S.decodeUnknownSync(GraphRlmClassificationProjection)(projection);
    } catch {
      return yield* fail("invalid_projection", "The classification projection is invalid.");
    }
    const { projectionDigest, ...withoutDigest } = decoded;
    if (digest(classificationContent(withoutDigest)) !== projectionDigest) {
      return yield* fail("projection_changed", "The classification digest does not match.");
    }
    if (
      decoded.graphRef !== handle.snapshot.graphRef ||
      decoded.scopeRef !== handle.snapshot.scopeRef ||
      decoded.graphDigest !== handle.snapshot.graphDigest ||
      decoded.manifestDigest !== handle.manifest.manifestDigest
    ) {
      return yield* fail("projection_changed", "The classification is for a different graph.");
    }
    const actualSupporting = supportingCorpora
      .map(({ identity, manifest }) => ({
        identity,
        policy: manifest.policy,
        coverage: manifest.coverage,
      }))
      .sort((left, right) =>
        compareCanonicalText(canonicalJson(left.identity), canonicalJson(right.identity)),
      );
    if (canonicalJson(decoded.supportingCorpora) !== canonicalJson(actualSupporting)) {
      return yield* fail(
        "projection_changed",
        "The classification supporting corpus identities changed.",
      );
    }
    const expected = allElements(handle).map(({ elementRef }) => elementRef);
    const actual = decoded.classifications.map(({ elementRef }) => elementRef);
    if (
      new Set(actual).size !== actual.length ||
      canonicalJson(expected) !== canonicalJson(actual)
    ) {
      return yield* fail(
        "invalid_projection",
        "Classification must cover each graph element once.",
      );
    }
    for (const row of decoded.classifications) {
      if (
        !handle.snapshot.policy.includeVisibilities.includes(row.visibility) ||
        !handle.snapshot.policy.includeRedactionClasses.includes(row.redactionClass)
      ) {
        return yield* fail("invalid_projection", "Classification widens the graph policy.");
      }
    }
    return new Map(decoded.classifications.map((row) => [row.elementRef, row]));
  });

const decodeLimits = (
  limits: GraphRlmOperationLimits,
): Effect.Effect<GraphRlmOperationLimits, GraphRlmError> =>
  Effect.try({
    try: () => S.decodeUnknownSync(GraphRlmOperationLimits)(limits),
    catch: () => fail("invalid_limits", "All graph operation limits are required and bounded."),
  });

interface ResultInput {
  readonly operation: unknown;
  readonly candidates: ReadonlyArray<GraphReadableElement>;
  readonly visitedElements: number;
  readonly initialCaps?: ReadonlyArray<GraphRlmHitCap>;
  readonly scores?: ReadonlyMap<string, number>;
}
interface GraphRlmProjectionBinding {
  readonly corpus: RlmCorpusHandle["identity"];
  readonly classificationDigest: GraphDigest;
  readonly supportingCorpora: ReadonlyArray<RlmCorpusHandle["identity"]>;
}

const makeResult = (
  handle: GraphSnapshotHandle,
  entries: ReadonlyMap<string, RlmCorpusEntry>,
  input: ResultInput,
  limits: GraphRlmOperationLimits,
  projectionBinding: GraphRlmProjectionBinding,
): GraphRlmOperationResult => {
  const observations: Array<GraphRlmObservation> = [];
  const caps = new Set(input.initialCaps ?? []);
  let sourceAddresses = 0;
  let observationCharacters = 0;
  for (const element of input.candidates) {
    if (observations.length >= limits.maxReturnedElements) {
      caps.add("max_returned_elements");
      break;
    }
    const entry = entries.get(element.elementRef);
    if (entry === undefined) continue;
    const sources = entry.supportingSources ?? [];
    const entrySourceAddressCount = 1 + sources.length;
    if (sourceAddresses + entrySourceAddressCount > limits.maxSourceAddresses) {
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
    let observation: GraphRlmObservation = baseObservation;
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
        if (size <= limits.maxCharactersPerResult) low = middle;
        else high = middle - 1;
      }
      if (low < points.length) caps.add("max_characters_per_result");
      if (low > 0) observation = { ...baseObservation, text: points.slice(0, low).join("") };
    }
    const characters = Array.from(canonicalJson(observation)).length;
    if (characters > limits.maxCharactersPerResult) {
      caps.add("max_characters_per_result");
      break;
    }
    if (observationCharacters + characters > limits.maxObservationCharacters) {
      caps.add("max_observation_characters");
      break;
    }
    sourceAddresses += entrySourceAddressCount;
    observationCharacters += characters;
    observations.push(observation);
  }
  const hitCaps = [...caps].sort(compareCanonicalText);
  const evidence = {
    operation: input.operation,
    limits,
    graphDigest: handle.snapshot.graphDigest,
    manifestDigest: handle.manifest.manifestDigest,
    corpusRef: projectionBinding.corpus.corpusRef,
    contentDigest: projectionBinding.corpus.contentDigest,
    corpusManifestDigest: projectionBinding.corpus.manifestDigest,
    classificationDigest: projectionBinding.classificationDigest,
    visitedElements: input.visitedElements,
    sourceAddresses,
    observationCharacters,
    observations,
    hitCaps,
  };
  const common = {
    schemaId: GRAPH_RLM_RESULT_SCHEMA_ID,
    operationDigest: digest(evidence),
    graphDigest: handle.snapshot.graphDigest,
    manifestDigest: handle.manifest.manifestDigest,
    corpusRef: projectionBinding.corpus.corpusRef,
    contentDigest: projectionBinding.corpus.contentDigest,
    corpusManifestDigest: projectionBinding.corpus.manifestDigest,
    classificationDigest: projectionBinding.classificationDigest,
    limits,
    visitedElements: input.visitedElements,
    sourceAddresses,
    observationCharacters,
    observations,
  };
  return cloneFrozen(
    S.decodeUnknownSync(GraphRlmOperationResultSchema)(
      hitCaps.length === 0
        ? { _tag: "Complete", ...common, hitCaps: [] }
        : { _tag: "Truncated", ...common, hitCaps },
    ),
  );
};

const inventoryValid = (
  handle: GraphSnapshotHandle,
  inventory: GraphCompleteArtifactInventory | undefined,
): boolean => {
  if (
    inventory === undefined ||
    inventory._tag !== "Complete" ||
    inventory.coverage.vectors._tag !== "Complete" ||
    inventory.graphRef !== handle.snapshot.graphRef ||
    inventory.scopeRef !== handle.snapshot.scopeRef ||
    inventory.graphDigest !== handle.snapshot.graphDigest ||
    inventory.manifestDigest !== handle.manifest.manifestDigest
  )
    return false;
  const { inventoryDigest, ...inventoryContent } = inventory;
  if (digest(inventoryContent) !== inventoryDigest) return false;
  const refs = new Set(allElements(handle).map(({ elementRef }) => elementRef));
  return inventory.vectors.every(({ ownerElementRef }) => refs.has(ownerElementRef));
};

const makeOperators = (
  handle: GraphSnapshotHandle,
  entries: ReadonlyMap<string, RlmCorpusEntry>,
  capabilities: GraphAdapterCapabilities,
  inventory: GraphCompleteArtifactInventory | undefined,
  retrievalInventory: GraphRlmRetrievalInventory | undefined,
  callbacks: GraphRlmSearchCallbacks,
  assertFresh: () => Effect.Effect<void, GraphRlmError>,
  projectionBinding: GraphRlmProjectionBinding,
): GraphRlmOperators => {
  const elements = allElements(handle);
  const byRef = new Map<string, GraphReadableElement>(
    elements.map((element) => [element.elementRef, element]),
  );
  const mentionByTypedRef = new Map(
    handle.snapshot.mentions.map((item) => [item.mentionRef, item]),
  );
  const entityByTypedRef = new Map(handle.snapshot.entities.map((item) => [item.entityRef, item]));
  const adjacent = new Map<string, Set<string>>(
    elements.map((element) => [element.elementRef, new Set<string>()]),
  );
  for (const entity of handle.snapshot.entities) {
    for (const mentionRef of entity.mentionRefs) {
      const mention = mentionByTypedRef.get(mentionRef);
      if (mention !== undefined) {
        adjacent.get(entity.elementRef)?.add(mention.elementRef);
        adjacent.get(mention.elementRef)?.add(entity.elementRef);
      }
    }
  }
  for (const relation of handle.snapshot.relations) {
    for (const entityRef of [relation.fromEntityRef, relation.toEntityRef]) {
      const entity = entityByTypedRef.get(entityRef);
      if (entity !== undefined) {
        adjacent.get(relation.elementRef)?.add(entity.elementRef);
        adjacent.get(entity.elementRef)?.add(relation.elementRef);
      }
    }
  }
  const execute = Effect.fn("GraphCorpus.Rlm.execute")(function* (
    operation: unknown,
    candidates: ReadonlyArray<GraphReadableElement>,
    visitedElements: number,
    limitsInput: GraphRlmOperationLimits,
    initialCaps?: ReadonlyArray<GraphRlmHitCap>,
    scores?: ReadonlyMap<string, number>,
  ) {
    yield* assertFresh();
    const limits = yield* decodeLimits(limitsInput);
    const result = makeResult(
      handle,
      entries,
      {
        operation: { projectionBinding, request: operation },
        candidates,
        visitedElements,
        ...(initialCaps === undefined ? {} : { initialCaps }),
        ...(scores === undefined ? {} : { scores }),
      },
      limits,
      projectionBinding,
    );
    yield* assertFresh();
    return result;
  });
  const refsFromScores = (
    scores: ReadonlyArray<GraphScoredElement>,
    allowedOwners?: ReadonlySet<string>,
    allowedKinds?: ReadonlySet<GraphElementKind>,
  ): Effect.Effect<
    {
      readonly elements: ReadonlyArray<GraphReadableElement>;
      readonly scores: ReadonlyMap<string, number>;
    },
    GraphRlmError
  > =>
    Effect.gen(function* () {
      const seen = new Set<string>();
      const result: Array<GraphReadableElement> = [];
      for (const score of scores) {
        if (!Number.isSafeInteger(score.scoreMicros) || seen.has(score.elementRef)) {
          return yield* fail(
            "invalid_inventory",
            "Search returned an invalid or duplicate graph ref.",
          );
        }
        const element = byRef.get(score.elementRef);
        if (element === undefined) {
          return yield* fail("invalid_inventory", "Search returned an element outside the graph.");
        }
        if (
          (allowedOwners !== undefined && !allowedOwners.has(score.elementRef)) ||
          (allowedKinds !== undefined && !allowedKinds.has(element.elementKind))
        ) {
          return yield* fail(
            "invalid_inventory",
            "Search returned an element without a current vector artifact or descriptor.",
          );
        }
        seen.add(score.elementRef);
        result.push(element);
      }
      return {
        elements: result,
        scores: new Map(scores.map(({ elementRef, scoreMicros }) => [elementRef, scoreMicros])),
      };
    });
  const requireVector = Effect.fn("GraphCorpus.Rlm.requireVector")(function* (
    capability: "vector_read" | "hybrid_query",
  ) {
    yield* requireGraphAdapterCapability(capabilities, "graph_read");
    yield* requireGraphAdapterCapability(capabilities, "vector_read");
    if (capability === "hybrid_query")
      yield* requireGraphAdapterCapability(capabilities, capability);
    if (!inventoryValid(handle, inventory)) {
      return yield* fail(
        "invalid_inventory",
        "Vector operations require a current complete inventory.",
      );
    }
  });
  const searchBinding = (
    descriptorRef: string,
    vector: ReadonlyArray<number>,
    limits: GraphRlmOperationLimits,
  ): Effect.Effect<
    {
      readonly binding: GraphRlmSearchBinding;
      readonly owners: ReadonlySet<string>;
      readonly kinds: ReadonlySet<GraphElementKind>;
    },
    GraphRlmError
  > =>
    Effect.gen(function* () {
      if (
        vector.length === 0 ||
        vector.length > 4_096 ||
        vector.some((component) => !Number.isFinite(component))
      ) {
        return yield* fail(
          "invalid_limits",
          "A search vector must have 1 to 4096 finite components.",
        );
      }
      const currentInventory = inventory;
      const currentRetrieval = retrievalInventory;
      if (currentInventory === undefined || currentRetrieval === undefined) {
        return yield* fail("invalid_inventory", "The vector inventory is absent.");
      }
      const { retrievalDigest, ...retrievalContent } = currentRetrieval;
      if (
        digest(retrievalContent) !== retrievalDigest ||
        currentRetrieval.graphRef !== handle.snapshot.graphRef ||
        currentRetrieval.scopeRef !== handle.snapshot.scopeRef ||
        currentRetrieval.graphDigest !== handle.snapshot.graphDigest ||
        currentRetrieval.manifestDigest !== handle.manifest.manifestDigest ||
        currentRetrieval.artifactInventoryDigest !== currentInventory.inventoryDigest
      ) {
        return yield* fail("invalid_inventory", "The retrieval inventory is stale or invalid.");
      }
      const descriptors = handle.snapshot.embeddingProjections.filter(
        (candidate) => candidate.descriptorRef === descriptorRef,
      );
      const descriptor = descriptors[0];
      if (
        descriptors.length !== 1 ||
        descriptor === undefined ||
        descriptor.dimensions !== vector.length
      ) {
        return yield* fail(
          "invalid_inventory",
          "No current embedding descriptor matches the vector dimension.",
        );
      }
      const vectorByArtifact = new Map<string, GraphCompleteArtifactInventory["vectors"][number]>(
        currentInventory.vectors.map((item) => [item.artifactRef, item]),
      );
      const selectedBindings = currentRetrieval.bindings.filter(
        (binding) => binding.descriptorRef === descriptorRef,
      );
      if (
        selectedBindings.length === 0 ||
        selectedBindings.some((binding) => {
          const artifact = vectorByArtifact.get(binding.artifactRef);
          return (
            artifact === undefined ||
            artifact.ownerElementRef !== binding.ownerElementRef ||
            binding.projectionSchemaId !== descriptor.projectionSchemaId ||
            binding.dimensions !== descriptor.dimensions
          );
        })
      ) {
        return yield* fail("invalid_inventory", "The retrieval binding is incomplete or invalid.");
      }
      return {
        binding: {
          graphRef: handle.snapshot.graphRef,
          scopeRef: handle.snapshot.scopeRef,
          graphDigest: handle.snapshot.graphDigest,
          manifestDigest: handle.manifest.manifestDigest,
          inventoryDigest: currentInventory.inventoryDigest,
          retrievalDigest: currentRetrieval.retrievalDigest,
          descriptorRef: descriptor.descriptorRef,
          limits,
          maxResults: Math.min(limits.maxVisitedElements, limits.maxReturnedElements + 1),
        },
        owners: new Set(selectedBindings.map(({ ownerElementRef }) => ownerElementRef)),
        kinds: new Set(descriptor.elementKinds),
      };
    });
  return Object.freeze({
    lookup: (elementRef, limits) =>
      Effect.gen(function* () {
        yield* requireGraphAdapterCapability(capabilities, "graph_read").pipe(
          Effect.mapError(() => fail("invalid_projection", "Graph read is not supported.")),
        );
        const element = byRef.get(elementRef);
        if (element === undefined)
          return yield* fail("not_found", "The graph element was not found.");
        return yield* execute({ kind: "lookup", elementRef }, [element], 1, limits);
      }),
    neighbors: (elementRef, limitsInput) =>
      Effect.gen(function* () {
        yield* requireGraphAdapterCapability(capabilities, "graph_read").pipe(
          Effect.mapError(() => fail("invalid_projection", "Graph read is not supported.")),
        );
        yield* assertFresh();
        const limits = yield* decodeLimits(limitsInput);
        if (!byRef.has(elementRef))
          return yield* fail("not_found", "The graph element was not found.");
        const queue: Array<{ readonly ref: string; readonly depth: number }> = [
          { ref: elementRef, depth: 0 },
        ];
        const seen = new Set<string>([elementRef]);
        const found: Array<GraphReadableElement> = [];
        const caps = new Set<GraphRlmHitCap>();
        while (queue.length > 0) {
          const current = queue.shift();
          if (current === undefined) continue;
          const element = byRef.get(current.ref);
          if (element !== undefined) found.push(element);
          const next = [...(adjacent.get(current.ref) ?? [])].sort(compareCanonicalText);
          if (current.depth >= limits.maxDepth) {
            if (next.some((ref) => !seen.has(ref))) caps.add("max_depth");
            continue;
          }
          for (const ref of next) {
            if (seen.has(ref)) continue;
            if (seen.size >= limits.maxVisitedElements) {
              caps.add("max_visited_elements");
              break;
            }
            seen.add(ref);
            queue.push({ ref, depth: current.depth + 1 });
          }
        }
        const result = makeResult(
          handle,
          entries,
          {
            operation: { projectionBinding, request: { kind: "neighbors", elementRef } },
            candidates: found,
            visitedElements: seen.size,
            initialCaps: [...caps],
          },
          limits,
          projectionBinding,
        );
        yield* assertFresh();
        return result;
      }),
    expandSource: (source, limitsInput) =>
      Effect.gen(function* () {
        yield* requireGraphAdapterCapability(capabilities, "graph_read").pipe(
          Effect.mapError(() => fail("invalid_projection", "Graph read is not supported.")),
        );
        yield* assertFresh();
        const limits = yield* decodeLimits(limitsInput);
        const key = sourceKey(source);
        const candidates: Array<GraphReadableElement> = [];
        let visited = 0;
        for (const element of elements) {
          if (visited >= limits.maxVisitedElements) break;
          visited += 1;
          if (canonicalSources(element).some((candidate) => sourceKey(candidate) === key)) {
            candidates.push(element);
          }
        }
        const initialCaps: ReadonlyArray<GraphRlmHitCap> =
          visited < elements.length ? ["max_visited_elements"] : [];
        const result = makeResult(
          handle,
          entries,
          {
            operation: { projectionBinding, request: { kind: "expand_source", source } },
            candidates,
            visitedElements: visited,
            initialCaps,
          },
          limits,
          projectionBinding,
        );
        yield* assertFresh();
        return result;
      }),
    searchText: (query, limitsInput) =>
      Effect.gen(function* () {
        yield* requireGraphAdapterCapability(capabilities, "graph_read").pipe(
          Effect.mapError(() => fail("invalid_projection", "Graph read is not supported.")),
        );
        yield* assertFresh();
        const limits = yield* decodeLimits(limitsInput);
        const normalized = query.normalize("NFC").toLocaleLowerCase("en-US");
        if (normalized.length === 0 || normalized.length > 2048) {
          return yield* fail("invalid_limits", "Text query must contain 1 to 2048 characters.");
        }
        const candidates: Array<GraphReadableElement> = [];
        let visited = 0;
        for (const element of elements) {
          if (visited >= limits.maxVisitedElements) break;
          visited += 1;
          const fields =
            element.elementKind === "relation"
              ? [element.identity.canonicalKey, element.relationKind]
              : [element.identity.canonicalKey];
          if (fields.some((field) => field.toLocaleLowerCase("en-US").includes(normalized))) {
            candidates.push(element);
          }
        }
        const initialCaps: ReadonlyArray<GraphRlmHitCap> =
          visited < elements.length ? ["max_visited_elements"] : [];
        const result = makeResult(
          handle,
          entries,
          {
            operation: { projectionBinding, request: { kind: "text_search", query: normalized } },
            candidates,
            visitedElements: visited,
            initialCaps,
          },
          limits,
          projectionBinding,
        );
        yield* assertFresh();
        return result;
      }),
    searchVector: (descriptorRef, vector, limits) =>
      Effect.gen(function* () {
        yield* requireVector("vector_read");
        if (callbacks.vectorSearch === undefined) {
          return yield* fail("unsupported_callback", "The vector callback is not configured.");
        }
        const decodedLimits = yield* decodeLimits(limits);
        const selected = yield* searchBinding(descriptorRef, vector, decodedLimits);
        yield* assertFresh();
        const request = yield* Effect.try({
          try: () =>
            S.decodeUnknownSync(GraphRlmVectorSearchRequest)({ ...selected.binding, vector }),
          catch: () => fail("invalid_limits", "The vector request is invalid."),
        });
        const response = yield* callbacks.vectorSearch(request).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => S.decodeUnknownSync(GraphRlmSearchResponse)(value),
              catch: () => fail("invalid_inventory", "The vector response schema is invalid."),
            }),
          ),
        );
        yield* assertFresh();
        yield* requireVector("vector_read");
        const { results, schemaId, ...responseBinding } = response;
        if (
          schemaId !== GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID ||
          canonicalJson(responseBinding) !== canonicalJson(selected.binding) ||
          results.length > selected.binding.maxResults
        ) {
          return yield* fail("invalid_inventory", "The vector response binding is invalid.");
        }
        const scored = yield* refsFromScores(results, selected.owners, selected.kinds);
        const initialCaps: ReadonlyArray<GraphRlmHitCap> =
          results.length === selected.binding.maxResults &&
          selected.binding.maxResults === decodedLimits.maxVisitedElements
            ? ["max_visited_elements"]
            : [];
        return yield* execute(
          {
            kind: "vector_search",
            descriptorRef,
            vectorDigest: digest(vector),
            artifactInventoryDigest: selected.binding.inventoryDigest,
            retrievalDigest: selected.binding.retrievalDigest,
          },
          scored.elements,
          scored.elements.length,
          decodedLimits,
          initialCaps,
          scored.scores,
        );
      }),
    searchHybrid: (descriptorRef, vector, textQuery, limits) =>
      Effect.gen(function* () {
        yield* requireVector("hybrid_query");
        if (callbacks.hybridSearch === undefined) {
          return yield* fail("unsupported_callback", "The hybrid callback is not configured.");
        }
        const decodedLimits = yield* decodeLimits(limits);
        const selected = yield* searchBinding(descriptorRef, vector, decodedLimits);
        yield* assertFresh();
        const request = yield* Effect.try({
          try: () =>
            S.decodeUnknownSync(GraphRlmHybridSearchRequest)({
              ...selected.binding,
              vector,
              textQuery,
            }),
          catch: () => fail("invalid_limits", "The hybrid request is invalid."),
        });
        const response = yield* callbacks.hybridSearch(request).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => S.decodeUnknownSync(GraphRlmSearchResponse)(value),
              catch: () => fail("invalid_inventory", "The hybrid response schema is invalid."),
            }),
          ),
        );
        yield* assertFresh();
        yield* requireVector("hybrid_query");
        const { results, schemaId, ...responseBinding } = response;
        if (
          schemaId !== GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID ||
          canonicalJson(responseBinding) !== canonicalJson(selected.binding) ||
          results.length > selected.binding.maxResults
        ) {
          return yield* fail("invalid_inventory", "The hybrid response binding is invalid.");
        }
        const scored = yield* refsFromScores(results, selected.owners, selected.kinds);
        const initialCaps: ReadonlyArray<GraphRlmHitCap> =
          results.length === selected.binding.maxResults &&
          selected.binding.maxResults === decodedLimits.maxVisitedElements
            ? ["max_visited_elements"]
            : [];
        return yield* execute(
          {
            kind: "hybrid_search",
            descriptorRef,
            vectorDigest: digest(vector),
            artifactInventoryDigest: selected.binding.inventoryDigest,
            retrievalDigest: selected.binding.retrievalDigest,
            textQuery,
          },
          scored.elements,
          scored.elements.length,
          decodedLimits,
          initialCaps,
          scored.scores,
        );
      }),
  } satisfies GraphRlmOperators);
};

export interface MakeGraphRlmProjectionInput {
  readonly handle: GraphSnapshotHandle;
  readonly capabilities: GraphAdapterCapabilities;
  readonly classification: GraphRlmClassificationProjection;
  readonly corpusRef: string;
  readonly inventory?: GraphCompleteArtifactInventory;
  readonly retrievalInventory?: GraphRlmRetrievalInventory;
  readonly callbacks?: GraphRlmSearchCallbacks;
  /** Authorized source corpora that validate the retained supporting locators. */
  readonly supportingCorpora: ReadonlyArray<RlmCorpusHandle>;
}

const snapshotCorpusHandle = (source: RlmCorpusHandle): RlmCorpusHandle => {
  const identity = cloneFrozen(source.identity);
  const manifest = cloneFrozen(source.manifest);
  const assertUnchanged = Effect.fn("GraphCorpus.Rlm.support.assertUnchanged")(function* () {
    yield* source.assertUnchanged();
    if (
      canonicalJson(source.identity) !== canonicalJson(identity) ||
      canonicalJson(source.manifest) !== canonicalJson(manifest)
    ) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "A supporting corpus identity or manifest changed.",
      });
    }
  });
  return Object.freeze({
    identity,
    manifest,
    assertUnchanged,
    read: (range, limits) =>
      assertUnchanged().pipe(Effect.andThen(source.read(range, limits)), Effect.map(cloneFrozen)),
    scan: (request) =>
      Stream.unwrap(
        assertUnchanged().pipe(Effect.as(source.scan(request).pipe(Stream.map(cloneFrozen)))),
      ),
    validateSourceAddress: (address, plane) =>
      assertUnchanged().pipe(
        Effect.andThen(source.validateSourceAddress(address, plane)),
        Effect.map(cloneFrozen),
      ),
    validateSourceLocator: (locator) =>
      assertUnchanged().pipe(
        Effect.andThen(source.validateSourceLocator(locator)),
        Effect.map(cloneFrozen),
      ),
    materializeAll: () =>
      assertUnchanged().pipe(Effect.andThen(source.materializeAll()), Effect.map(cloneFrozen)),
  } satisfies RlmCorpusHandle);
};

/** Adapt one immutable graph snapshot to an immutable RLM v2 corpus and graph operator surface. */
export const makeGraphRlmProjection = Effect.fn("GraphCorpus.makeRlmProjection")(function* (
  input: MakeGraphRlmProjectionInput,
) {
  yield* requireGraphAdapterCapability(input.capabilities, "rlm_v2_projection");
  yield* input.handle.assertUnchanged();
  const supportingCorpora = input.supportingCorpora.map(snapshotCorpusHandle);
  const classifications = yield* validateClassification(
    input.handle,
    input.classification,
    supportingCorpora,
  );
  const elements = allElements(input.handle);
  const entryInputs = yield* Effect.forEach(elements, (element) =>
    Effect.gen(function* () {
      const classification = classifications.get(element.elementRef);
      if (classification === undefined) {
        return yield* fail("invalid_projection", "A graph classification is absent.");
      }
      return {
        entryRef: element.elementRef,
        scopeRef: input.handle.snapshot.scopeRef,
        sourcePlane: "derived_graph" as const,
        sourceKind: `graph_${element.elementKind}`,
        sourceAddress: graphAddress(input.handle, element),
        supportingSources: canonicalSources(element),
        text: safeText(element),
        visibility: classification.visibility,
        redactionClass: classification.redactionClass,
      };
    }),
  );
  const inline = cloneFrozen(
    buildInlineCorpusInput({
      corpusRef: input.corpusRef,
      scopeRef: input.handle.snapshot.scopeRef,
      policy: input.handle.snapshot.policy as GraphCorpusPolicy,
      orderingRule: "explicit_array",
      orderingNote: "Canonical graph element reference order.",
      coverageNote: "Complete readable graph projection.",
      entries: entryInputs,
    }),
  );
  const base = yield* makeInlineCorpusHandle(inline);
  const expectedIdentity = cloneFrozen(base.identity);
  const expectedManifest = cloneFrozen(base.manifest);
  for (const entry of inline.entries) {
    const sourceVisibilities: Array<RlmVisibility> = [];
    const sourceRedactions: Array<RlmRedactionClass> = [];
    for (const source of entry.supportingSources ?? []) {
      const candidates = supportingCorpora.filter(
        ({ identity }) =>
          identity.corpusRef === source.corpusRef &&
          identity.contentDigest === source.contentDigest,
      );
      if (candidates.length !== 1) {
        return yield* fail(
          "incomplete_citation",
          "Each supporting locator must have one authorized source corpus.",
        );
      }
      const candidate = candidates[0];
      if (candidate === undefined) {
        return yield* fail("incomplete_citation", "A supporting source corpus is absent.");
      }
      if (candidate.manifest.composition !== undefined) {
        return yield* fail(
          "incomplete_citation",
          "Supporting corpus handles must be exact leaf corpora.",
        );
      }
      const validated = yield* candidate
        .validateSourceLocator(source)
        .pipe(
          Effect.mapError(() =>
            fail("incomplete_citation", "A supporting locator is not valid in its source corpus."),
          ),
        );
      const sourceEntries = yield* candidate
        .read(
          { start: validated.ordinal, endInclusive: validated.ordinal },
          { maxEntries: 1, maxCharsPerEntry: 0 },
        )
        .pipe(
          Effect.mapError(() =>
            fail("incomplete_citation", "A supporting source entry is unavailable."),
          ),
        );
      const sourceEntry = sourceEntries[0];
      if (sourceEntry === undefined) {
        return yield* fail("incomplete_citation", "A supporting source entry is absent.");
      }
      sourceVisibilities.push(sourceEntry.visibility);
      sourceRedactions.push(sourceEntry.redactionClass);
    }
    const joinedVisibility = [...sourceVisibilities].sort(
      (left, right) => visibilityOrder.indexOf(right) - visibilityOrder.indexOf(left),
    )[0];
    const joinedRedaction = [...sourceRedactions].sort(
      (left, right) => redactionOrder.indexOf(right) - redactionOrder.indexOf(left),
    )[0];
    if (joinedVisibility !== entry.visibility || joinedRedaction !== entry.redactionClass) {
      return yield* fail(
        "invalid_projection",
        "An element classification is not the conservative join of its supporting sources.",
      );
    }
  }
  const assertUnchanged = Effect.fn("GraphCorpus.Rlm.assertUnchanged")(function* () {
    yield* input.handle
      .assertUnchanged()
      .pipe(
        Effect.mapError(
          () =>
            new RlmCorpusError({ reason: "changed", detailSafe: "The graph snapshot changed." }),
        ),
      );
    yield* validateClassification(input.handle, input.classification, supportingCorpora).pipe(
      Effect.mapError(
        () =>
          new RlmCorpusError({
            reason: "changed",
            detailSafe: "The graph classification changed.",
          }),
      ),
    );
    yield* Effect.forEach(supportingCorpora, (handle) => handle.assertUnchanged(), {
      discard: true,
    });
    const rebuilt = yield* makeInlineCorpusHandle(inline);
    if (
      canonicalJson(rebuilt.identity) !== canonicalJson(expectedIdentity) ||
      canonicalJson(rebuilt.manifest) !== canonicalJson(expectedManifest)
    ) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "The graph RLM corpus identity or manifest changed.",
      });
    }
  });
  const corpus: RlmCorpusHandle = {
    ...base,
    identity: expectedIdentity,
    manifest: expectedManifest,
    assertUnchanged,
    read: (range, limits) =>
      assertUnchanged().pipe(Effect.andThen(base.read(range, limits)), Effect.map(cloneFrozen)),
    scan: (request) =>
      Stream.unwrap(
        assertUnchanged().pipe(Effect.as(base.scan(request).pipe(Stream.map(cloneFrozen)))),
      ),
    validateSourceAddress: (address, plane) =>
      assertUnchanged().pipe(
        Effect.andThen(base.validateSourceAddress(address, plane)),
        Effect.map(cloneFrozen),
      ),
    validateSourceLocator: (locator) =>
      assertUnchanged().pipe(
        Effect.andThen(
          base.validateSourceLocator(locator).pipe(
            Effect.catch(() => {
              const candidates = supportingCorpora.filter(
                ({ identity }) =>
                  identity.corpusRef === locator.corpusRef &&
                  identity.contentDigest === locator.contentDigest,
              );
              const candidate = candidates.length === 1 ? candidates[0] : undefined;
              return candidate !== undefined
                ? candidate.validateSourceLocator(locator)
                : Effect.fail(
                    new RlmCorpusError({
                      reason: "invalid_address",
                      detailSafe: "Supporting source locator is not in an authorized corpus.",
                    }),
                  );
            }),
          ),
        ),
        Effect.map(cloneFrozen),
      ),
    materializeAll: () =>
      assertUnchanged().pipe(Effect.andThen(base.materializeAll()), Effect.map(cloneFrozen)),
  };
  Object.freeze(corpus);
  const sourceAddress: GraphRlmSourceAddress = S.decodeUnknownSync(GraphRlmSourceAddress)({
    schemaId: GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID,
    graphRef: input.handle.snapshot.graphRef,
    scopeRef: input.handle.snapshot.scopeRef,
    graphDigest: input.handle.snapshot.graphDigest,
    graphManifestDigest: input.handle.manifest.manifestDigest,
    classificationDigest: input.classification.projectionDigest,
    corpusRef: corpus.identity.corpusRef,
    contentDigest: corpus.identity.contentDigest,
    manifestDigest: corpus.identity.manifestDigest,
  });
  const entries = new Map(inline.entries.map((entry) => [entry.entryRef, entry]));
  const assertOperatorFresh = () =>
    assertUnchanged().pipe(
      Effect.mapError(() => fail("projection_changed", "The graph RLM projection changed.")),
    );
  const projectionBinding = {
    corpus: corpus.identity,
    classificationDigest: input.classification.projectionDigest,
    supportingCorpora: input.classification.supportingCorpora.map(({ identity }) => identity),
  };
  const capabilities = cloneFrozen(input.capabilities);
  const inventory = input.inventory === undefined ? undefined : cloneFrozen(input.inventory);
  const retrievalInventory =
    input.retrievalInventory === undefined ? undefined : cloneFrozen(input.retrievalInventory);
  const sourceRef = Object.freeze({
    addressSchemaId: GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID,
    encodedAddress: canonicalJson(sourceAddress),
  });
  const operators = makeOperators(
    input.handle,
    entries,
    capabilities,
    inventory,
    retrievalInventory,
    Object.freeze({ ...(input.callbacks ?? {}) }),
    assertOperatorFresh,
    projectionBinding,
  );
  return Object.freeze({
    classification: cloneFrozen(input.classification),
    corpus,
    sourceRef,
    operators,
  } satisfies GraphRlmProjection);
});

/** Make a resolver for a fixed set of immutable graph projections. */
export const makeGraphRlmCorpusSource = (
  projections: ReadonlyArray<GraphRlmProjection>,
): RlmCorpusSourceShape => {
  const bySource = new Map<string, GraphRlmProjection>();
  const duplicateSources = new Set<string>();
  for (const projection of projections) {
    const key = canonicalJson(projection.sourceRef);
    if (bySource.has(key)) duplicateSources.add(key);
    else bySource.set(key, projection);
  }
  return {
    resolve: (input: RlmCorpusInput) => {
      if (input._tag !== "Source") {
        return Effect.fail(
          new RlmCorpusError({
            reason: "unavailable",
            detailSafe: "Only graph sources resolve here.",
          }),
        );
      }
      if (input.sourceRef.addressSchemaId !== GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID) {
        return Effect.fail(
          new RlmCorpusError({
            reason: "invalid_address",
            detailSafe: "Unknown graph source schema.",
          }),
        );
      }
      const key = canonicalJson(input.sourceRef);
      if (duplicateSources.has(key)) {
        return Effect.fail(
          new RlmCorpusError({
            reason: "duplicate_source",
            detailSafe: "The graph source registration is ambiguous.",
          }),
        );
      }
      const projection = bySource.get(key);
      if (projection === undefined) {
        return Effect.fail(
          new RlmCorpusError({
            reason: "invalid_address",
            detailSafe: "Graph source is not registered.",
          }),
        );
      }
      return projection.corpus.assertUnchanged().pipe(Effect.as(projection.corpus));
    },
  };
};

/** Decode a graph element address. Use this at an external address boundary. */
export const decodeGraphElementAddress = (
  address: RlmSourceAddress,
): Effect.Effect<GraphElementAddress, RlmCorpusError> =>
  Effect.try({
    try: () => {
      if (address.addressSchemaId !== GRAPH_ELEMENT_ADDRESS_SCHEMA_ID) {
        throw new Error("unknown schema");
      }
      return S.decodeUnknownSync(GraphElementAddress)(JSON.parse(address.encodedAddress));
    },
    catch: () =>
      new RlmCorpusError({
        reason: "invalid_address",
        detailSafe: "The graph element address is invalid.",
      }),
  });

/** Convenience decoder for callers that receive an untyped element ref. */
export const decodeGraphElementRef = (value: unknown): GraphElementRef => graphElementRef(value);
