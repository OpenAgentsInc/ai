import { Effect, Schema as S } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { RlmSourceLocator } from "@openagentsinc/rlm/schemas";

import {
  GraphAdapterCapability,
  GraphAdapterCapabilityError,
  GraphArtifactInventory,
  GraphDeleteExecutionResult,
  GraphDeletePlanningError,
  GraphDeleteRef,
  GraphDerivation,
  GraphRankingArtifact,
  GraphSummaryArtifact,
  GraphVectorArtifact,
  buildGraphCorpus,
  canonicalJson,
  graphDeleteActionRefs,
  makeCanonicalEntity,
  makeGraphAdapterCapabilities,
  makeGraphArtifactInventory,
  makeCompleteGraphDeleteExecutionResult,
  makeFailedGraphDeleteExecutionResult,
  makeGraphDeleteReceipt,
  makeIncompleteGraphDeleteExecutionResult,
  makeGraphMention,
  makeGraphRelation,
  makeMergeEvidence,
  planGraphSourceDeletion,
  requireExecutableGraphDeletePlan,
  requireGraphAdapterCapability,
  sha256Hex,
  validateGraphDeleteExecutionResult,
  validateGraphDeletePlan,
  validateGraphDeletePlanCurrent,
  validateGraphDeleteReceipt,
  type BuiltGraphCorpus,
  type GraphArtifactInventoryGap,
  type GraphCompleteArtifactInventory,
  type GraphCompleteDeletePlan,
  type GraphDeletePlan,
  type GraphElementRef,
} from "./index.ts";

const deterministic: GraphDerivation = S.decodeUnknownSync(GraphDerivation)({
  _tag: "Deterministic",
  parserRef: "parser.fixture.v1",
  parserVersion: "1.0.0",
});

const source = (
  entryRef: string,
  content = entryRef.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
): RlmSourceLocator => ({
  sourcePlane: "repository",
  sourceKind: "fixture",
  sourceAddress: { addressSchemaId: "fixture.address.v1", encodedAddress: `path:${entryRef}` },
  corpusRef: "source.corpus",
  contentDigest: content as RlmSourceLocator["contentDigest"],
  entryRef: entryRef as RlmSourceLocator["entryRef"],
});

const sourceA = source("a");
const sourceB = source("b");
const sourceC = source("c");
const policy = {
  includeVisibilities: ["private"] as const,
  includeRedactionClasses: ["none"] as const,
};

const fixture = async (relationSources = [sourceA, sourceB]): Promise<BuiltGraphCorpus> => {
  const mentionA = makeGraphMention({
    identityNamespace: "people",
    canonicalKey: "person:alex:mention:a",
    identityScopeRef: "tenant.a",
    source: sourceA,
    derivation: deterministic,
  });
  const mentionB = makeGraphMention({
    identityNamespace: "people",
    canonicalKey: "person:alex:mention:b",
    identityScopeRef: "tenant.a",
    source: sourceB,
    derivation: deterministic,
  });
  const person = makeCanonicalEntity({
    identityNamespace: "people",
    canonicalKey: "person:alex",
    identityScopeRef: "tenant.a",
    mentions: [mentionA, mentionB],
    derivation: deterministic,
  });
  const mentionC = makeGraphMention({
    identityNamespace: "organizations",
    canonicalKey: "organization:openagents:mention:c",
    identityScopeRef: "tenant.a",
    source: sourceC,
    derivation: deterministic,
  });
  const organization = makeCanonicalEntity({
    identityNamespace: "organizations",
    canonicalKey: "organization:openagents",
    identityScopeRef: "tenant.a",
    mentions: [mentionC],
    derivation: deterministic,
  });
  const relation = makeGraphRelation({
    identityNamespace: "relations",
    canonicalKey: "alex-member-of-openagents",
    identityScopeRef: "tenant.a",
    relationKind: "member_of",
    from: person,
    to: organization,
    memberships: relationSources.map((item) => ({ source: item })),
    derivation: deterministic,
  });
  const merge = makeMergeEvidence({
    entity: person,
    mentions: [mentionA, mentionB],
    evidenceRef: "merge.fixture.v1",
  });
  return Effect.runPromise(
    buildGraphCorpus({
      graphRef: "graph.fixture",
      scopeRef: "tenant.a",
      policy,
      mentions: [mentionC, mentionB, mentionA],
      entities: [organization, person],
      relations: [relation],
      merges: [merge],
    }),
  );
};

const artifactInventory = (
  built: BuiltGraphCorpus,
  gaps: ReadonlyArray<GraphArtifactInventoryGap> = [],
) => {
  const [mention] = built.snapshot.mentions.filter(
    (item) => item.source.entryRef === sourceA.entryRef,
  );
  const person = built.snapshot.entities.find((item) => item.mentionRefs.length === 2)!;
  const relation = built.snapshot.relations[0]!;
  const vector = S.decodeUnknownSync(GraphVectorArtifact)({
    artifactKind: "vector",
    artifactRef: "vector.person.v1",
    artifactDigest: "1".repeat(64),
    ownerElementRef: person.elementRef,
  });
  const mentionVector = S.decodeUnknownSync(GraphVectorArtifact)({
    artifactKind: "vector",
    artifactRef: "vector.mention.a.v1",
    artifactDigest: "2".repeat(64),
    ownerElementRef: mention!.elementRef,
  });
  const summary = S.decodeUnknownSync(GraphSummaryArtifact)({
    artifactKind: "summary",
    artifactRef: "summary.person.v1",
    artifactDigest: "3".repeat(64),
    ownerElementRef: person.elementRef,
  });
  const ranking = S.decodeUnknownSync(GraphRankingArtifact)({
    artifactKind: "ranking_ref",
    artifactRef: "ranking.relation.v1",
    artifactDigest: "4".repeat(64),
    ownerElementRef: relation.elementRef,
  });
  return makeGraphArtifactInventory({
    built,
    vectors: [mentionVector, vector],
    summaries: [summary],
    rankingRefs: [ranking],
    coverage: {
      vectors: gaps.some((gap) => gap.artifactKind === "vector")
        ? {
            _tag: "Incomplete",
            gaps: gaps.filter((gap) => gap.artifactKind === "vector"),
          }
        : { _tag: "Complete" },
      summaries: gaps.some((gap) => gap.artifactKind === "summary")
        ? {
            _tag: "Incomplete",
            gaps: gaps.filter((gap) => gap.artifactKind === "summary"),
          }
        : { _tag: "Complete" },
      rankingRefs: gaps.some((gap) => gap.artifactKind === "ranking_ref")
        ? {
            _tag: "Incomplete",
            gaps: gaps.filter((gap) => gap.artifactKind === "ranking_ref"),
          }
        : { _tag: "Complete" },
    },
  });
};

const emptyCompleteInventory = (built: BuiltGraphCorpus): GraphCompleteArtifactInventory =>
  makeGraphArtifactInventory({
    built,
    vectors: [],
    summaries: [],
    rankingRefs: [],
    coverage: {
      vectors: { _tag: "Complete" },
      summaries: { _tag: "Complete" },
      rankingRefs: { _tag: "Complete" },
    },
  }) as GraphCompleteArtifactInventory;

const simulateCompleteAfter = async (
  before: BuiltGraphCorpus,
  plan: GraphCompleteDeletePlan,
  inventory: GraphCompleteArtifactInventory,
) => {
  const removed = new Set(plan.actions.removableElements.map((item) => item.elementRef));
  const entityRekeys = new Map(plan.actions.entityRekeys.map((item) => [item.oldElementRef, item]));
  const relationRekeys = new Map(
    plan.actions.relationRekeys.map((item) => [item.oldElementRef, item]),
  );
  const removedMerges = new Set(plan.actions.removableMerges.map((item) => item.mergeRef));
  const mergeRekeys = new Map(plan.actions.mergeRekeys.map((item) => [item.oldMergeRef, item]));
  const after = await Effect.runPromise(
    buildGraphCorpus({
      graphRef: before.snapshot.graphRef,
      scopeRef: before.snapshot.scopeRef,
      policy: before.snapshot.policy,
      mentions: before.snapshot.mentions.filter((item) => !removed.has(item.elementRef)),
      entities: before.snapshot.entities
        .filter((item) => !removed.has(item.elementRef))
        .map((item) => {
          const action = entityRekeys.get(item.elementRef);
          return action === undefined
            ? item
            : {
                ...item,
                elementRef: action.newElementRef,
                entityRef: action.newEntityRef,
                mentionRefs: action.retainedMentionRefs,
                memberships: action.retainedMemberships,
              };
        }),
      relations: before.snapshot.relations
        .filter((item) => !removed.has(item.elementRef))
        .map((item) => {
          const action = relationRekeys.get(item.elementRef);
          return action === undefined
            ? item
            : {
                ...item,
                elementRef: action.newElementRef,
                relationRef: action.newRelationRef,
                fromEntityRef: action.newFromEntityRef,
                toEntityRef: action.newToEntityRef,
                memberships: action.retainedMemberships,
              };
        }),
      merges: before.snapshot.merges
        .filter((item) => !removedMerges.has(item.mergeRef))
        .map((item) => {
          const action = mergeRekeys.get(item.mergeRef);
          return action === undefined
            ? item
            : {
                ...item,
                mergeRef: action.newMergeRef,
                entityRef: action.newEntityRef,
                mentionRefs: action.retainedMentionRefs,
                memberships: action.retainedMemberships,
              };
        }),
      embeddingProjections: before.snapshot.embeddingProjections,
    }),
  );
  const applyArtifacts = <
    A extends { artifactRef: GraphDeleteRef; ownerElementRef: GraphElementRef },
  >(
    values: ReadonlyArray<A>,
    actions: GraphCompleteDeletePlan["actions"]["vectorActions"],
  ): ReadonlyArray<A> => {
    const byArtifact = new Map(actions.map((item) => [item.artifactRef, item]));
    return values.flatMap((value) => {
      const action = byArtifact.get(value.artifactRef);
      if (action?._tag === "Remove") return [];
      return [
        action?._tag === "RekeyOwner"
          ? ({ ...value, ownerElementRef: action.newOwnerElementRef } as A)
          : value,
      ];
    });
  };
  const afterInventory = makeGraphArtifactInventory({
    built: after,
    vectors: applyArtifacts(inventory.vectors, plan.actions.vectorActions),
    summaries: applyArtifacts(inventory.summaries, plan.actions.summaryActions),
    rankingRefs: applyArtifacts(inventory.rankingRefs, plan.actions.rankingRefActions),
    coverage: {
      vectors: { _tag: "Complete" },
      summaries: { _tag: "Complete" },
      rankingRefs: { _tag: "Complete" },
    },
  }) as GraphCompleteArtifactInventory;
  return { after, afterInventory };
};

describe("graph adapter capabilities", () => {
  test("refuses every unsupported operation with its exact typed capability", async () => {
    const all = GraphAdapterCapability.literals;
    for (const admitted of all) {
      const capabilities = makeGraphAdapterCapabilities([admitted, admitted]);
      expect(capabilities.supported).toEqual([admitted]);
      for (const capability of all) {
        if (capability === admitted) {
          await expect(
            Effect.runPromise(requireGraphAdapterCapability(capabilities, capability)),
          ).resolves.toBeUndefined();
        } else {
          const error = await Effect.runPromise(
            requireGraphAdapterCapability(capabilities, capability).pipe(Effect.flip),
          );
          expect(error).toBeInstanceOf(GraphAdapterCapabilityError);
          expect(error).toMatchObject({ reason: "unsupported_operation", capability });
        }
      }
    }
  });
});

describe("source-outward graph delete planning", () => {
  test("retains shared support, rekeys identities, and accounts for every artifact plane", async () => {
    const built = await fixture();
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, artifactInventory(built)),
    );
    expect(plan._tag).toBe("Complete");
    expect(plan.actions.removableElements.map((item) => item.elementKind)).toEqual(["mention"]);
    expect(plan.actions.entityRekeys).toHaveLength(1);
    expect(plan.actions.entityRekeys[0]!.retainedMentionRefs).toHaveLength(1);
    expect(plan.actions.entityRekeys[0]!.retainedMemberships).toEqual([{ source: sourceB }]);
    expect(plan.actions.relationRekeys).toHaveLength(1);
    expect(plan.actions.removableMerges).toHaveLength(1);
    expect(plan.actions.vectorActions.map((item) => item._tag).sort()).toEqual([
      "RekeyOwner",
      "Remove",
    ]);
    expect(plan.actions.summaryActions.map((item) => item._tag)).toEqual(["RekeyOwner"]);
    expect(plan.actions.rankingRefActions.map((item) => item._tag)).toEqual(["RekeyOwner"]);
    expect(plan.actions.sourceMembershipRemovals.map((item) => item.source)).toEqual(
      plan.actions.sourceMembershipRemovals.map(() => sourceA),
    );
    await expect(Effect.runPromise(validateGraphDeletePlan(plan))).resolves.toBeUndefined();
  });

  test("uses the complete RLM v2 locator and never address-only matching", async () => {
    const built = await fixture();
    const sameAddressDifferentDigest: RlmSourceLocator = {
      ...sourceA,
      contentDigest: "f".repeat(64) as RlmSourceLocator["contentDigest"],
    };
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sameAddressDifferentDigest, artifactInventory(built)),
    );
    expect(graphDeleteActionRefs(plan)).toEqual([]);
    expect(plan._tag).toBe("Complete");
  });

  test("removes an edge only when no admitted source support remains", async () => {
    const built = await fixture([sourceC]);
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceC, artifactInventory(built)),
    );
    expect(plan._tag).toBe("Complete");
    expect(plan.actions.removableElements.map((item) => item.elementKind).sort()).toEqual([
      "entity",
      "mention",
      "relation",
    ]);
  });

  test("removes a zero-support edge even when both endpoint entities remain", async () => {
    const built = await fixture([sourceA]);
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, artifactInventory(built)),
    );
    expect(plan._tag).toBe("Complete");
    expect(
      plan.actions.removableElements.filter((item) => item.elementKind === "relation"),
    ).toHaveLength(1);
    expect(plan.actions.relationRekeys).toEqual([]);
    expect(plan.actions.rankingRefActions.map((item) => item._tag)).toEqual(["Remove"]);
  });

  test("reports an unresolved orphan risk when a retained edge loses its endpoint", async () => {
    const built = await fixture();
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceC, artifactInventory(built)),
    );
    expect(plan._tag).toBe("Incomplete");
    if (plan._tag === "Incomplete") {
      expect(plan.unresolved.map((item) => item.reason)).toContain(
        "retained_relation_endpoint_removal",
      );
    }
    const error = await Effect.runPromise(
      requireExecutableGraphDeletePlan(plan, built, artifactInventory(built)).pipe(Effect.flip),
    );
    expect(error).toMatchObject({ reason: "incomplete_plan" });
  });

  test("marks a convergent entity rekey as incomplete", async () => {
    const base = await fixture();
    const person = base.snapshot.entities.find((item) => item.mentionRefs.length === 2)!;
    const mentionB = base.snapshot.mentions.find(
      (item) => item.source.entryRef === sourceB.entryRef,
    )!;
    const retainedTwin = makeCanonicalEntity({
      identityNamespace: person.identity.identityNamespace,
      canonicalKey: person.identity.canonicalKey,
      identityScopeRef: "tenant.a",
      mentions: [mentionB],
      derivation: deterministic,
    });
    const built = await Effect.runPromise(
      buildGraphCorpus({
        graphRef: base.snapshot.graphRef,
        scopeRef: base.snapshot.scopeRef,
        policy,
        mentions: base.snapshot.mentions,
        entities: [...base.snapshot.entities, retainedTwin],
        relations: base.snapshot.relations,
        merges: base.snapshot.merges,
      }),
    );
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, emptyCompleteInventory(built)),
    );
    expect(plan._tag).toBe("Incomplete");
    if (plan._tag === "Incomplete") {
      expect(plan.unresolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetKind: "entity", reason: "rekey_collision" }),
        ]),
      );
    }
  });

  test("marks a convergent relation rekey as incomplete", async () => {
    const base = await fixture();
    const person = base.snapshot.entities.find((item) => item.mentionRefs.length === 2)!;
    const organization = base.snapshot.entities.find((item) => item.mentionRefs.length === 1)!;
    const retainedTwin = makeGraphRelation({
      identityNamespace: base.snapshot.relations[0]!.identity.identityNamespace,
      canonicalKey: base.snapshot.relations[0]!.identity.canonicalKey,
      identityScopeRef: "tenant.a",
      relationKind: base.snapshot.relations[0]!.relationKind,
      from: person,
      to: organization,
      memberships: [{ source: sourceB }],
      derivation: deterministic,
    });
    const built = await Effect.runPromise(
      buildGraphCorpus({
        graphRef: base.snapshot.graphRef,
        scopeRef: base.snapshot.scopeRef,
        policy,
        mentions: base.snapshot.mentions,
        entities: base.snapshot.entities,
        relations: [...base.snapshot.relations, retainedTwin],
        merges: base.snapshot.merges,
      }),
    );
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, emptyCompleteInventory(built)),
    );
    expect(plan._tag).toBe("Incomplete");
    if (plan._tag === "Incomplete") {
      expect(plan.unresolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetKind: "relation", reason: "rekey_collision" }),
        ]),
      );
    }
  });

  test("marks convergent merge rekeys as incomplete", async () => {
    const mentionA = makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "person:merge:mention:a",
      identityScopeRef: "tenant.a",
      source: sourceA,
      derivation: deterministic,
    });
    const mentionB = makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "person:merge:mention:b",
      identityScopeRef: "tenant.a",
      source: sourceB,
      derivation: deterministic,
    });
    const sourceD = source("d");
    const mentionD = makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "person:merge:mention:d",
      identityScopeRef: "tenant.a",
      source: sourceD,
      derivation: deterministic,
    });
    const entity = makeCanonicalEntity({
      identityNamespace: "people",
      canonicalKey: "person:merge",
      identityScopeRef: "tenant.a",
      mentions: [mentionA, mentionB, mentionD],
      derivation: deterministic,
    });
    const wideMerge = makeMergeEvidence({
      entity,
      mentions: [mentionA, mentionB, mentionD],
      evidenceRef: "merge.convergence.v1",
    });
    const retainedMerge = makeMergeEvidence({
      entity,
      mentions: [mentionB, mentionD],
      evidenceRef: "merge.convergence.v1",
    });
    const built = await Effect.runPromise(
      buildGraphCorpus({
        graphRef: "graph.merge-collision",
        scopeRef: "tenant.a",
        policy,
        mentions: [mentionA, mentionB, mentionD],
        entities: [entity],
        relations: [],
        merges: [wideMerge, retainedMerge],
      }),
    );
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, emptyCompleteInventory(built)),
    );
    expect(plan._tag).toBe("Incomplete");
    if (plan._tag === "Incomplete") {
      expect(plan.unresolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetKind: "merge", reason: "rekey_collision" }),
        ]),
      );
    }
  });

  test("propagates incomplete provenance without inventing a complete plan", async () => {
    const built = await fixture();
    const gap: GraphArtifactInventoryGap = {
      artifactKind: "summary",
      reason: "inventory_partial",
      evidenceRef: "inventory.scan.partial" as GraphArtifactInventoryGap["evidenceRef"],
    };
    const inventory = artifactInventory(built, [gap]);
    expect(inventory._tag).toBe("Incomplete");
    const plan = await Effect.runPromise(planGraphSourceDeletion(built, sourceA, inventory));
    expect(plan._tag).toBe("Incomplete");
    if (plan._tag === "Incomplete") {
      expect(plan.unresolved.some((item) => item.targetKind === "summary")).toBe(true);
    }
  });

  test("is deterministic and idempotent under repeated planning and inventory order", async () => {
    const built = await fixture();
    const inventory = artifactInventory(built);
    const reversed = makeGraphArtifactInventory({
      built,
      vectors: [...inventory.vectors].reverse(),
      summaries: [...inventory.summaries].reverse(),
      rankingRefs: [...inventory.rankingRefs].reverse(),
      coverage: inventory.coverage,
    });
    const [first, repeated, permuted] = await Promise.all([
      Effect.runPromise(planGraphSourceDeletion(built, sourceA, inventory)),
      Effect.runPromise(planGraphSourceDeletion(built, sourceA, inventory)),
      Effect.runPromise(planGraphSourceDeletion(built, sourceA, reversed)),
    ]);
    expect(repeated).toEqual(first);
    expect(permuted).toEqual(first);
    expect(repeated.idempotencyKey).toBe(first.idempotencyKey);
  });

  test("canonicalizes incomplete per-plane gaps under permutation", async () => {
    const built = await fixture();
    const gaps: ReadonlyArray<GraphArtifactInventoryGap> = [
      {
        artifactKind: "summary",
        reason: "inventory_partial",
        evidenceRef: "inventory.summary.partial" as GraphArtifactInventoryGap["evidenceRef"],
      },
      {
        artifactKind: "summary",
        reason: "adapter_unavailable",
        evidenceRef: "inventory.summary.offline" as GraphArtifactInventoryGap["evidenceRef"],
      },
    ];
    const left = artifactInventory(built, gaps);
    const right = artifactInventory(built, [...gaps].reverse());
    expect(right).toEqual(left);
    const [leftPlan, rightPlan] = await Promise.all([
      Effect.runPromise(planGraphSourceDeletion(built, sourceA, left)),
      Effect.runPromise(planGraphSourceDeletion(built, sourceA, right)),
    ]);
    expect(rightPlan).toEqual(leftPlan);
  });

  test("rejects changed inventories and stale graph digests", async () => {
    const built = await fixture();
    const inventory = structuredClone(artifactInventory(built));
    (inventory as unknown as { graphDigest: string }).graphDigest = "e".repeat(64);
    const inventoryError = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, inventory).pipe(Effect.flip),
    );
    expect(inventoryError).toMatchObject({ reason: "inventory_changed" });

    const plan = await Effect.runPromise(
      planGraphSourceDeletion(built, sourceA, artifactInventory(built)),
    );
    const extra = makeGraphMention({
      identityNamespace: "extra",
      canonicalKey: "extra",
      identityScopeRef: "tenant.a",
      source: source("d"),
      derivation: deterministic,
    });
    const changed = await Effect.runPromise(
      buildGraphCorpus({
        graphRef: built.snapshot.graphRef,
        scopeRef: built.snapshot.scopeRef,
        policy,
        mentions: [...built.snapshot.mentions, extra],
        entities: built.snapshot.entities,
        relations: built.snapshot.relations,
        merges: built.snapshot.merges,
      }),
    );
    const stale = await Effect.runPromise(
      validateGraphDeletePlanCurrent(plan, changed).pipe(Effect.flip),
    );
    expect(stale).toMatchObject({ reason: "stale_plan" });
  });

  test("keeps every surviving membership free of the deleted exact source", async () => {
    const built = await fixture();
    for (const target of [sourceA, sourceB]) {
      const plan = await Effect.runPromise(
        planGraphSourceDeletion(built, target, artifactInventory(built)),
      );
      expect(plan._tag).toBe("Complete");
      for (const rekey of [...plan.actions.entityRekeys, ...plan.actions.relationRekeys]) {
        expect(
          rekey.retainedMemberships.some((item) => item.source.entryRef === target.entryRef),
        ).toBe(false);
        expect(rekey.retainedMemberships.length).toBeGreaterThan(0);
      }
      const removed = new Set(plan.actions.removableElements.map((item) => item.elementRef));
      for (const actions of [
        plan.actions.vectorActions,
        plan.actions.summaryActions,
        plan.actions.rankingRefActions,
      ]) {
        for (const action of actions) {
          expect(action._tag === "Remove" ? removed.has(action.oldOwnerElementRef) : true).toBe(
            true,
          );
        }
      }
    }
  });
});

describe("delete execution results and receipts", () => {
  test("validates the exact after graph, inventory, action set, and receipt", async () => {
    const before = await fixture();
    const beforeInventory = artifactInventory(before) as GraphCompleteArtifactInventory;
    const plan = (await Effect.runPromise(
      planGraphSourceDeletion(before, sourceA, beforeInventory),
    )) as GraphCompleteDeletePlan;
    const { after, afterInventory } = await simulateCompleteAfter(before, plan, beforeInventory);
    const context = { before, beforeInventory, after, afterInventory };
    const result = await Effect.runPromise(makeCompleteGraphDeleteExecutionResult(plan, context));
    expect(result._tag).toBe("Complete");
    expect(result.completedActionRefs).toEqual(graphDeleteActionRefs(plan));
    await expect(
      Effect.runPromise(validateGraphDeleteExecutionResult(plan, result, context)),
    ).resolves.toBeUndefined();
    const receipt = await Effect.runPromise(makeGraphDeleteReceipt(plan, result, context));
    expect(receipt._tag).toBe("Complete");
    await expect(
      Effect.runPromise(validateGraphDeleteReceipt(plan, result, receipt, context)),
    ).resolves.toBeUndefined();

    const substituted = {
      ...receipt,
      graphDigestBefore: "f".repeat(64),
    } as unknown as typeof receipt;
    const error = await Effect.runPromise(
      validateGraphDeleteReceipt(plan, result, substituted, context).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(GraphDeletePlanningError);
    expect(error.reason).toBe("invalid_receipt");
  });

  test("does not mint complete results from arbitrary after digests or states", async () => {
    const before = await fixture();
    const beforeInventory = artifactInventory(before) as GraphCompleteArtifactInventory;
    const plan = (await Effect.runPromise(
      planGraphSourceDeletion(before, sourceA, beforeInventory),
    )) as GraphCompleteDeletePlan;
    const error = await Effect.runPromise(
      makeCompleteGraphDeleteExecutionResult(plan, {
        before,
        beforeInventory,
        after: before,
        afterInventory: beforeInventory,
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("invalid_execution_result");
  });

  test("rejects an after inventory that leaves an artifact owner orphaned", async () => {
    const before = await fixture();
    const beforeInventory = artifactInventory(before) as GraphCompleteArtifactInventory;
    const plan = (await Effect.runPromise(
      planGraphSourceDeletion(before, sourceA, beforeInventory),
    )) as GraphCompleteDeletePlan;
    const { after, afterInventory } = await simulateCompleteAfter(before, plan, beforeInventory);
    const removedOwner = before.snapshot.mentions.find(
      (item) => item.source.entryRef === sourceA.entryRef,
    )!.elementRef;
    const orphaned = makeGraphArtifactInventory({
      built: after,
      vectors: [
        {
          ...afterInventory.vectors[0]!,
          ownerElementRef: removedOwner,
        },
      ],
      summaries: afterInventory.summaries,
      rankingRefs: afterInventory.rankingRefs,
      coverage: afterInventory.coverage,
    });
    const error = await Effect.runPromise(
      makeCompleteGraphDeleteExecutionResult(plan, {
        before,
        beforeInventory,
        after,
        afterInventory: orphaned,
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("invalid_inventory");
  });

  test("rejects a digest-valid fabricated complete plan by exact recomputation", async () => {
    const before = await fixture();
    const beforeInventory = artifactInventory(before);
    const plan = await Effect.runPromise(planGraphSourceDeletion(before, sourceA, beforeInventory));
    const fabricated = structuredClone(plan) as GraphDeletePlan;
    (
      fabricated.actions as unknown as {
        removableElements: typeof fabricated.actions.removableElements;
      }
    ).removableElements = fabricated.actions.removableElements.slice(1);
    const { planDigest: _oldDigest, idempotencyKey: _oldKey, ...content } = fabricated;
    const newDigest = sha256Hex(canonicalJson(content));
    (fabricated as unknown as { planDigest: string; idempotencyKey: string }).planDigest =
      newDigest;
    (fabricated as unknown as { planDigest: string; idempotencyKey: string }).idempotencyKey =
      `graph-delete.${newDigest}`;
    await expect(Effect.runPromise(validateGraphDeletePlan(fabricated))).resolves.toBeUndefined();
    const error = await Effect.runPromise(
      requireExecutableGraphDeletePlan(fabricated, before, beforeInventory).pipe(Effect.flip),
    );
    expect(error.reason).toBe("digest_substitution");
  });

  test("keeps complete, incomplete, and failed result and receipt variants disjoint", async () => {
    const before = await fixture();
    const beforeInventory = artifactInventory(before) as GraphCompleteArtifactInventory;
    const plan = (await Effect.runPromise(
      planGraphSourceDeletion(before, sourceA, beforeInventory),
    )) as GraphCompleteDeletePlan;
    const incomplete = await Effect.runPromise(
      makeIncompleteGraphDeleteExecutionResult(
        plan,
        { before, beforeInventory, after: before, afterInventory: beforeInventory },
        [],
        graphDeleteActionRefs(plan),
      ),
    );
    expect(incomplete._tag).toBe("Incomplete");
    const incompleteContext = {
      before,
      beforeInventory,
      after: before,
      afterInventory: beforeInventory,
    };
    await expect(
      Effect.runPromise(validateGraphDeleteExecutionResult(plan, incomplete, incompleteContext)),
    ).resolves.toBeUndefined();
    const failed = await Effect.runPromise(
      makeFailedGraphDeleteExecutionResult(
        plan,
        before,
        beforeInventory,
        S.decodeUnknownSync(GraphDeleteRef)("host.execution.failed"),
      ),
    );
    expect(failed._tag).toBe("Failed");
    expect(
      S.is(GraphDeleteExecutionResult)({
        ...failed,
        _tag: "Complete",
        graphDigestAfter: before.snapshot.graphDigest,
      }),
    ).toBe(false);
    const failedReceipt = await Effect.runPromise(
      makeGraphDeleteReceipt(plan, failed, { before, beforeInventory }),
    );
    expect(failedReceipt._tag).toBe("Failed");
  });

  test("rejects substituted plan and inventory digests", async () => {
    const built = await fixture();
    const inventory = artifactInventory(built);
    const plan = await Effect.runPromise(planGraphSourceDeletion(built, sourceA, inventory));
    const corrupted = structuredClone(plan) as GraphDeletePlan;
    (corrupted as unknown as { artifactInventoryDigest: string }).artifactInventoryDigest =
      "f".repeat(64);
    const error = await Effect.runPromise(validateGraphDeletePlan(corrupted).pipe(Effect.flip));
    expect(error.reason).toBe("digest_substitution");
  });
});

test("artifact inventory schema keeps complete and incomplete claims distinct", async () => {
  const built = await fixture();
  const complete = artifactInventory(built);
  expect(S.is(GraphArtifactInventory)(complete)).toBe(true);
  expect(() =>
    S.decodeUnknownSync(GraphArtifactInventory)({
      ...complete,
      _tag: "Complete",
      coverage: {
        ...complete.coverage,
        vectors: {
          _tag: "Incomplete",
          gaps: [
            {
              artifactKind: "vector",
              reason: "inventory_partial",
              evidenceRef: "bad.complete.claim",
            },
          ],
        },
      },
    }),
  ).toThrow();
  const { coverage: _coverage, ...withoutCoverage } = complete;
  expect(() => S.decodeUnknownSync(GraphArtifactInventory)(withoutCoverage)).toThrow();
});
