import { Data, Effect, Schema as S } from "effect";
import type { RlmSourceLocator } from "@openagentsinc/rlm/schemas";

import {
  canonicalJson,
  canonicalGraphPolicy,
  canonicalSourceMemberships,
  compareCanonicalText,
  computeGraphDigest,
  computeGraphManifestDigest,
  deriveGraphElementRef,
  graphIdentity,
  sha256Hex,
  type GraphIdentityInput,
} from "./canonical.ts";
import {
  GRAPH_CANONICALIZATION_ID,
  GRAPH_MANIFEST_SCHEMA_ID,
  GRAPH_SCHEMA_ID,
  GraphCanonicalEntity,
  GraphEmbeddingProjectionDescriptor,
  GraphManifest,
  GraphMention,
  GraphMergeEvidence,
  GraphRelation,
  GraphSnapshot,
  graphDescriptorRef,
  graphDigest,
  graphEntityRef,
  graphMergeRef,
  graphMentionRef,
  graphRefValue,
  graphRelationRef,
  graphScopeRef,
  type GraphCanonicalEntity as GraphCanonicalEntityType,
  type GraphCorpusPolicy,
  type GraphDerivation,
  type GraphEmbeddingProjectionDescriptor as GraphEmbeddingProjectionDescriptorType,
  type GraphManifest as GraphManifestType,
  type GraphMention as GraphMentionType,
  type GraphMergeEvidence as GraphMergeEvidenceType,
  type GraphRelation as GraphRelationType,
  type GraphSnapshot as GraphSnapshotType,
  type GraphSourceMembership,
} from "./schemas.ts";

export class GraphCorpusError extends Data.TaggedError("GraphCorpusError")<{
  readonly reason: "invalid_graph" | "changed" | "not_found" | "size_ceiling";
  readonly detailSafe: string;
}> {}

const decodeMention = S.decodeUnknownSync(GraphMention);
const decodeEntity = S.decodeUnknownSync(GraphCanonicalEntity);
const decodeRelation = S.decodeUnknownSync(GraphRelation);
const decodeMerge = S.decodeUnknownSync(GraphMergeEvidence);
const decodeDescriptor = S.decodeUnknownSync(GraphEmbeddingProjectionDescriptor);
const decodeSnapshot = S.decodeUnknownSync(GraphSnapshot);
const decodeManifest = S.decodeUnknownSync(GraphManifest);

const refFromElement = (kind: "mention" | "entity" | "relation", elementRef: string): string =>
  `${kind}.${elementRef.slice(elementRef.lastIndexOf(".") + 1)}`;

const mergeRefFor = (input: {
  readonly entityRef: string;
  readonly mentionRefs: ReadonlyArray<string>;
  readonly evidenceRef: string;
}): ReturnType<typeof graphMergeRef> => graphMergeRef(`merge.${sha256Hex(canonicalJson(input))}`);

export const makeGraphMention = (input: {
  readonly identityNamespace: string;
  readonly canonicalKey: string;
  readonly identityScopeRef?: string;
  readonly source: RlmSourceLocator;
  readonly derivation: GraphDerivation;
}): GraphMentionType => {
  const identity = graphIdentity({
    elementKind: "mention",
    identityNamespace: input.identityNamespace,
    canonicalKey: input.canonicalKey,
    ...(input.identityScopeRef === undefined ? {} : { scopeRef: input.identityScopeRef }),
  });
  const memberships = canonicalSourceMemberships([{ source: input.source }]);
  const elementRef = deriveGraphElementRef({ identity, memberships });
  return decodeMention({
    schemaId: GRAPH_SCHEMA_ID,
    elementKind: "mention",
    elementRef,
    mentionRef: graphMentionRef(refFromElement("mention", elementRef)),
    identity,
    source: input.source,
    memberships,
    derivation: input.derivation,
  });
};

export const makeCanonicalEntity = (input: {
  readonly identityNamespace: string;
  readonly canonicalKey: string;
  readonly identityScopeRef?: string;
  readonly mentions: ReadonlyArray<GraphMentionType>;
  readonly derivation: GraphDerivation;
}): GraphCanonicalEntityType => {
  if (new Set(input.mentions.map((item) => item.mentionRef)).size !== input.mentions.length) {
    throw new GraphCorpusError({
      reason: "invalid_graph",
      detailSafe: "canonical entity contains a duplicate mention",
    });
  }
  const memberships = canonicalSourceMemberships(
    input.mentions.flatMap((item) => item.memberships),
  );
  const identity = graphIdentity({
    elementKind: "entity",
    identityNamespace: input.identityNamespace,
    canonicalKey: input.canonicalKey,
    ...(input.identityScopeRef === undefined ? {} : { scopeRef: input.identityScopeRef }),
  });
  const elementRef = deriveGraphElementRef({ identity, memberships });
  return decodeEntity({
    schemaId: GRAPH_SCHEMA_ID,
    elementKind: "entity",
    elementRef,
    entityRef: graphEntityRef(refFromElement("entity", elementRef)),
    identity,
    mentionRefs: [...new Set(input.mentions.map((item) => item.mentionRef))].sort(
      compareCanonicalText,
    ),
    memberships,
    derivation: input.derivation,
  });
};

export const makeGraphRelation = (input: {
  readonly identityNamespace: string;
  readonly canonicalKey: string;
  readonly identityScopeRef?: string;
  readonly relationKind: string;
  readonly from: GraphCanonicalEntityType;
  readonly to: GraphCanonicalEntityType;
  readonly memberships: ReadonlyArray<GraphSourceMembership>;
  readonly derivation: GraphDerivation;
}): GraphRelationType => {
  if (input.memberships.length === 0) {
    throw new GraphCorpusError({
      reason: "invalid_graph",
      detailSafe: "relation requires explicit source membership",
    });
  }
  if (
    new Set(input.memberships.map((item) => canonicalJson(item.source))).size !==
    input.memberships.length
  ) {
    throw new GraphCorpusError({
      reason: "invalid_graph",
      detailSafe: "relation contains a duplicate source membership",
    });
  }
  const memberships = canonicalSourceMemberships(input.memberships);
  const identity = graphIdentity({
    elementKind: "relation",
    identityNamespace: input.identityNamespace,
    canonicalKey: input.canonicalKey,
    ...(input.identityScopeRef === undefined ? {} : { scopeRef: input.identityScopeRef }),
  });
  const elementRef = deriveGraphElementRef({ identity, memberships });
  return decodeRelation({
    schemaId: GRAPH_SCHEMA_ID,
    elementKind: "relation",
    elementRef,
    relationRef: graphRelationRef(refFromElement("relation", elementRef)),
    relationKind: input.relationKind,
    fromEntityRef: input.from.entityRef,
    toEntityRef: input.to.entityRef,
    identity,
    memberships,
    derivation: input.derivation,
  });
};

export const makeMergeEvidence = (input: {
  readonly entity: GraphCanonicalEntityType;
  readonly mentions: ReadonlyArray<GraphMentionType>;
  readonly evidenceRef: string;
}): GraphMergeEvidenceType => {
  if (input.mentions.length < 2) {
    throw new GraphCorpusError({
      reason: "invalid_graph",
      detailSafe: "merge evidence requires at least two mentions",
    });
  }
  const mentionRefs = [...new Set(input.mentions.map((item) => item.mentionRef))].sort(
    compareCanonicalText,
  );
  if (mentionRefs.length < 2) {
    throw new GraphCorpusError({
      reason: "invalid_graph",
      detailSafe: "merge evidence requires two distinct mentions",
    });
  }
  const memberships = canonicalSourceMemberships(
    input.mentions.flatMap((item) => item.memberships),
  );
  return decodeMerge({
    schemaId: GRAPH_SCHEMA_ID,
    mergeRef: mergeRefFor({
      entityRef: input.entity.entityRef,
      mentionRefs,
      evidenceRef: input.evidenceRef,
    }),
    entityRef: input.entity.entityRef,
    mentionRefs,
    evidenceRef: input.evidenceRef,
    memberships,
  });
};

export const makeEmbeddingProjectionDescriptor = (input: {
  readonly projectionSchemaId: string;
  readonly elementKinds: ReadonlyArray<"mention" | "entity" | "relation">;
  readonly embeddableFields: ReadonlyArray<string>;
  readonly dimensions: number;
}): GraphEmbeddingProjectionDescriptorType => {
  const normalized = {
    projectionSchemaId: input.projectionSchemaId,
    elementKinds: [...new Set(input.elementKinds)].sort(compareCanonicalText),
    embeddableFields: [...new Set(input.embeddableFields)].sort(compareCanonicalText),
    dimensions: input.dimensions,
  };
  return decodeDescriptor({
    schemaId: GRAPH_SCHEMA_ID,
    descriptorRef: graphDescriptorRef(`embedding.${sha256Hex(canonicalJson(normalized))}`),
    ...normalized,
  });
};

const byCanonicalRef = <A>(values: ReadonlyArray<A>, ref: (value: A) => string): ReadonlyArray<A> =>
  [...values].sort((left, right) => compareCanonicalText(ref(left), ref(right)));

export const GRAPH_IN_MEMORY_ELEMENT_CEILING = 10_000;
export const GRAPH_IN_MEMORY_BYTE_CEILING = 4 * 1024 * 1024;

const deepFreeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const assertUnique = (
  label: string,
  refs: ReadonlyArray<string>,
): Effect.Effect<void, GraphCorpusError> =>
  new Set(refs).size === refs.length
    ? Effect.void
    : Effect.fail(
        new GraphCorpusError({ reason: "invalid_graph", detailSafe: `duplicate ${label} ref` }),
      );

const expectedElementRef = (element: {
  readonly identity: GraphCanonicalEntityType["identity"];
  readonly memberships: ReadonlyArray<GraphSourceMembership>;
}): string => deriveGraphElementRef(element);

export interface BuildGraphCorpusInput {
  readonly graphRef: string;
  readonly scopeRef: string;
  readonly policy: GraphCorpusPolicy;
  readonly mentions: ReadonlyArray<GraphMentionType>;
  readonly entities: ReadonlyArray<GraphCanonicalEntityType>;
  readonly relations: ReadonlyArray<GraphRelationType>;
  readonly merges?: ReadonlyArray<GraphMergeEvidenceType>;
  readonly embeddingProjections?: ReadonlyArray<GraphEmbeddingProjectionDescriptorType>;
}

export interface BuiltGraphCorpus {
  readonly snapshot: GraphSnapshotType;
  readonly manifest: GraphManifestType;
}

export const buildGraphCorpus = Effect.fn("GraphCorpus.build")(function* (
  input: BuildGraphCorpusInput,
) {
  const elementCount = input.mentions.length + input.entities.length + input.relations.length;
  if (elementCount > GRAPH_IN_MEMORY_ELEMENT_CEILING) {
    return yield* new GraphCorpusError({
      reason: "size_ceiling",
      detailSafe: "graph snapshot exceeds its in-memory element ceiling",
    });
  }
  const mentions = byCanonicalRef(structuredClone(input.mentions), (item) => item.mentionRef);
  const entities = byCanonicalRef(structuredClone(input.entities), (item) => item.entityRef);
  const relations = byCanonicalRef(structuredClone(input.relations), (item) => item.relationRef);
  const merges = byCanonicalRef(structuredClone(input.merges ?? []), (item) => item.mergeRef);
  const embeddingProjections = byCanonicalRef(
    structuredClone(input.embeddingProjections ?? []),
    (item) => item.descriptorRef,
  );

  yield* assertUnique(
    "mention",
    mentions.map((item) => item.mentionRef),
  );
  yield* assertUnique(
    "entity",
    entities.map((item) => item.entityRef),
  );
  yield* assertUnique(
    "relation",
    relations.map((item) => item.relationRef),
  );
  yield* assertUnique(
    "merge",
    merges.map((item) => item.mergeRef),
  );
  yield* assertUnique(
    "embedding descriptor",
    embeddingProjections.map((item) => item.descriptorRef),
  );

  const mentionRefs = new Set(mentions.map((item) => item.mentionRef));
  const entityRefs = new Set(entities.map((item) => item.entityRef));
  const elementRefs = [
    ...mentions.map((item) => item.elementRef),
    ...entities.map((item) => item.elementRef),
    ...relations.map((item) => item.elementRef),
  ];
  yield* assertUnique("element", elementRefs);
  const membershipKey = (item: GraphSourceMembership): string => canonicalJson(item.source);
  const knownMemberships = new Set(mentions.flatMap((item) => item.memberships.map(membershipKey)));
  const mentionByRef = new Map(mentions.map((item) => [item.mentionRef, item]));
  const entityByRef = new Map(entities.map((item) => [item.entityRef, item]));
  const scopedToSnapshot = (element: {
    readonly identity: GraphCanonicalEntityType["identity"];
  }): boolean =>
    element.identity.identityScope._tag === "Global" ||
    element.identity.identityScope.scopeRef === input.scopeRef;
  const canonicalRefs = (refs: ReadonlyArray<string>): ReadonlyArray<string> =>
    [...refs].sort(compareCanonicalText);
  for (const mention of mentions) {
    if (
      mention.elementRef !== expectedElementRef(mention) ||
      mention.mentionRef !== refFromElement("mention", mention.elementRef) ||
      !scopedToSnapshot(mention) ||
      canonicalJson(mention.memberships) !== canonicalJson([{ source: mention.source }])
    ) {
      return yield* new GraphCorpusError({
        reason: "invalid_graph",
        detailSafe: "mention identity or source membership is corrupt",
      });
    }
  }
  for (const entity of entities) {
    const expectedMemberships = canonicalSourceMemberships(
      entity.mentionRefs.flatMap((ref) => mentionByRef.get(ref)?.memberships ?? []),
    );
    if (
      entity.elementRef !== expectedElementRef(entity) ||
      entity.entityRef !== refFromElement("entity", entity.elementRef) ||
      !scopedToSnapshot(entity) ||
      entity.mentionRefs.some((ref) => !mentionRefs.has(ref)) ||
      new Set(entity.mentionRefs).size !== entity.mentionRefs.length ||
      canonicalJson(entity.mentionRefs) !== canonicalJson(canonicalRefs(entity.mentionRefs)) ||
      canonicalJson(entity.memberships) !== canonicalJson(expectedMemberships)
    ) {
      return yield* new GraphCorpusError({
        reason: "invalid_graph",
        detailSafe: "entity identity or mention membership is corrupt",
      });
    }
  }
  for (const relation of relations) {
    if (
      relation.elementRef !== expectedElementRef(relation) ||
      relation.relationRef !== refFromElement("relation", relation.elementRef) ||
      !scopedToSnapshot(relation) ||
      !entityRefs.has(relation.fromEntityRef) ||
      !entityRefs.has(relation.toEntityRef) ||
      relation.memberships.length === 0 ||
      canonicalJson(relation.memberships) !==
        canonicalJson(canonicalSourceMemberships(relation.memberships)) ||
      relation.memberships.some((item) => !knownMemberships.has(membershipKey(item)))
    ) {
      return yield* new GraphCorpusError({
        reason: "invalid_graph",
        detailSafe: "relation identity or endpoint is corrupt",
      });
    }
  }
  for (const merge of merges) {
    const target = entityByRef.get(merge.entityRef);
    const expectedMemberships = canonicalSourceMemberships(
      merge.mentionRefs.flatMap((ref) => mentionByRef.get(ref)?.memberships ?? []),
    );
    if (
      target === undefined ||
      merge.mentionRefs.length < 2 ||
      merge.mentionRefs.some((ref) => !mentionRefs.has(ref)) ||
      merge.mentionRefs.some((ref) => !target.mentionRefs.includes(ref)) ||
      new Set(merge.mentionRefs).size !== merge.mentionRefs.length ||
      canonicalJson(merge.mentionRefs) !== canonicalJson(canonicalRefs(merge.mentionRefs)) ||
      merge.mergeRef !==
        mergeRefFor({
          entityRef: merge.entityRef,
          mentionRefs: merge.mentionRefs,
          evidenceRef: merge.evidenceRef,
        }) ||
      canonicalJson(merge.memberships) !== canonicalJson(expectedMemberships)
    ) {
      return yield* new GraphCorpusError({
        reason: "invalid_graph",
        detailSafe: "merge evidence is corrupt",
      });
    }
  }
  for (const descriptor of embeddingProjections) {
    const normalized = {
      projectionSchemaId: descriptor.projectionSchemaId,
      elementKinds: [...new Set(descriptor.elementKinds)].sort(compareCanonicalText),
      embeddableFields: [...new Set(descriptor.embeddableFields)].sort(compareCanonicalText),
      dimensions: descriptor.dimensions,
    };
    if (
      descriptor.elementKinds.length !== normalized.elementKinds.length ||
      descriptor.embeddableFields.length !== normalized.embeddableFields.length ||
      canonicalJson(descriptor.elementKinds) !== canonicalJson(normalized.elementKinds) ||
      canonicalJson(descriptor.embeddableFields) !== canonicalJson(normalized.embeddableFields) ||
      descriptor.descriptorRef !==
        graphDescriptorRef(`embedding.${sha256Hex(canonicalJson(normalized))}`)
    ) {
      return yield* new GraphCorpusError({
        reason: "invalid_graph",
        detailSafe: "embedding projection descriptor is corrupt",
      });
    }
  }

  const snapshotWithoutDigest: Omit<GraphSnapshotType, "graphDigest"> = {
    schemaId: GRAPH_SCHEMA_ID,
    canonicalizationId: GRAPH_CANONICALIZATION_ID,
    graphRef: graphRefValue(input.graphRef),
    scopeRef: graphScopeRef(input.scopeRef),
    policy: canonicalGraphPolicy(input.policy),
    mentions,
    entities,
    relations,
    merges,
    embeddingProjections,
  };
  if (
    new TextEncoder().encode(canonicalJson(snapshotWithoutDigest)).length >
    GRAPH_IN_MEMORY_BYTE_CEILING
  ) {
    return yield* new GraphCorpusError({
      reason: "size_ceiling",
      detailSafe: "graph snapshot exceeds its in-memory byte ceiling",
    });
  }
  const snapshot = decodeSnapshot({
    ...snapshotWithoutDigest,
    graphDigest: computeGraphDigest(snapshotWithoutDigest),
  });
  const manifestWithoutDigest: Omit<GraphManifestType, "manifestDigest"> = {
    schemaId: GRAPH_MANIFEST_SCHEMA_ID,
    canonicalizationId: GRAPH_CANONICALIZATION_ID,
    graphRef: snapshot.graphRef,
    scopeRef: snapshot.scopeRef,
    graphDigest: snapshot.graphDigest,
    policy: canonicalGraphPolicy(input.policy),
    coverage: {
      mentionCount: mentions.length,
      entityCount: entities.length,
      relationCount: relations.length,
      mergeCount: merges.length,
    },
  };
  const manifest = decodeManifest({
    ...manifestWithoutDigest,
    manifestDigest: computeGraphManifestDigest(manifestWithoutDigest),
  });
  return deepFreeze({ snapshot, manifest } satisfies BuiltGraphCorpus);
});

export const verifyBuiltGraphCorpus = (
  built: BuiltGraphCorpus,
): Effect.Effect<void, GraphCorpusError> =>
  buildGraphCorpus({
    graphRef: built.snapshot.graphRef,
    scopeRef: built.snapshot.scopeRef,
    policy: built.manifest.policy,
    mentions: built.snapshot.mentions,
    entities: built.snapshot.entities,
    relations: built.snapshot.relations,
    merges: built.snapshot.merges,
    embeddingProjections: built.snapshot.embeddingProjections,
  }).pipe(
    Effect.flatMap((rebuilt) =>
      canonicalJson(rebuilt.snapshot) === canonicalJson(built.snapshot) &&
      canonicalJson(rebuilt.manifest) === canonicalJson(built.manifest)
        ? Effect.void
        : Effect.fail(
            new GraphCorpusError({
              reason: "changed",
              detailSafe: "graph snapshot or manifest digest changed",
            }),
          ),
    ),
  );
