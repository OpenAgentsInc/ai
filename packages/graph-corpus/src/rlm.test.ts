import { Effect, Schema as S } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  buildInlineCorpusInput,
  buildInMemoryCompositeProjection,
  citationFromEntry,
  makeInlineCorpusHandle,
  makeCompositeCorpusHandle,
  validateCitations,
} from "@openagentsinc/rlm/corpus";
import type { RlmSourceLocator } from "@openagentsinc/rlm/schemas";

import {
  GRAPH_ELEMENT_ADDRESS_SCHEMA_ID,
  GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID,
  GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
  GraphAdapterCapabilityError,
  GraphDerivation,
  GraphRlmError,
  GraphVectorArtifact,
  buildGraphCorpus,
  decodeGraphElementAddress,
  makeCanonicalEntity,
  makeGraphAdapterCapabilities,
  makeGraphArtifactInventory,
  makeEmbeddingProjectionDescriptor,
  makeGraphMention,
  makeGraphRelation,
  makeGraphRlmClassificationProjection,
  makeGraphRlmCorpusSource,
  makeGraphRlmProjection,
  makeGraphRlmRetrievalInventory,
  makeInMemoryGraphSnapshotHandle,
  type GraphCompleteArtifactInventory,
  type GraphRlmOperationLimits,
} from "./index.ts";

const derivation = S.decodeUnknownSync(GraphDerivation)({
  _tag: "Deterministic",
  parserRef: "parser.fixture.v1",
  parserVersion: "1.0.0",
});
const policy = {
  includeVisibilities: ["private"] as const,
  includeRedactionClasses: ["none"] as const,
};
const limits: GraphRlmOperationLimits = {
  maxDepth: 8,
  maxVisitedElements: 50,
  maxReturnedElements: 50,
  maxSourceAddresses: 50,
  maxCharactersPerResult: 2_048,
  maxObservationCharacters: 20_000,
};

const fixture = async () => {
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
    identityNamespace: "people",
    canonicalKey: "person:alex:mention",
    identityScopeRef: "tenant.a",
    source: sourceA,
    derivation,
  });
  const mentionB = makeGraphMention({
    identityNamespace: "organizations",
    canonicalKey: "organization:openagents:mention",
    identityScopeRef: "tenant.a",
    source: sourceB,
    derivation,
  });
  const person = makeCanonicalEntity({
    identityNamespace: "people",
    canonicalKey: "person:alex",
    identityScopeRef: "tenant.a",
    mentions: [mentionA],
    derivation,
  });
  const organization = makeCanonicalEntity({
    identityNamespace: "organizations",
    canonicalKey: "organization:openagents",
    identityScopeRef: "tenant.a",
    mentions: [mentionB],
    derivation,
  });
  const relation = makeGraphRelation({
    identityNamespace: "relations",
    canonicalKey: "alex-member-of-openagents",
    identityScopeRef: "tenant.a",
    relationKind: "member_of",
    from: person,
    to: organization,
    memberships: [{ source: sourceA }, { source: sourceB }],
    derivation,
  });
  const descriptor = makeEmbeddingProjectionDescriptor({
    projectionSchemaId: "graph.embedding.all.v1",
    elementKinds: ["mention", "entity", "relation"],
    embeddableFields: ["identity.canonicalKey"],
    dimensions: 2,
  });
  const built = await Effect.runPromise(
    buildGraphCorpus({
      graphRef: "graph.fixture",
      scopeRef: "tenant.a",
      policy,
      mentions: [mentionB, mentionA],
      entities: [organization, person],
      relations: [relation],
      embeddingProjections: [descriptor],
    }),
  );
  const handle = await Effect.runPromise(makeInMemoryGraphSnapshotHandle(built));
  const classification = makeGraphRlmClassificationProjection(
    handle,
    [...handle.snapshot.mentions, ...handle.snapshot.entities, ...handle.snapshot.relations].map(
      ({ elementRef }) => ({ elementRef, visibility: "private", redactionClass: "none" }),
    ),
    [original],
  );
  const capabilities = makeGraphAdapterCapabilities([
    "graph_read",
    "rlm_v2_projection",
    "vector_read",
    "hybrid_query",
  ]);
  return {
    built,
    handle,
    classification,
    capabilities,
    sourceA,
    sourceB,
    mentionA,
    mentionB,
    person,
    organization,
    relation,
    descriptor,
    original,
  };
};

const project = async (value: Awaited<ReturnType<typeof fixture>>) =>
  Effect.runPromise(
    makeGraphRlmProjection({
      handle: value.handle,
      capabilities: value.capabilities,
      classification: value.classification,
      corpusRef: "rlm.graph.fixture",
      supportingCorpora: [value.original],
    }),
  );

describe("graph RLM v2 projection", () => {
  test("keeps graph identity separate and binds exact graph and source addresses", async () => {
    const value = await fixture();
    const projection = await project(value);
    expect(projection.corpus.identity.contentDigest).not.toBe(value.built.snapshot.graphDigest);
    expect(projection.corpus.identity.manifestDigest).not.toBe(value.built.manifest.manifestDigest);
    expect(projection.sourceRef.addressSchemaId).toBe(GRAPH_RLM_SOURCE_ADDRESS_SCHEMA_ID);
    const entries = await Effect.runPromise(projection.corpus.materializeAll());
    expect(entries).toHaveLength(5);
    expect(entries.every(({ sourcePlane }) => sourcePlane === "derived_graph")).toBe(true);
    const relationEntry = entries.find(({ entryRef }) => entryRef === value.relation.elementRef)!;
    expect(relationEntry.sourceKind).toBe("graph_relation");
    expect(relationEntry.supportingSources).toEqual([value.sourceA, value.sourceB]);
    expect(relationEntry.sourceAddress.addressSchemaId).toBe(GRAPH_ELEMENT_ADDRESS_SCHEMA_ID);
    expect(
      await Effect.runPromise(decodeGraphElementAddress(relationEntry.sourceAddress)),
    ).toMatchObject({
      graphDigest: value.built.snapshot.graphDigest,
      manifestDigest: value.built.manifest.manifestDigest,
      elementKind: "relation",
      elementRef: value.relation.elementRef,
    });
    const citation = citationFromEntry(projection.corpus, relationEntry);
    expect(citation.supportingSources).toEqual([value.sourceA, value.sourceB]);
    const checked = await Effect.runPromise(validateCitations(projection.corpus, [citation]));
    expect(checked.invalid).toEqual([]);

    const children = [
      { expectedIdentity: value.original.identity, handle: value.original },
      { expectedIdentity: projection.corpus.identity, handle: projection.corpus },
    ];
    const compositeProjection = await Effect.runPromise(
      buildInMemoryCompositeProjection({
        corpusRef: "rlm.graph.composite",
        scopeRef: "tenant.a",
        policy,
        children,
      }),
    );
    const composite = await Effect.runPromise(
      makeCompositeCorpusHandle({
        corpusRef: "rlm.graph.composite",
        scopeRef: "tenant.a",
        policy,
        children,
        projection: compositeProjection,
      }),
    );
    const compositeEntries = await Effect.runPromise(
      composite.read(
        { start: 0, endInclusive: composite.manifest.coverage.entryCount - 1 },
        { maxEntries: composite.manifest.coverage.entryCount, maxCharsPerEntry: 2_048 },
      ),
    );
    const graphEntry = compositeEntries.find(
      ({ sourcePlane, sourceAddress }) =>
        sourcePlane === "derived_graph" &&
        sourceAddress.encodedAddress === relationEntry.sourceAddress.encodedAddress,
    );
    expect(graphEntry?.sourcePlane).toBe("derived_graph");
    const compositeCitation = citationFromEntry(composite, graphEntry!);
    const compositeChecked = await Effect.runPromise(
      validateCitations(composite, [compositeCitation]),
    );
    expect(compositeChecked.invalid).toEqual([]);
    const widenedPolicy = {
      includeVisibilities: ["public"] as const,
      includeRedactionClasses: ["none"] as const,
    };
    const widenedProjection = await Effect.runPromise(
      buildInMemoryCompositeProjection({
        corpusRef: "rlm.graph.composite.widened",
        scopeRef: "tenant.a",
        policy: widenedPolicy,
        children,
      }),
    );
    const widened = await Effect.runPromise(
      makeCompositeCorpusHandle({
        corpusRef: "rlm.graph.composite.widened",
        scopeRef: "tenant.a",
        policy: widenedPolicy,
        children,
        projection: widenedProjection,
      }).pipe(Effect.flip),
    );
    expect(widened.reason).toBe("policy_widened");
  });

  test("requires the projection capability and complete policy classification", async () => {
    const value = await fixture();
    const unsupported = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: makeGraphAdapterCapabilities(["graph_read"]),
        classification: value.classification,
        corpusRef: "rlm.graph.fixture",
        supportingCorpora: [value.original],
      }).pipe(Effect.flip),
    );
    expect(unsupported).toBeInstanceOf(GraphAdapterCapabilityError);
    const incomplete = makeGraphRlmClassificationProjection(
      value.handle,
      value.classification.classifications.slice(1),
      [value.original],
    );
    const error = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: incomplete,
        corpusRef: "rlm.graph.fixture",
        supportingCorpora: [value.original],
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(GraphRlmError);
    expect(error.reason).toBe("invalid_projection");
    const citationError = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: value.classification,
        corpusRef: "rlm.graph.fixture.no-sources",
        supportingCorpora: [],
      }).pipe(Effect.flip),
    );
    expect(citationError).toBeInstanceOf(GraphRlmError);
    expect(citationError.reason).toBe("projection_changed");
  });

  test("resolves only the exact immutable graph source", async () => {
    const projection = await project(await fixture());
    let materializeCalls = 0;
    const observed = {
      ...projection,
      corpus: {
        ...projection.corpus,
        materializeAll: () => {
          materializeCalls += 1;
          return projection.corpus.materializeAll();
        },
      },
    };
    const resolver = makeGraphRlmCorpusSource([observed]);
    const resolved = await Effect.runPromise(
      resolver.resolve({ _tag: "Source", sourceRef: projection.sourceRef }),
    );
    expect(resolved.identity).toEqual(projection.corpus.identity);
    expect(materializeCalls).toBe(0);
    const error = await Effect.runPromise(
      resolver
        .resolve({
          _tag: "Source",
          sourceRef: { ...projection.sourceRef, encodedAddress: "{}" },
        })
        .pipe(Effect.flip),
    );
    expect(error.reason).toBe("invalid_address");
    const duplicate = makeGraphRlmCorpusSource([projection, projection]);
    const duplicateError = await Effect.runPromise(
      duplicate.resolve({ _tag: "Source", sourceRef: projection.sourceRef }).pipe(Effect.flip),
    );
    expect(duplicateError.reason).toBe("duplicate_source");
  });

  test("performs deterministic lookup, BFS, source expansion, and safe text search", async () => {
    const value = await fixture();
    const projection = await project(value);
    const lookup = await Effect.runPromise(
      projection.operators.lookup(value.person.elementRef, limits),
    );
    expect(lookup._tag).toBe("Complete");
    expect(lookup.observations.map(({ elementRef }) => elementRef)).toEqual([
      value.person.elementRef,
    ]);
    const bfs = await Effect.runPromise(
      projection.operators.neighbors(value.person.elementRef, limits),
    );
    expect(bfs.observations.map(({ elementRef }) => elementRef)).toEqual([
      value.person.elementRef,
      value.mentionA.elementRef,
      value.relation.elementRef,
      value.organization.elementRef,
      value.mentionB.elementRef,
    ]);
    const boundedBfs = await Effect.runPromise(
      projection.operators.neighbors(value.person.elementRef, {
        ...limits,
        maxVisitedElements: 2,
      }),
    );
    expect(boundedBfs.visitedElements).toBe(2);
    expect(boundedBfs.hitCaps).toContain("max_visited_elements");
    const expanded = await Effect.runPromise(
      projection.operators.expandSource(value.sourceB, limits),
    );
    expect(expanded.observations.map(({ elementRef }) => elementRef).sort()).toEqual(
      [value.mentionB.elementRef, value.organization.elementRef, value.relation.elementRef].sort(),
    );
    const text = await Effect.runPromise(projection.operators.searchText("member_of", limits));
    expect(text.observations.map(({ elementRef }) => elementRef)).toEqual([
      value.relation.elementRef,
    ]);
    expect(
      await Effect.runPromise(projection.operators.searchText("path:b", limits)),
    ).toMatchObject({ observations: [] });
    const boundedText = await Effect.runPromise(
      projection.operators.searchText("person", { ...limits, maxVisitedElements: 1 }),
    );
    expect(boundedText).toMatchObject({
      _tag: "Truncated",
      visitedElements: 1,
      hitCaps: ["max_visited_elements"],
    });
  });

  test("reports every applicable limit as Complete or Truncated", async () => {
    const value = await fixture();
    const projection = await project(value);
    const depth = await Effect.runPromise(
      projection.operators.neighbors(value.person.elementRef, { ...limits, maxDepth: 0 }),
    );
    expect(depth).toMatchObject({ _tag: "Truncated", hitCaps: ["max_depth"] });
    const visited = await Effect.runPromise(
      projection.operators.neighbors(value.person.elementRef, {
        ...limits,
        maxVisitedElements: 1,
      }),
    );
    expect(visited.hitCaps).toContain("max_visited_elements");
    const returned = await Effect.runPromise(
      projection.operators.searchText("person", { ...limits, maxReturnedElements: 1 }),
    );
    expect(returned.hitCaps).toContain("max_returned_elements");
    const sources = await Effect.runPromise(
      projection.operators.lookup(value.relation.elementRef, { ...limits, maxSourceAddresses: 1 }),
    );
    expect(sources).toMatchObject({
      _tag: "Truncated",
      observations: [],
      hitCaps: ["max_source_addresses"],
    });
    const perResult = await Effect.runPromise(
      projection.operators.lookup(value.person.elementRef, {
        ...limits,
        maxCharactersPerResult: 1,
      }),
    );
    expect(perResult.hitCaps).toContain("max_characters_per_result");
    const total = await Effect.runPromise(
      projection.operators.lookup(value.person.elementRef, {
        ...limits,
        maxObservationCharacters: 1,
      }),
    );
    expect(total.hitCaps).toContain("max_observation_characters");
    const unsafe = await Effect.runPromise(
      projection.operators
        .lookup(value.person.elementRef, {
          ...limits,
          maxReturnedElements: Number.MAX_SAFE_INTEGER,
        })
        .pipe(Effect.flip),
    );
    expect(unsafe).toBeInstanceOf(GraphRlmError);
    expect(unsafe.reason).toBe("invalid_limits");
  });

  test("gates optional search on capabilities, complete inventory, and current owner refs", async () => {
    const value = await fixture();
    const inventory = makeGraphArtifactInventory({
      built: value.built,
      vectors: [
        S.decodeUnknownSync(GraphVectorArtifact)({
          artifactKind: "vector",
          artifactRef: "vector.person",
          artifactDigest: "f".repeat(64),
          ownerElementRef: value.person.elementRef,
        }),
        S.decodeUnknownSync(GraphVectorArtifact)({
          artifactKind: "vector",
          artifactRef: "vector.relation",
          artifactDigest: "e".repeat(64),
          ownerElementRef: value.relation.elementRef,
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
    const retrievalBindings = [
      {
        artifactRef: "vector.person",
        ownerElementRef: value.person.elementRef,
        descriptorRef: value.descriptor.descriptorRef,
        projectionSchemaId: value.descriptor.projectionSchemaId,
        dimensions: value.descriptor.dimensions,
      },
      {
        artifactRef: "vector.relation",
        ownerElementRef: value.relation.elementRef,
        descriptorRef: value.descriptor.descriptorRef,
        projectionSchemaId: value.descriptor.projectionSchemaId,
        dimensions: value.descriptor.dimensions,
      },
    ] as const;
    const omitted = await Effect.runPromise(
      makeGraphRlmRetrievalInventory(value.handle, inventory, retrievalBindings.slice(0, 1)).pipe(
        Effect.flip,
      ),
    );
    expect(omitted.reason).toBe("invalid_inventory");
    const duplicate = await Effect.runPromise(
      makeGraphRlmRetrievalInventory(value.handle, inventory, [
        retrievalBindings[0],
        retrievalBindings[0],
      ]).pipe(Effect.flip),
    );
    expect(duplicate.reason).toBe("invalid_inventory");
    const dangling = await Effect.runPromise(
      makeGraphRlmRetrievalInventory(value.handle, inventory, [
        retrievalBindings[0],
        { ...retrievalBindings[1], projectionSchemaId: "graph.embedding.substituted.v1" },
      ]).pipe(Effect.flip),
    );
    expect(dangling.reason).toBe("invalid_inventory");
    const retrievalInventory = await Effect.runPromise(
      makeGraphRlmRetrievalInventory(value.handle, inventory, retrievalBindings),
    );
    const projection = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: value.classification,
        corpusRef: "rlm.graph.fixture",
        supportingCorpora: [value.original],
        inventory,
        retrievalInventory,
        callbacks: {
          vectorSearch: ({ vector: _vector, ...binding }) =>
            Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...binding,
              results: [{ elementRef: value.person.elementRef, scoreMicros: 1_000_000 }],
            }),
          hybridSearch: ({ vector: _vector, textQuery: _textQuery, ...binding }) =>
            Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...binding,
              results: [{ elementRef: value.relation.elementRef, scoreMicros: 1_000_000 }],
            }),
        },
      }),
    );
    const vectorResult = await Effect.runPromise(
      projection.operators.searchVector(value.descriptor.descriptorRef, [1, 0], limits),
    );
    expect(vectorResult.observations[0]).toMatchObject({
      elementRef: value.person.elementRef,
      scoreMicros: 1_000_000,
    });
    expect(
      (
        await Effect.runPromise(
          projection.operators.searchHybrid(
            value.descriptor.descriptorRef,
            [1, 0],
            "member",
            limits,
          ),
        )
      ).observations[0]?.elementRef,
    ).toBe(value.relation.elementRef);
    const descriptorError = await Effect.runPromise(
      projection.operators
        .searchVector("graph.descriptor.unknown", [1, 0], limits)
        .pipe(Effect.flip),
    );
    expect(descriptorError).toBeInstanceOf(GraphRlmError);
    expect(descriptorError.reason).toBe("invalid_inventory");
    const overflowProjection = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: value.classification,
        corpusRef: "rlm.graph.fixture.overflow",
        supportingCorpora: [value.original],
        inventory,
        retrievalInventory,
        callbacks: {
          vectorSearch: ({ vector: _vector, ...binding }) =>
            Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...binding,
              results: [
                { elementRef: value.person.elementRef, scoreMicros: 2_000_000 },
                { elementRef: value.relation.elementRef, scoreMicros: 1_000_000 },
              ],
            }),
        },
      }),
    );
    const overflow = await Effect.runPromise(
      overflowProjection.operators
        .searchVector(value.descriptor.descriptorRef, [1, 0], {
          ...limits,
          maxVisitedElements: 1,
          maxReturnedElements: 1,
        })
        .pipe(Effect.flip),
    );
    expect(overflow.reason).toBe("invalid_inventory");

    const withoutInventory = await project(value);
    const error = await Effect.runPromise(
      withoutInventory.operators
        .searchVector(value.descriptor.descriptorRef, [1, 0], limits)
        .pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(GraphRlmError);
    expect(error.reason).toBe("invalid_inventory");

    const staleProjection = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: value.classification,
        corpusRef: "rlm.graph.fixture.stale",
        supportingCorpora: [value.original],
        inventory: { ...inventory, graphDigest: value.built.manifest.manifestDigest },
        retrievalInventory,
        callbacks: {
          vectorSearch: ({ vector: _vector, ...binding }) =>
            Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...binding,
              results: [{ elementRef: value.person.elementRef, scoreMicros: 1_000_000 }],
            }),
        },
      }),
    );
    const staleError = await Effect.runPromise(
      staleProjection.operators
        .searchVector(value.descriptor.descriptorRef, [1, 0], limits)
        .pipe(Effect.flip),
    );
    expect(staleError).toBeInstanceOf(GraphRlmError);
    expect(staleError.reason).toBe("invalid_inventory");

    const noCallback = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: value.classification,
        corpusRef: "rlm.graph.fixture.no-callback",
        supportingCorpora: [value.original],
        inventory,
        retrievalInventory,
      }),
    );
    const callbackError = await Effect.runPromise(
      noCallback.operators
        .searchVector(value.descriptor.descriptorRef, [1, 0], limits)
        .pipe(Effect.flip),
    );
    expect(callbackError).toBeInstanceOf(GraphRlmError);
    expect(callbackError.reason).toBe("unsupported_callback");

    const toctou = await Effect.runPromise(
      makeGraphRlmProjection({
        handle: value.handle,
        capabilities: value.capabilities,
        classification: value.classification,
        corpusRef: "rlm.graph.fixture.toctou",
        supportingCorpora: [value.original],
        inventory,
        retrievalInventory,
        callbacks: {
          vectorSearch: ({ vector: _vector, ...binding }) => {
            Object.defineProperty(value.original.identity, "contentDigest", {
              configurable: true,
              value: "0".repeat(64),
            });
            return Effect.succeed({
              schemaId: GRAPH_RLM_SEARCH_RESPONSE_SCHEMA_ID,
              ...binding,
              results: [{ elementRef: value.person.elementRef, scoreMicros: 1_000_000 }],
            });
          },
        },
      }),
    );
    const changed = await Effect.runPromise(
      toctou.operators
        .searchVector(value.descriptor.descriptorRef, [1, 0], limits)
        .pipe(Effect.flip),
    );
    expect(changed).toBeInstanceOf(GraphRlmError);
    expect(changed.reason).toBe("projection_changed");
  });
});
