import { Effect, Schema as S } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { RlmSourceLocator } from "@openagentsinc/rlm/schemas";

import {
  GraphCanonicalEntity,
  GraphCorpusError,
  GraphDerivation,
  GraphEmbeddingProjectionDescriptor,
  GraphIdentity,
  GRAPH_IN_MEMORY_BYTE_CEILING,
  GRAPH_IN_MEMORY_ELEMENT_CEILING,
  GraphMention,
  buildGraphCorpus,
  canonicalJson,
  makeCanonicalEntity,
  makeEmbeddingProjectionDescriptor,
  makeGraphMention,
  makeGraphRelation,
  makeInMemoryGraphSnapshotHandle,
  makeMergeEvidence,
  verifyBuiltGraphCorpus,
  type BuildGraphCorpusInput,
  type GraphDerivation as GraphDerivationType,
} from "./index.ts";

const policy = {
  includeVisibilities: ["public"] as const,
  includeRedactionClasses: ["none"] as const,
};

const decodeDerivation = S.decodeUnknownSync(GraphDerivation);

const deterministic: GraphDerivationType = decodeDerivation({
  _tag: "Deterministic",
  parserRef: "parser.fixture.v1",
  parserVersion: "1.0.0",
});

const locator = (entryRef: string, encodedAddress = entryRef): RlmSourceLocator => ({
  sourcePlane: "repository",
  sourceKind: "fixture",
  sourceAddress: { addressSchemaId: "fixture.address.v1", encodedAddress },
  corpusRef: "source.corpus",
  contentDigest: "a".repeat(64),
  entryRef,
});

const fixture = () => {
  const mentionA = makeGraphMention({
    identityNamespace: "people",
    canonicalKey: "alex:mention:a",
    identityScopeRef: "tenant.a",
    source: locator("entry.a"),
    derivation: deterministic,
  });
  const mentionB = makeGraphMention({
    identityNamespace: "people",
    canonicalKey: "alex:mention:b",
    identityScopeRef: "tenant.a",
    source: locator("entry.b"),
    derivation: deterministic,
  });
  const entity = makeCanonicalEntity({
    identityNamespace: "people",
    canonicalKey: "alex",
    identityScopeRef: "tenant.a",
    mentions: [mentionA, mentionB],
    derivation: deterministic,
  });
  const organizationMention = makeGraphMention({
    identityNamespace: "organizations",
    canonicalKey: "alex:org",
    identityScopeRef: "tenant.a",
    source: locator("entry.org"),
    derivation: deterministic,
  });
  const organization = makeCanonicalEntity({
    identityNamespace: "organizations",
    canonicalKey: "alex",
    identityScopeRef: "tenant.a",
    mentions: [organizationMention],
    derivation: deterministic,
  });
  const relation = makeGraphRelation({
    identityNamespace: "relations",
    canonicalKey: "alex-member-of-alex",
    identityScopeRef: "tenant.a",
    relationKind: "member_of",
    from: entity,
    to: organization,
    memberships: [...entity.memberships, ...organization.memberships],
    derivation: deterministic,
  });
  const merge = makeMergeEvidence({
    entity,
    mentions: [mentionA, mentionB],
    evidenceRef: "merge.rule.exact-email.v1",
  });
  const descriptor = makeEmbeddingProjectionDescriptor({
    projectionSchemaId: "graph.embedding.entity.v1",
    elementKinds: ["entity"],
    embeddableFields: ["identity.canonicalKey"],
    dimensions: 384,
  });
  const input: BuildGraphCorpusInput = {
    graphRef: "graph.fixture",
    scopeRef: "tenant.a",
    policy,
    mentions: [organizationMention, mentionB, mentionA],
    entities: [organization, entity],
    relations: [relation],
    merges: [merge],
    embeddingProjections: [descriptor],
  };
  return { mentionA, mentionB, entity, organization, relation, merge, descriptor, input };
};

describe("@openagentsinc/graph-corpus", () => {
  test("decodes separate mention and entity schemas and preserves merge evidence", async () => {
    const value = fixture();
    expect(S.is(GraphMention)(value.mentionA)).toBe(true);
    expect(S.is(GraphCanonicalEntity)(value.entity)).toBe(true);
    expect(value.entity.mentionRefs).toEqual(
      [value.mentionA.mentionRef, value.mentionB.mentionRef].sort(),
    );
    expect(value.merge.mentionRefs).toEqual(value.entity.mentionRefs);
    expect(value.mentionA.source).toEqual(locator("entry.a"));
    expect("usageReceiptRef" in value.mentionA.derivation).toBe(false);
    const reversedEntity = makeCanonicalEntity({
      identityNamespace: "people",
      canonicalKey: "alex",
      identityScopeRef: "tenant.a",
      mentions: [value.mentionB, value.mentionA],
      derivation: deterministic,
    });
    expect(reversedEntity.elementRef).toBe(value.entity.elementRef);
    const built = await Effect.runPromise(buildGraphCorpus(value.input));
    expect(built.manifest.coverage).toEqual({
      mentionCount: 3,
      entityCount: 2,
      relationCount: 1,
      mergeCount: 1,
    });
    expect(built.snapshot.mentions.map((item) => item.mentionRef)).toEqual(
      expect.arrayContaining([...value.merge.mentionRefs]),
    );
  });

  test("separates same-name people, organizations, namespaces, and scopes", () => {
    const source = locator("collision");
    const make = (identityNamespace: string, identityScopeRef: string) =>
      makeGraphMention({
        identityNamespace,
        canonicalKey: "Alex",
        identityScopeRef,
        source,
        derivation: deterministic,
      });
    const personA = make("people", "tenant.a");
    const personB = make("people", "tenant.b");
    const organization = make("organizations", "tenant.a");
    expect(new Set([personA.elementRef, personB.elementRef, organization.elementRef]).size).toBe(3);
  });

  test("rebuilds deterministically under input permutation", async () => {
    const value = fixture();
    const left = await Effect.runPromise(buildGraphCorpus(value.input));
    const right = await Effect.runPromise(
      buildGraphCorpus({
        ...value.input,
        mentions: [...value.input.mentions].reverse(),
        entities: [...value.input.entities].reverse(),
      }),
    );
    expect(right.snapshot).toEqual(left.snapshot);
    expect(right.manifest).toEqual(left.manifest);
  });

  test("binds model reruns but excludes ranking and time from graph identity", async () => {
    const value = fixture();
    const modelDerivation = (inputDigest: string): GraphDerivationType =>
      decodeDerivation({
        _tag: "Model",
        extractorKind: "entity_relation",
        dseSignatureRef: "graph.extract.v1",
        compiledProgramDigest: "b".repeat(64),
        extractionInputDigest: inputDigest,
        decodeOutcome: "decoded",
        usageReceiptRef: "usage.fixture",
      });
    const firstMention = makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "model-alex",
      source: locator("model"),
      derivation: modelDerivation("c".repeat(64)),
    });
    const rerunMention = makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "model-alex",
      source: locator("model"),
      derivation: modelDerivation("d".repeat(64)),
    });
    const first = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: [...value.input.mentions, firstMention] }),
    );
    const rerun = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: [...value.input.mentions, rerunMention] }),
    );
    expect(rerun.snapshot.graphDigest).not.toBe(first.snapshot.graphDigest);
    const ranked = await Effect.runPromise(
      buildGraphCorpus({
        ...value.input,
        rankingState: { score: 99 },
        builtAt: "2099-01-01T00:00:00Z",
      } as BuildGraphCorpusInput),
    );
    const baseline = await Effect.runPromise(buildGraphCorpus(value.input));
    expect(ranked.snapshot.graphDigest).toBe(baseline.snapshot.graphDigest);
  });

  test("keeps provenance ref-only and rejects corrupted identities", async () => {
    const privateText = "PRIVATE SOURCE TEXT MUST NOT APPEAR";
    const privateSource = {
      text: privateText,
      locator: locator("private.entry", "opaque-address"),
    };
    const mention = makeGraphMention({
      identityNamespace: "redacted",
      canonicalKey: "opaque-key",
      source: privateSource.locator,
      derivation: deterministic,
    });
    expect(
      canonicalJson({ memberships: mention.memberships, derivation: mention.derivation }),
    ).not.toContain(privateText);
    expect(canonicalJson(mention.memberships)).not.toContain("text");

    const value = fixture();
    const built = await Effect.runPromise(buildGraphCorpus(value.input));
    const corrupt = {
      ...built,
      snapshot: {
        ...built.snapshot,
        mentions: [{ ...built.snapshot.mentions[0]!, elementRef: "graph.mention.corrupt" }],
      },
    } as unknown as typeof built;
    const error = await Effect.runPromise(verifyBuiltGraphCorpus(corrupt).pipe(Effect.flip));
    expect(error).toBeInstanceOf(GraphCorpusError);
    const digestError = await Effect.runPromise(
      verifyBuiltGraphCorpus({
        ...built,
        manifest: {
          ...built.manifest,
          manifestDigest: "f".repeat(64) as typeof built.manifest.manifestDigest,
        },
      }).pipe(Effect.flip),
    );
    expect(digestError.reason).toBe("changed");
  });

  test("rejects invalid Unicode, nonfinite dimensions, and cross-paired derivations", () => {
    const identity = fixture().mentionA.identity;
    expect(() =>
      S.decodeUnknownSync(GraphIdentity)({ ...identity, canonicalKey: "bad\ud800key" }),
    ).toThrow();
    expect(() =>
      S.decodeUnknownSync(GraphEmbeddingProjectionDescriptor)({
        ...fixture().descriptor,
        dimensions: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      S.decodeUnknownSync(GraphDerivation)({
        _tag: "Deterministic",
        parserRef: "parser.fixture.v1",
        parserVersion: "1",
        usageReceiptRef: "forged.usage",
      }),
    ).toThrow();
  });

  test("rejects duplicate, cross-scope, dangling, forged, and noncanonical graph facts", async () => {
    const value = fixture();
    const duplicate = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: [value.mentionA, value.mentionA] }).pipe(
        Effect.flip,
      ),
    );
    expect(duplicate.reason).toBe("invalid_graph");

    const crossScope = makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "foreign-scope",
      identityScopeRef: "tenant.b",
      source: locator("foreign.scope"),
      derivation: deterministic,
    });
    const crossScopeError = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: [...value.input.mentions, crossScope] }).pipe(
        Effect.flip,
      ),
    );
    expect(crossScopeError.reason).toBe("invalid_graph");

    expect(() =>
      makeGraphRelation({
        identityNamespace: "relations",
        canonicalKey: "unsupported",
        relationKind: "unsupported",
        from: value.entity,
        to: value.organization,
        memberships: [],
        derivation: deterministic,
      }),
    ).toThrow(GraphCorpusError);

    const danglingRelation = structuredClone(value.relation) as unknown as Record<string, unknown>;
    danglingRelation.toEntityRef = "entity.missing";
    const relationError = await Effect.runPromise(
      buildGraphCorpus({
        ...value.input,
        relations: [danglingRelation as unknown as typeof value.relation],
      }).pipe(Effect.flip),
    );
    expect(relationError.reason).toBe("invalid_graph");

    const mutatedLocator = structuredClone(value.mentionA) as unknown as Record<string, unknown>;
    (mutatedLocator.source as unknown as { contentDigest: string }).contentDigest = "f".repeat(64);
    const locatorError = await Effect.runPromise(
      buildGraphCorpus({
        ...value.input,
        mentions: [mutatedLocator as unknown as typeof value.mentionA, value.mentionB],
      }).pipe(Effect.flip),
    );
    expect(locatorError.reason).toBe("invalid_graph");

    const reversedEntity = structuredClone(value.entity);
    (reversedEntity.memberships as Array<unknown>).reverse();
    const membershipError = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, entities: [reversedEntity, value.organization] }).pipe(
        Effect.flip,
      ),
    );
    expect(membershipError.reason).toBe("invalid_graph");

    const singleEntity = makeCanonicalEntity({
      identityNamespace: "people",
      canonicalKey: "single",
      identityScopeRef: "tenant.a",
      mentions: [value.mentionA],
      derivation: deterministic,
    });
    const foreignMerge = makeMergeEvidence({
      entity: singleEntity,
      mentions: [value.mentionA, value.mentionB],
      evidenceRef: "forged.merge.v1",
    });
    const mergeError = await Effect.runPromise(
      buildGraphCorpus({
        ...value.input,
        entities: [...value.input.entities, singleEntity],
        merges: [foreignMerge],
      }).pipe(Effect.flip),
    );
    expect(mergeError.reason).toBe("invalid_graph");

    const forgedAlias = structuredClone(value.mentionA);
    (forgedAlias as unknown as { mentionRef: string }).mentionRef = "mention.forged";
    const aliasError = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: [forgedAlias, value.mentionB] }).pipe(
        Effect.flip,
      ),
    );
    expect(aliasError.reason).toBe("invalid_graph");
  });

  test("rejects every manifest field, digest, order, and coverage corruption", async () => {
    const value = fixture();
    const built = await Effect.runPromise(buildGraphCorpus(value.input));
    const corruptions: ReadonlyArray<(copy: typeof built) => void> = [
      (copy) => ((copy.manifest as unknown as { schemaId: string }).schemaId = "wrong.schema"),
      (copy) =>
        ((copy.manifest as unknown as { canonicalizationId: string }).canonicalizationId =
          "wrong.canonicalization"),
      (copy) => ((copy.manifest as unknown as { graphRef: string }).graphRef = "graph.other"),
      (copy) => ((copy.manifest as unknown as { scopeRef: string }).scopeRef = "tenant.other"),
      (copy) =>
        ((copy.manifest as unknown as { graphDigest: string }).graphDigest = "e".repeat(64)),
      (copy) =>
        ((copy.manifest as unknown as { manifestDigest: string }).manifestDigest = "f".repeat(64)),
      (copy) => ((copy.manifest.coverage as unknown as { entityCount: number }).entityCount += 1),
      (copy) => (copy.manifest.policy.includeVisibilities as Array<string>).push("private"),
      (copy) => (copy.snapshot.mentions as Array<unknown>).reverse(),
      (copy) =>
        ((
          copy.snapshot.embeddingProjections[0] as unknown as { descriptorRef: string }
        ).descriptorRef = "embedding.forged"),
    ];
    for (const mutate of corruptions) {
      const copy = structuredClone(built);
      mutate(copy);
      const error = await Effect.runPromise(verifyBuiltGraphCorpus(copy).pipe(Effect.flip));
      expect(error.reason).toBeDefined();
    }
  });

  test("owns immutable bytes and keeps graph identity separate from source and ranking state", async () => {
    const value = fixture();
    const callerMentions = [...value.input.mentions];
    const built = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: callerMentions }),
    );
    callerMentions.length = 0;
    (value.mentionA.identity as unknown as { canonicalKey: string }).canonicalKey =
      "caller-mutated";
    expect(built.snapshot.mentions).toHaveLength(3);
    expect(built.snapshot.graphDigest).not.toBe(locator("entry.a").contentDigest);
    expect(() => (built.snapshot.mentions as Array<unknown>).pop()).toThrow();
    const handle = await Effect.runPromise(makeInMemoryGraphSnapshotHandle(built));
    expect(Object.isFrozen(handle.snapshot)).toBe(true);
    const ranked = await Effect.runPromise(
      buildGraphCorpus({ ...fixture().input, rankingState: { score: 2 } } as BuildGraphCorpusInput),
    );
    expect(ranked.snapshot.graphDigest).toBe(built.snapshot.graphDigest);
  });

  test("enforces the in-memory element and byte ceilings", async () => {
    const value = fixture();
    const tooMany = Array.from(
      { length: GRAPH_IN_MEMORY_ELEMENT_CEILING + 1 },
      () => value.mentionA,
    );
    const elementError = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, mentions: tooMany, entities: [], relations: [] }).pipe(
        Effect.flip,
      ),
    );
    expect(elementError.reason).toBe("size_ceiling");

    const largeFields = Array.from(
      { length: 9_000 },
      (_, index) => `field.${index}.${"x".repeat(480)}`,
    );
    const descriptor = makeEmbeddingProjectionDescriptor({
      projectionSchemaId: "graph.embedding.large.v1",
      elementKinds: ["entity"],
      embeddableFields: largeFields,
      dimensions: 1,
    });
    expect(new TextEncoder().encode(canonicalJson(descriptor)).length).toBeGreaterThan(
      GRAPH_IN_MEMORY_BYTE_CEILING,
    );
    const byteError = await Effect.runPromise(
      buildGraphCorpus({ ...value.input, embeddingProjections: [descriptor] }).pipe(Effect.flip),
    );
    expect(byteError.reason).toBe("size_ceiling");
  });

  test("provides an immutable in-memory snapshot handle", async () => {
    const value = fixture();
    const built = await Effect.runPromise(buildGraphCorpus(value.input));
    const callerOwned = structuredClone(built);
    const handle = await Effect.runPromise(makeInMemoryGraphSnapshotHandle(callerOwned));
    (
      callerOwned.snapshot.entities[0]!.identity as unknown as { canonicalKey: string }
    ).canonicalKey = "mutated after acquisition";
    const entity = await Effect.runPromise(handle.readElement(value.entity.elementRef));
    expect(entity).toEqual(value.entity);
    expect(await Effect.runPromise(handle.readRelations())).toEqual([value.relation]);
  });
});
