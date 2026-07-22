import { Effect, Schema as S } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { buildInlineCorpusInput, makeInlineCorpusHandle } from "@openagentsinc/rlm/corpus";
import { RlmCorpusError } from "@openagentsinc/rlm/schemas";

import {
  GraphDerivation,
  GraphVectorArtifact,
  GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
  buildGraphCorpus,
  canonicalJson,
  graphDigest,
  makeCanonicalEntity,
  makeEmbeddingProjectionDescriptor,
  makeGraphArtifactInventory,
  makeGraphMention,
  makeGraphAdapterCapabilities,
  makeGraphRlmClassificationProjection,
  makeGraphRlmProjection,
  makeGraphRlmRetrievalInventory,
  makeInMemoryGraphSnapshotHandle,
  planGraphSourceDeletion,
  sha256Hex,
  type BuiltGraphCorpus,
  type GraphCompleteArtifactInventory,
  type GraphRlmOperationResult,
} from "./index.ts";
import {
  GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
  GraphRankingError,
  GraphRankingOperationBinding,
  graphRankingQueryDigest,
  makeGraphFeedbackObservation,
  makeGraphRankingSnapshot,
  rankGraphOperationResult,
  rankingArtifactsFromSnapshot,
  validateGraphRankingSnapshot,
  validateGraphUsedElementEvidence,
  verifyGraphRankingOperationResult,
  type GraphRankingConfidence,
  type GraphRankingSnapshot,
} from "./ranking.ts";

const derivation = S.decodeUnknownSync(GraphDerivation)({
  _tag: "Deterministic",
  parserRef: "parser.ranking.fixture.v1",
  parserVersion: "1.0.0",
});
const policy = {
  includeVisibilities: ["private"] as const,
  includeRedactionClasses: ["none"] as const,
};
const fixture = async (graphRef = "graph.ranking.fixture") => {
  const original = await Effect.runPromise(
    makeInlineCorpusHandle(
      buildInlineCorpusInput({
        corpusRef: "source.fixture",
        scopeRef: "tenant.a",
        policy,
        entries: ["a", "b"].map((entryRef) => ({
          entryRef,
          scopeRef: "tenant.a",
          sourcePlane: "repository" as const,
          sourceKind: "fixture",
          sourceAddress: {
            addressSchemaId: "fixture.address.v1",
            encodedAddress: `path:${entryRef}`,
          },
          text: `source ${entryRef}`,
          visibility: "private" as const,
          redactionClass: "none" as const,
        })),
      }),
    ),
  );
  const [sourceA, sourceB] = await Promise.all(
    ["a", "b"].map((entryRef) =>
      Effect.runPromise(
        original
          .validateSourceAddress({
            addressSchemaId: "fixture.address.v1",
            encodedAddress: `path:${entryRef}`,
          })
          .pipe(Effect.map(({ origin }) => origin)),
      ),
    ),
  );
  const mentionA = makeGraphMention({
    identityNamespace: "fixture",
    canonicalKey: "mention:a",
    identityScopeRef: "tenant.a",
    source: sourceA,
    derivation,
  });
  const mentionB = makeGraphMention({
    identityNamespace: "fixture",
    canonicalKey: "mention:b",
    identityScopeRef: "tenant.a",
    source: sourceB,
    derivation,
  });
  const entity = makeCanonicalEntity({
    identityNamespace: "fixture",
    canonicalKey: "entity:ab",
    identityScopeRef: "tenant.a",
    mentions: [mentionA, mentionB],
    derivation,
  });
  const descriptor = makeEmbeddingProjectionDescriptor({
    projectionSchemaId: "graph.embedding.ranking.v1",
    elementKinds: ["mention", "entity"],
    embeddableFields: ["identity.canonicalKey"],
    dimensions: 2,
  });
  const built = await Effect.runPromise(
    buildGraphCorpus({
      graphRef,
      scopeRef: "tenant.a",
      policy,
      mentions: [mentionB, mentionA],
      entities: [entity],
      relations: [],
      embeddingProjections: [descriptor],
    }),
  );
  const limits = {
    maxDepth: 4,
    maxVisitedElements: 10,
    maxReturnedElements: 10,
    maxSourceAddresses: 10,
    maxCharactersPerResult: 2_048,
    maxObservationCharacters: 10_000,
  };
  const handle = await Effect.runPromise(makeInMemoryGraphSnapshotHandle(built));
  const classification = makeGraphRlmClassificationProjection(
    handle,
    [...built.snapshot.mentions, ...built.snapshot.entities].map(({ elementRef }) => ({
      elementRef,
      visibility: "private" as const,
      redactionClass: "none" as const,
    })),
    [original],
  );
  const projection = await Effect.runPromise(
    makeGraphRlmProjection({
      handle,
      capabilities: makeGraphAdapterCapabilities(["graph_read", "rlm_v2_projection"]),
      classification,
      corpusRef: "rlm.graph.ranking.fixture",
      supportingCorpora: [original],
    }),
  );
  const result = await Effect.runPromise(projection.operators.neighbors(entity.elementRef, limits));
  if (result._tag !== "Complete") throw new Error("The ranking fixture did not complete.");
  const binding = S.decodeUnknownSync(GraphRankingOperationBinding)({
    schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
    _tag: "Neighbors",
    elementRef: entity.elementRef,
  });
  return {
    built,
    projection,
    result,
    expectedOperationDigest: result.operationDigest,
    binding,
    mentionA,
    mentionB,
    entity,
    sourceA,
    original,
    handle,
    classification,
    descriptor,
    limits,
  };
};

const makeConfidence = (
  built: BuiltGraphCorpus,
  result: GraphRlmOperationResult,
  elementRef: string,
  confidenceMicros: number,
  evidenceRef: string,
): GraphRankingConfidence => ({
  graphRef: built.snapshot.graphRef,
  scopeRef: built.snapshot.scopeRef,
  graphDigest: result.graphDigest,
  manifestDigest: result.manifestDigest,
  corpusRef: result.corpusRef,
  contentDigest: result.contentDigest,
  corpusManifestDigest: result.corpusManifestDigest,
  classificationDigest: result.classificationDigest,
  elementRef: elementRef as GraphRankingConfidence["elementRef"],
  confidenceMicros,
  evidenceRef: evidenceRef as GraphRankingConfidence["evidenceRef"],
});

const recomputeNeighborsDigest = (
  result: GraphRlmOperationResult,
  projection: Awaited<ReturnType<typeof fixture>>["projection"],
  elementRef: string,
) =>
  graphDigest(
    sha256Hex(
      canonicalJson({
        operation: {
          projectionBinding: {
            corpus: projection.corpus.identity,
            classificationDigest: projection.classification.projectionDigest,
            supportingCorpora: projection.classification.supportingCorpora
              .map(({ identity }) => identity)
              .sort((left, right) => {
                const leftText = canonicalJson(left);
                const rightText = canonicalJson(right);
                return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
              }),
          },
          request: { kind: "neighbors", elementRef },
        },
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
      }),
    ),
  );

describe("graph ranking feedback snapshots", () => {
  test("binds all six operation forms without raw vector bytes", async () => {
    const {
      built,
      projection,
      result,
      expectedOperationDigest,
      binding,
      mentionA,
      sourceA,
      limits,
    } = await fixture();
    const lookupBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "Lookup",
      elementRef: mentionA.elementRef,
    });
    const expandBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "ExpandSource",
      source: sourceA,
    });
    const textBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "TextSearch",
      textQuery: "mention",
    });
    const vectorBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "VectorSearch",
      descriptorRef: "graph.descriptor.fixture",
      vectorDigest: "a".repeat(64),
      artifactInventoryDigest: "b".repeat(64),
      retrievalDigest: "c".repeat(64),
    });
    const hybridBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "HybridSearch",
      descriptorRef: "graph.descriptor.fixture",
      vectorDigest: "a".repeat(64),
      artifactInventoryDigest: "b".repeat(64),
      retrievalDigest: "c".repeat(64),
      textQuery: "mention",
    });
    const lookup = await Effect.runPromise(
      projection.operators.lookup(mentionA.elementRef, limits),
    );
    const expanded = await Effect.runPromise(projection.operators.expandSource(sourceA, limits));
    const text = await Effect.runPromise(projection.operators.searchText("mention", limits));
    for (const pair of [
      { result, binding },
      { result: lookup, binding: lookupBinding },
      { result: expanded, binding: expandBinding },
      { result: text, binding: textBinding },
    ]) {
      await Effect.runPromise(
        verifyGraphRankingOperationResult({
          built,
          projection,
          expectedOperationDigest: pair.result.operationDigest,
          ...pair,
        }),
      );
    }
    const digests = [
      binding,
      lookupBinding,
      expandBinding,
      textBinding,
      vectorBinding,
      hybridBinding,
    ].map(graphRankingQueryDigest);
    expect(new Set(digests)).toHaveLength(6);
    expect(JSON.stringify([vectorBinding, hybridBinding])).not.toContain("[1,0]");
  });

  test("verifies provider-backed vector and hybrid receipts against pinned retrieval context", async () => {
    const { built, handle, classification, original, descriptor, entity, mentionA, limits } =
      await fixture();
    const inventory = makeGraphArtifactInventory({
      built,
      vectors: [
        S.decodeUnknownSync(GraphVectorArtifact)({
          artifactKind: "vector",
          artifactRef: "vector.ranking.entity",
          artifactDigest: "d".repeat(64),
          ownerElementRef: entity.elementRef,
        }),
        S.decodeUnknownSync(GraphVectorArtifact)({
          artifactKind: "vector",
          artifactRef: "vector.ranking.mention-a",
          artifactDigest: "e".repeat(64),
          ownerElementRef: mentionA.elementRef,
        }),
      ],
      summaries: [],
      rankingRefs: [],
      coverage: {
        vectors: { _tag: "Complete" },
        summaries: { _tag: "Complete" },
        rankingRefs: { _tag: "Complete" },
      },
    }) as GraphCompleteArtifactInventory;
    const retrievalInventory = await Effect.runPromise(
      makeGraphRlmRetrievalInventory(handle, inventory, [
        {
          artifactRef: "vector.ranking.entity",
          ownerElementRef: entity.elementRef,
          descriptorRef: descriptor.descriptorRef,
          projectionSchemaId: descriptor.projectionSchemaId,
          dimensions: descriptor.dimensions,
        },
        {
          artifactRef: "vector.ranking.mention-a",
          ownerElementRef: mentionA.elementRef,
          descriptorRef: descriptor.descriptorRef,
          projectionSchemaId: descriptor.projectionSchemaId,
          dimensions: descriptor.dimensions,
        },
      ]),
    );
    const providerProjection = await Effect.runPromise(
      makeGraphRlmProjection({
        handle,
        capabilities: makeGraphAdapterCapabilities([
          "graph_read",
          "rlm_v2_projection",
          "vector_read",
          "hybrid_query",
        ]),
        classification,
        corpusRef: "rlm.graph.ranking.fixture",
        supportingCorpora: [original],
        inventory,
        retrievalInventory,
        callbacks: {
          vectorSearch: ({ vector: _vector, ...responseBinding }) =>
            Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...responseBinding,
              results: [{ elementRef: entity.elementRef, scoreMicros: 900_000 }],
            }),
          hybridSearch: ({ vector: _vector, textQuery: _textQuery, ...responseBinding }) =>
            Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...responseBinding,
              results: [{ elementRef: mentionA.elementRef, scoreMicros: 800_000 }],
            }),
        },
      }),
    );
    const vector = [1, 0] as const;
    const vectorDigest = graphDigest(sha256Hex(canonicalJson(vector)));
    const providerContext = { inventory, retrievalInventory };
    const vectorResult = await Effect.runPromise(
      providerProjection.operators.searchVector(descriptor.descriptorRef, vector, limits),
    );
    const vectorBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "VectorSearch",
      descriptorRef: descriptor.descriptorRef,
      vectorDigest,
      artifactInventoryDigest: inventory.inventoryDigest,
      retrievalDigest: retrievalInventory.retrievalDigest,
    });
    await Effect.runPromise(
      verifyGraphRankingOperationResult({
        built,
        projection: providerProjection,
        result: vectorResult,
        expectedOperationDigest: vectorResult.operationDigest,
        binding: vectorBinding,
        providerContext,
      }),
    );

    const hybridResult = await Effect.runPromise(
      providerProjection.operators.searchHybrid(
        descriptor.descriptorRef,
        vector,
        "mention",
        limits,
      ),
    );
    const hybridBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "HybridSearch",
      descriptorRef: descriptor.descriptorRef,
      vectorDigest,
      artifactInventoryDigest: inventory.inventoryDigest,
      retrievalDigest: retrievalInventory.retrievalDigest,
      textQuery: "mention",
    });
    await Effect.runPromise(
      verifyGraphRankingOperationResult({
        built,
        projection: providerProjection,
        result: hybridResult,
        expectedOperationDigest: hybridResult.operationDigest,
        binding: hybridBinding,
        providerContext,
      }),
    );

    await expect(
      Effect.runPromise(
        verifyGraphRankingOperationResult({
          built,
          projection: providerProjection,
          result: vectorResult,
          expectedOperationDigest: graphDigest("0".repeat(64)),
          binding: vectorBinding,
          providerContext,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });
    const substitutedBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      ...vectorBinding,
      descriptorRef: "graph.descriptor.substituted",
    });
    await expect(
      Effect.runPromise(
        verifyGraphRankingOperationResult({
          built,
          projection: providerProjection,
          result: vectorResult,
          expectedOperationDigest: vectorResult.operationDigest,
          binding: substitutedBinding,
          providerContext,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });

    const alternateInventory = makeGraphArtifactInventory({
      built,
      vectors: [
        S.decodeUnknownSync(GraphVectorArtifact)({
          artifactKind: "vector",
          artifactRef: "vector.ranking.entity.alternate",
          artifactDigest: "a".repeat(64),
          ownerElementRef: entity.elementRef,
        }),
        S.decodeUnknownSync(GraphVectorArtifact)({
          artifactKind: "vector",
          artifactRef: "vector.ranking.mention-a.alternate",
          artifactDigest: "b".repeat(64),
          ownerElementRef: mentionA.elementRef,
        }),
      ],
      summaries: [],
      rankingRefs: [],
      coverage: {
        vectors: { _tag: "Complete" },
        summaries: { _tag: "Complete" },
        rankingRefs: { _tag: "Complete" },
      },
    }) as GraphCompleteArtifactInventory;
    const alternateRetrievalInventory = await Effect.runPromise(
      makeGraphRlmRetrievalInventory(handle, alternateInventory, [
        {
          artifactRef: "vector.ranking.entity.alternate",
          ownerElementRef: entity.elementRef,
          descriptorRef: descriptor.descriptorRef,
          projectionSchemaId: descriptor.projectionSchemaId,
          dimensions: descriptor.dimensions,
        },
        {
          artifactRef: "vector.ranking.mention-a.alternate",
          ownerElementRef: mentionA.elementRef,
          descriptorRef: descriptor.descriptorRef,
          projectionSchemaId: descriptor.projectionSchemaId,
          dimensions: descriptor.dimensions,
        },
      ]),
    );
    const alternateBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      ...vectorBinding,
      artifactInventoryDigest: alternateInventory.inventoryDigest,
      retrievalDigest: alternateRetrievalInventory.retrievalDigest,
    });
    await expect(
      Effect.runPromise(
        verifyGraphRankingOperationResult({
          built,
          projection: providerProjection,
          result: vectorResult,
          expectedOperationDigest: vectorResult.operationDigest,
          binding: alternateBinding,
          providerContext: {
            inventory: alternateInventory,
            retrievalInventory: alternateRetrievalInventory,
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });
  });

  test("builds deterministic fixed-point snapshots without changing graph identity", async () => {
    const { built, projection, result, expectedOperationDigest, binding, mentionA, entity } =
      await fixture();
    const graphBefore = JSON.stringify(built);
    const feedbackA = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionA.elementRef,
        feedbackWeightMicros: 300_000,
        evidenceRef: "feedback-event.a",
      }),
    );
    const feedbackB = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionA.elementRef,
        feedbackWeightMicros: -100_000,
        evidenceRef: "feedback-event.b",
      }),
    );
    const confidenceA = makeConfidence(
      built,
      result,
      entity.elementRef,
      800_000,
      "confidence.entity",
    );
    const first = await Effect.runPromise(
      makeGraphRankingSnapshot({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        feedbackObservations: [feedbackB, feedbackA],
        confidences: [confidenceA],
      }),
    );
    const second = await Effect.runPromise(
      makeGraphRankingSnapshot({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        feedbackObservations: [feedbackA, feedbackB],
        confidences: [confidenceA],
      }),
    );

    expect(first).toEqual(second);
    expect(first.features.find((item) => item.elementRef === mentionA.elementRef)).toMatchObject({
      feedbackWeightMicros: 200_000,
    });
    expect(JSON.stringify(built)).toBe(graphBefore);
    expect(first.snapshotDigest).not.toBe(built.snapshot.graphDigest);
    expect(Object.isFrozen(feedbackA)).toBe(true);
    expect(() => Object.defineProperty(feedbackA, "feedbackWeightMicros", { value: 0 })).toThrow();
    expect(() =>
      Object.defineProperty(first.features[0]!, "feedbackWeightMicros", { value: 123 }),
    ).toThrow();
    await Effect.runPromise(
      validateGraphRankingSnapshot(first, {
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
      }),
    );
  });

  test("ranks by feedback, confidence, relevance, and exact element-ref tie breaks", async () => {
    const {
      built,
      projection,
      result,
      expectedOperationDigest,
      binding,
      mentionA,
      mentionB,
      entity,
    } = await fixture();
    const feedback = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionB.elementRef,
        feedbackWeightMicros: 1,
        evidenceRef: "feedback-event.b",
      }),
    );
    const snapshot = await Effect.runPromise(
      makeGraphRankingSnapshot({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        feedbackObservations: [feedback],
        confidences: [
          makeConfidence(built, result, entity.elementRef, 900_000, "confidence.entity"),
          makeConfidence(built, result, mentionA.elementRef, 100_000, "confidence.a"),
        ],
      }),
    );
    const ranked = await Effect.runPromise(
      rankGraphOperationResult({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        snapshot,
      }),
    );

    expect(ranked._tag).toBe("Ranked");
    expect(ranked.observations.map((item) => item.elementRef)).toEqual([
      mentionB.elementRef,
      entity.elementRef,
      mentionA.elementRef,
    ]);
    expect(ranked.missingFeatureElementRefs).toEqual([]);
    expect(ranked.missingConfidenceElementRefs).toEqual([mentionB.elementRef]);
    expect(ranked.missingRelevanceElementRefs).toEqual(
      [mentionA.elementRef, mentionB.elementRef, entity.elementRef].sort(),
    );
    expect(ranked.evidence.usedElements).toHaveLength(result.observations.length);
    expect(JSON.stringify(ranked.evidence)).not.toContain('"text"');
  });

  test("keeps disabled ranking explicit and preserves operation order", async () => {
    const { built, projection, result, expectedOperationDigest, binding, entity } = await fixture();
    const first = await Effect.runPromise(
      rankGraphOperationResult({ built, projection, result, expectedOperationDigest, binding }),
    );
    const second = await Effect.runPromise(
      rankGraphOperationResult({ built, projection, result, expectedOperationDigest, binding }),
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ _tag: "Unranked", disabledReason: "ranking_disabled" });
    expect(first.observations).toEqual(result.observations);
    expect("rankingSnapshotDigest" in first).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.evidence.usedElements)).toBe(true);
    expect(() =>
      Object.defineProperty(first.evidence.usedElements[0]!, "elementRef", { value: "changed" }),
    ).toThrow();
    expect(first.evidence.usedElements[0]).toMatchObject({
      sourceAddress: result.observations[0]?.sourceAddress,
      supportingSources: result.observations[0]?.supportingSources,
    });
  });

  test("rejects changed query, operation, graph-address, support, counters, and result membership", async () => {
    const { built, projection, result, expectedOperationDigest, binding, entity } = await fixture();
    const first = result.observations[0]!;
    const substitutions: ReadonlyArray<GraphRlmOperationResult> = [
      { ...result, operationDigest: "8".repeat(64) } as GraphRlmOperationResult,
      {
        ...result,
        observations: [
          {
            ...first,
            sourceAddress: { ...first.sourceAddress, encodedAddress: "substituted" },
          },
          ...result.observations.slice(1),
        ],
      } as GraphRlmOperationResult,
      {
        ...result,
        observations: [{ ...first, supportingSources: [] }, ...result.observations.slice(1)],
      } as GraphRlmOperationResult,
      { ...result, sourceAddresses: result.sourceAddresses + 1 } as GraphRlmOperationResult,
      { ...result, observations: result.observations.slice(1) } as GraphRlmOperationResult,
    ];
    for (const substituted of substitutions) {
      await expect(
        Effect.runPromise(
          rankGraphOperationResult({
            built,
            projection,
            result: substituted,
            expectedOperationDigest,
            binding,
          }),
        ),
      ).rejects.toMatchObject({ reason: "invalid_result" });
    }
    const wrongBinding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "Lookup",
      elementRef: first.elementRef,
    });
    await expect(
      Effect.runPromise(
        rankGraphOperationResult({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding: wrongBinding,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });

    const { text: _text, canonicalKey: _canonicalKey, ...withoutRequiredFields } = first;
    const changedObservations = [withoutRequiredFields, ...result.observations.slice(1)];
    const missingFieldsWithoutDigest = {
      ...result,
      observations: changedObservations,
      observationCharacters: changedObservations.reduce(
        (sum, observation) => sum + Array.from(canonicalJson(observation)).length,
        0,
      ),
    };
    const missingFields = {
      ...missingFieldsWithoutDigest,
      operationDigest: recomputeNeighborsDigest(
        missingFieldsWithoutDigest,
        projection,
        entity.elementRef,
      ),
    } as GraphRlmOperationResult;
    await expect(
      Effect.runPromise(
        rankGraphOperationResult({
          built,
          projection,
          result: missingFields,
          expectedOperationDigest: missingFields.operationDigest,
          binding,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });
  });

  test("rejects a changed projected corpus and recomputed deterministic receipts", async () => {
    const { built, projection, result, expectedOperationDigest, binding, entity } = await fixture();
    const staleProjection = {
      ...projection,
      corpus: {
        ...projection.corpus,
        assertUnchanged: () =>
          Effect.fail(
            new RlmCorpusError({
              reason: "changed",
              detailSafe: "The projected corpus changed.",
            }),
          ),
      },
    };
    await expect(
      Effect.runPromise(
        rankGraphOperationResult({
          built,
          projection: staleProjection,
          result,
          expectedOperationDigest,
          binding,
        }),
      ),
    ).rejects.toMatchObject({ reason: "stale_graph" });
    const changedProjection = {
      ...projection,
      corpus: {
        ...projection.corpus,
        materializeAll: () =>
          projection.corpus
            .materializeAll()
            .pipe(
              Effect.map((entries) =>
                entries.map((entry, index) =>
                  index === 0 ? { ...entry, text: `${entry.text}:changed` } : entry,
                ),
              ),
            ),
      },
    };
    await expect(
      Effect.runPromise(
        rankGraphOperationResult({
          built,
          projection: changedProjection,
          result,
          expectedOperationDigest,
          binding,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });

    const kept = result.observations.slice(0, 1);
    const forgedWithoutDigest = {
      ...result,
      _tag: "Truncated" as const,
      visitedElements: 1,
      sourceAddresses: kept.reduce(
        (sum, observation) => sum + 1 + observation.supportingSources.length,
        0,
      ),
      observationCharacters: kept.reduce(
        (sum, observation) => sum + Array.from(canonicalJson(observation)).length,
        0,
      ),
      observations: kept,
      hitCaps: ["max_returned_elements" as const],
    };
    const forged = {
      ...forgedWithoutDigest,
      operationDigest: recomputeNeighborsDigest(forgedWithoutDigest, projection, entity.elementRef),
    } as GraphRlmOperationResult;
    await expect(
      Effect.runPromise(
        rankGraphOperationResult({
          built,
          projection,
          result: forged,
          expectedOperationDigest: forged.operationDigest,
          binding,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_result" });
  });

  test("rejects repeated feedback evidence and overflow before later cancellation", async () => {
    const { built, projection, result, expectedOperationDigest, binding, mentionA } =
      await fixture();
    const repeatedA = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionA.elementRef,
        feedbackWeightMicros: 1,
        evidenceRef: "feedback.repeated",
      }),
    );
    const repeatedB = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionA.elementRef,
        feedbackWeightMicros: 2,
        evidenceRef: "feedback.repeated",
      }),
    );
    await expect(
      Effect.runPromise(
        makeGraphRankingSnapshot({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
          feedbackObservations: [repeatedA, repeatedB],
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_feedback" });
    await expect(
      Effect.runPromise(
        makeGraphRankingSnapshot({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
          feedbackObservations: Array.from({ length: 10_001 }, () => repeatedA),
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_feedback" });

    const positive = await Promise.all(
      ["overflow.a", "overflow.b"].map((evidenceRef) =>
        Effect.runPromise(
          makeGraphFeedbackObservation({
            built,
            projection,
            result,
            expectedOperationDigest,
            binding,
            elementRef: mentionA.elementRef,
            feedbackWeightMicros: 700_000_000,
            evidenceRef,
          }),
        ),
      ),
    );
    let cancellation = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionA.elementRef,
        feedbackWeightMicros: -700_000_000,
        evidenceRef: "overflow.cancel.0",
      }),
    );
    for (
      let index = 1;
      (cancellation.observationRef < positive[0]!.observationRef ||
        cancellation.observationRef < positive[1]!.observationRef) &&
      index < 10_000;
      index += 1
    ) {
      cancellation = await Effect.runPromise(
        makeGraphFeedbackObservation({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
          elementRef: mentionA.elementRef,
          feedbackWeightMicros: -700_000_000,
          evidenceRef: `overflow.cancel.${index}`,
        }),
      );
    }
    expect(cancellation.observationRef > positive[0]!.observationRef).toBe(true);
    expect(cancellation.observationRef > positive[1]!.observationRef).toBe(true);
    await expect(
      Effect.runPromise(
        makeGraphRankingSnapshot({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
          feedbackObservations: [...positive, cancellation],
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_feedback" });
  });

  test("rejects stale, unknown, truncated, and substituted inputs", async () => {
    const {
      built,
      projection,
      result,
      expectedOperationDigest,
      binding,
      mentionA,
      entity,
      limits,
    } = await fixture();
    await expect(
      Effect.runPromise(
        makeGraphFeedbackObservation({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
          elementRef: "element.unknown",
          feedbackWeightMicros: 1,
          evidenceRef: "feedback.unknown",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "GraphCorpus.RankingError", reason: "unknown_element" });
    const truncated = await Effect.runPromise(
      projection.operators.neighbors(entity.elementRef, { ...limits, maxReturnedElements: 1 }),
    );
    const unrankedTruncated = await Effect.runPromise(
      rankGraphOperationResult({
        built,
        projection,
        result: truncated,
        expectedOperationDigest: truncated.operationDigest,
        binding,
      }),
    );
    expect(unrankedTruncated).toMatchObject({
      _tag: "Unranked",
      disabledReason: "operation_truncated",
      evidence: { operationStatus: "Truncated", hitCaps: ["max_returned_elements"] },
    });
    expect(unrankedTruncated.observations).toEqual(truncated.observations);
    const feedback = await Effect.runPromise(
      makeGraphFeedbackObservation({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        elementRef: mentionA.elementRef,
        feedbackWeightMicros: 1,
        evidenceRef: "feedback.a",
      }),
    );
    const snapshot = await Effect.runPromise(
      makeGraphRankingSnapshot({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        feedbackObservations: [feedback],
      }),
    );
    await expect(
      Effect.runPromise(
        rankGraphOperationResult({
          built,
          projection,
          result: truncated,
          expectedOperationDigest: truncated.operationDigest,
          binding,
          snapshot,
        }),
      ),
    ).rejects.toMatchObject({ reason: "incomplete_result" });
    const forgedSnapshot = {
      ...snapshot,
      contentDigest: "9".repeat(64),
    } as GraphRankingSnapshot;
    await expect(
      Effect.runPromise(
        validateGraphRankingSnapshot(forgedSnapshot, {
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
        }),
      ),
    ).rejects.toBeInstanceOf(GraphRankingError);
    const ranked = await Effect.runPromise(
      rankGraphOperationResult({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        snapshot,
      }),
    );
    const substitutions: ReadonlyArray<typeof ranked.evidence> = [
      { ...ranked.evidence, operationDigest: "8".repeat(64) } as typeof ranked.evidence,
      { ...ranked.evidence, queryDigest: "7".repeat(64) } as typeof ranked.evidence,
      { ...ranked.evidence, limitsDigest: "6".repeat(64) } as typeof ranked.evidence,
      { ...ranked.evidence, operationResultDigest: "5".repeat(64) } as typeof ranked.evidence,
      {
        ...ranked.evidence,
        usedElements: ranked.evidence.usedElements.map((item, index) =>
          index === 0 ? { ...item, supportingSources: [] } : item,
        ),
      } as typeof ranked.evidence,
      {
        ...ranked.evidence,
        usedElements: ranked.evidence.usedElements.map((item, index) =>
          index === 0
            ? {
                ...item,
                sourceAddress: { ...item.sourceAddress, encodedAddress: "substituted" },
              }
            : item,
        ),
      } as typeof ranked.evidence,
    ];
    for (const forgedEvidence of substitutions) {
      await expect(
        Effect.runPromise(
          validateGraphUsedElementEvidence(forgedEvidence, {
            built,
            projection,
            result,
            expectedOperationDigest,
            binding,
            snapshot,
          }),
        ),
      ).rejects.toMatchObject({ reason: "invalid_evidence" });
    }
    await expect(
      Effect.runPromise(
        makeGraphFeedbackObservation({
          built,
          projection,
          result,
          expectedOperationDigest,
          binding,
          elementRef: mentionA.elementRef,
          feedbackWeightMicros: 1_000_000_001,
          evidenceRef: "feedback.out-of-bounds",
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_feedback" });
  });

  test("exports validated ranking artifacts for deletion planning", async () => {
    const {
      built,
      projection,
      result,
      expectedOperationDigest,
      binding,
      mentionA,
      entity,
      sourceA,
    } = await fixture();
    const feedback = await Promise.all(
      [mentionA.elementRef, entity.elementRef].map((elementRef, index) =>
        Effect.runPromise(
          makeGraphFeedbackObservation({
            built,
            projection,
            result,
            expectedOperationDigest,
            binding,
            elementRef,
            feedbackWeightMicros: 1,
            evidenceRef: `feedback.${index}`,
          }),
        ),
      ),
    );
    const snapshot = await Effect.runPromise(
      makeGraphRankingSnapshot({
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
        feedbackObservations: feedback,
      }),
    );
    const artifacts = await Effect.runPromise(
      rankingArtifactsFromSnapshot(snapshot, {
        built,
        projection,
        result,
        expectedOperationDigest,
        binding,
      }),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.features)).toBe(true);
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(() => Object.defineProperty(artifacts[0]!, "artifactDigest", { value: "0" })).toThrow();
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every((item) => item.artifactKind === "ranking_ref")).toBe(true);
    const inventory = makeGraphArtifactInventory({
      built,
      vectors: [],
      summaries: [],
      rankingRefs: artifacts,
      coverage: {
        vectors: { _tag: "Complete" },
        summaries: { _tag: "Complete" },
        rankingRefs: { _tag: "Complete" },
      },
    });
    const plan = await Effect.runPromise(planGraphSourceDeletion(built, sourceA, inventory));
    expect(plan.actions.rankingRefActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: "Remove", oldOwnerElementRef: mentionA.elementRef }),
        expect.objectContaining({ _tag: "RebuildRequired", oldOwnerElementRef: entity.elementRef }),
      ]),
    );
    await expect(
      Effect.runPromise(
        rankingArtifactsFromSnapshot(
          {
            ...snapshot,
            snapshotDigest: "0".repeat(64),
          } as GraphRankingSnapshot,
          { built, projection, result, expectedOperationDigest, binding },
        ),
      ),
    ).rejects.toMatchObject({ reason: "invalid_snapshot" });
    const other = await fixture("graph.ranking.other");
    await expect(
      Effect.runPromise(
        rankingArtifactsFromSnapshot(snapshot, {
          built: other.built,
          projection: other.projection,
          result: other.result,
          expectedOperationDigest: other.expectedOperationDigest,
          binding: other.binding,
        }),
      ),
    ).rejects.toMatchObject({ reason: "stale_graph" });
  });
});
