import { Effect, Schema as S } from "effect";
import { RlmSourceLocator } from "@openagentsinc/rlm/schemas";

import {
  canonicalJson,
  canonicalSourceMemberships,
  compareCanonicalText,
  deriveGraphElementRef,
  sha256Hex,
} from "./canonical.ts";
import { buildGraphCorpus, verifyBuiltGraphCorpus, type BuiltGraphCorpus } from "./builder.ts";
import {
  GRAPH_CANONICALIZATION_ID,
  GraphDigest,
  GraphElementRef,
  GraphEntityRef,
  GraphMergeRef,
  GraphMentionRef,
  GraphRef,
  GraphRelationRef,
  GraphScopeRef,
  GraphSourceMembership,
  graphDigest,
  graphEntityRef,
  graphMergeRef,
  graphRelationRef,
} from "./schemas.ts";

export const GRAPH_ARTIFACT_INVENTORY_SCHEMA_ID =
  "openagents.ai.graph_artifact_inventory.v1" as const;
export const GRAPH_DELETE_PLAN_SCHEMA_ID = "openagents.ai.graph_delete_plan.v1" as const;
export const GRAPH_DELETE_EXECUTION_RESULT_SCHEMA_ID =
  "openagents.ai.graph_delete_execution_result.v1" as const;
export const GRAPH_DELETE_RECEIPT_SCHEMA_ID = "openagents.ai.graph_delete_receipt.v1" as const;

export const GraphDeleteRef = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(512),
  S.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
).pipe(S.brand("GraphDeleteRef"));
export type GraphDeleteRef = typeof GraphDeleteRef.Type;
const graphDeleteRef = S.decodeUnknownSync(GraphDeleteRef);
const GraphOpaqueRef = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(512),
  S.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);

export const GraphDerivedArtifactKind = S.Literals(["vector", "summary", "ranking_ref"]);
export type GraphDerivedArtifactKind = typeof GraphDerivedArtifactKind.Type;

const artifactRecordFields = {
  artifactRef: GraphDeleteRef,
  artifactDigest: GraphDigest,
  ownerElementRef: GraphElementRef,
};

export const GraphVectorArtifact = S.Struct({
  ...artifactRecordFields,
  artifactKind: S.Literal("vector"),
});
export type GraphVectorArtifact = typeof GraphVectorArtifact.Type;

export const GraphSummaryArtifact = S.Struct({
  ...artifactRecordFields,
  artifactKind: S.Literal("summary"),
});
export type GraphSummaryArtifact = typeof GraphSummaryArtifact.Type;

export const GraphRankingArtifact = S.Struct({
  ...artifactRecordFields,
  artifactKind: S.Literal("ranking_ref"),
});
export type GraphRankingArtifact = typeof GraphRankingArtifact.Type;

export const GraphArtifactInventoryGap = S.Struct({
  artifactKind: GraphDerivedArtifactKind,
  ownerElementRef: S.optionalKey(GraphElementRef),
  reason: S.Literals(["inventory_partial", "owner_unknown", "adapter_unavailable"]),
  evidenceRef: GraphDeleteRef,
});
export type GraphArtifactInventoryGap = typeof GraphArtifactInventoryGap.Type;

export const GraphCompleteArtifactPlaneCoverage = S.Struct({
  _tag: S.Literal("Complete"),
  gaps: S.optionalKey(S.Never),
});
export type GraphCompleteArtifactPlaneCoverage = typeof GraphCompleteArtifactPlaneCoverage.Type;

export const GraphIncompleteArtifactPlaneCoverage = S.Struct({
  _tag: S.Literal("Incomplete"),
  gaps: S.Array(GraphArtifactInventoryGap),
});
export type GraphIncompleteArtifactPlaneCoverage = typeof GraphIncompleteArtifactPlaneCoverage.Type;

export const GraphArtifactPlaneCoverage = S.Union([
  GraphCompleteArtifactPlaneCoverage,
  GraphIncompleteArtifactPlaneCoverage,
]);
export type GraphArtifactPlaneCoverage = typeof GraphArtifactPlaneCoverage.Type;

export const GraphArtifactInventoryCoverage = S.Struct({
  vectors: GraphArtifactPlaneCoverage,
  summaries: GraphArtifactPlaneCoverage,
  rankingRefs: GraphArtifactPlaneCoverage,
});
export type GraphArtifactInventoryCoverage = typeof GraphArtifactInventoryCoverage.Type;

const artifactInventoryFields = {
  schemaId: S.Literal(GRAPH_ARTIFACT_INVENTORY_SCHEMA_ID),
  canonicalizationId: S.Literal(GRAPH_CANONICALIZATION_ID),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  vectors: S.Array(GraphVectorArtifact),
  summaries: S.Array(GraphSummaryArtifact),
  rankingRefs: S.Array(GraphRankingArtifact),
};

export const GraphCompleteArtifactInventory = S.Struct({
  ...artifactInventoryFields,
  _tag: S.Literal("Complete"),
  coverage: S.Struct({
    vectors: GraphCompleteArtifactPlaneCoverage,
    summaries: GraphCompleteArtifactPlaneCoverage,
    rankingRefs: GraphCompleteArtifactPlaneCoverage,
  }),
  inventoryDigest: GraphDigest,
});
export type GraphCompleteArtifactInventory = typeof GraphCompleteArtifactInventory.Type;

export const GraphIncompleteArtifactInventory = S.Struct({
  ...artifactInventoryFields,
  _tag: S.Literal("Incomplete"),
  coverage: GraphArtifactInventoryCoverage,
  inventoryDigest: GraphDigest,
});
export type GraphIncompleteArtifactInventory = typeof GraphIncompleteArtifactInventory.Type;

export const GraphArtifactInventory = S.Union([
  GraphCompleteArtifactInventory,
  GraphIncompleteArtifactInventory,
]);
export type GraphArtifactInventory = typeof GraphArtifactInventory.Type;

export class GraphDeletePlanningError extends S.TaggedErrorClass<GraphDeletePlanningError>()(
  "GraphCorpus.DeletePlanningError",
  {
    reason: S.Literals([
      "invalid_graph",
      "invalid_inventory",
      "inventory_changed",
      "stale_plan",
      "incomplete_plan",
      "invalid_execution_result",
      "invalid_receipt",
      "digest_substitution",
    ]),
    detailSafe: S.optionalKey(S.String.check(S.isMaxLength(512))),
  },
) {}

export const GraphSourceMembershipRemoval = S.Struct({
  actionRef: GraphDeleteRef,
  elementKind: S.Literals(["mention", "entity", "relation", "merge"]),
  elementRef: S.Union([GraphElementRef, GraphMergeRef]),
  source: RlmSourceLocator,
});
export type GraphSourceMembershipRemoval = typeof GraphSourceMembershipRemoval.Type;

export const GraphRemovableElement = S.Struct({
  actionRef: GraphDeleteRef,
  elementKind: S.Literals(["mention", "entity", "relation"]),
  elementRef: GraphElementRef,
});
export type GraphRemovableElement = typeof GraphRemovableElement.Type;

export const GraphEntityRekeyAction = S.Struct({
  actionRef: GraphDeleteRef,
  oldElementRef: GraphElementRef,
  newElementRef: GraphElementRef,
  oldEntityRef: GraphEntityRef,
  newEntityRef: GraphEntityRef,
  removedMentionRefs: S.Array(GraphMentionRef),
  retainedMentionRefs: S.Array(GraphMentionRef),
  retainedMemberships: S.Array(GraphSourceMembership),
});
export type GraphEntityRekeyAction = typeof GraphEntityRekeyAction.Type;

export const GraphRelationRekeyAction = S.Struct({
  actionRef: GraphDeleteRef,
  oldElementRef: GraphElementRef,
  newElementRef: GraphElementRef,
  oldRelationRef: GraphRelationRef,
  newRelationRef: GraphRelationRef,
  oldFromEntityRef: GraphEntityRef,
  newFromEntityRef: GraphEntityRef,
  oldToEntityRef: GraphEntityRef,
  newToEntityRef: GraphEntityRef,
  retainedMemberships: S.Array(GraphSourceMembership),
});
export type GraphRelationRekeyAction = typeof GraphRelationRekeyAction.Type;

export const GraphRemovableMerge = S.Struct({
  actionRef: GraphDeleteRef,
  mergeRef: GraphMergeRef,
});
export type GraphRemovableMerge = typeof GraphRemovableMerge.Type;

export const GraphMergeRekeyAction = S.Struct({
  actionRef: GraphDeleteRef,
  oldMergeRef: GraphMergeRef,
  newMergeRef: GraphMergeRef,
  oldEntityRef: GraphEntityRef,
  newEntityRef: GraphEntityRef,
  retainedMentionRefs: S.Array(GraphMentionRef),
  retainedMemberships: S.Array(GraphSourceMembership),
});
export type GraphMergeRekeyAction = typeof GraphMergeRekeyAction.Type;

const artifactActionFields = {
  actionRef: GraphDeleteRef,
  artifactRef: GraphDeleteRef,
  artifactDigest: GraphDigest,
  oldOwnerElementRef: GraphElementRef,
};

export const GraphDerivedArtifactAction = S.Union([
  S.Struct({ ...artifactActionFields, _tag: S.Literal("Remove") }),
  S.Struct({
    ...artifactActionFields,
    _tag: S.Literal("RekeyOwner"),
    newOwnerElementRef: GraphElementRef,
  }),
]);
export type GraphDerivedArtifactAction = typeof GraphDerivedArtifactAction.Type;

export const GraphDeleteUnresolved = S.Struct({
  unresolvedRef: GraphDeleteRef,
  targetKind: S.Literals(["vector", "summary", "ranking_ref", "entity", "relation", "merge"]),
  targetRef: S.optionalKey(GraphOpaqueRef),
  reason: S.Literals([
    "inventory_partial",
    "owner_unknown",
    "adapter_unavailable",
    "retained_relation_endpoint_removal",
    "rekey_collision",
  ]),
  evidenceRef: GraphDeleteRef,
});
export type GraphDeleteUnresolved = typeof GraphDeleteUnresolved.Type;

export const GraphDeleteActionSet = S.Struct({
  sourceMembershipRemovals: S.Array(GraphSourceMembershipRemoval),
  removableElements: S.Array(GraphRemovableElement),
  entityRekeys: S.Array(GraphEntityRekeyAction),
  relationRekeys: S.Array(GraphRelationRekeyAction),
  removableMerges: S.Array(GraphRemovableMerge),
  mergeRekeys: S.Array(GraphMergeRekeyAction),
  vectorActions: S.Array(GraphDerivedArtifactAction),
  summaryActions: S.Array(GraphDerivedArtifactAction),
  rankingRefActions: S.Array(GraphDerivedArtifactAction),
});
export type GraphDeleteActionSet = typeof GraphDeleteActionSet.Type;

const deletePlanFields = {
  schemaId: S.Literal(GRAPH_DELETE_PLAN_SCHEMA_ID),
  canonicalizationId: S.Literal(GRAPH_CANONICALIZATION_ID),
  graphRef: GraphRef,
  scopeRef: GraphScopeRef,
  graphDigest: GraphDigest,
  manifestDigest: GraphDigest,
  artifactInventoryDigest: GraphDigest,
  source: RlmSourceLocator,
  actions: GraphDeleteActionSet,
  planDigest: GraphDigest,
  idempotencyKey: GraphDeleteRef,
};

export const GraphCompleteDeletePlan = S.Struct({
  ...deletePlanFields,
  _tag: S.Literal("Complete"),
  unresolved: S.optionalKey(S.Never),
});
export type GraphCompleteDeletePlan = typeof GraphCompleteDeletePlan.Type;

export const GraphIncompleteDeletePlan = S.Struct({
  ...deletePlanFields,
  _tag: S.Literal("Incomplete"),
  unresolved: S.Array(GraphDeleteUnresolved),
});
export type GraphIncompleteDeletePlan = typeof GraphIncompleteDeletePlan.Type;

export const GraphDeletePlan = S.Union([GraphCompleteDeletePlan, GraphIncompleteDeletePlan]);
export type GraphDeletePlan = typeof GraphDeletePlan.Type;

const executionResultFields = {
  schemaId: S.Literal(GRAPH_DELETE_EXECUTION_RESULT_SCHEMA_ID),
  planDigest: GraphDigest,
  idempotencyKey: GraphDeleteRef,
  graphDigestBefore: GraphDigest,
  manifestDigestBefore: GraphDigest,
  artifactInventoryDigestBefore: GraphDigest,
  completedActionRefs: S.Array(GraphDeleteRef),
  resultDigest: GraphDigest,
};

export const GraphCompleteDeleteExecutionResult = S.Struct({
  ...executionResultFields,
  _tag: S.Literal("Complete"),
  graphDigestAfter: GraphDigest,
  manifestDigestAfter: GraphDigest,
  artifactInventoryDigestAfter: GraphDigest,
  failedActionRefs: S.optionalKey(S.Never),
  failureRef: S.optionalKey(S.Never),
});
export type GraphCompleteDeleteExecutionResult = typeof GraphCompleteDeleteExecutionResult.Type;

export const GraphIncompleteDeleteExecutionResult = S.Struct({
  ...executionResultFields,
  _tag: S.Literal("Incomplete"),
  failedActionRefs: S.Array(GraphDeleteRef),
  graphDigestAfter: GraphDigest,
  manifestDigestAfter: GraphDigest,
  artifactInventoryDigestAfter: GraphDigest,
  failureRef: S.optionalKey(S.Never),
});
export type GraphIncompleteDeleteExecutionResult = typeof GraphIncompleteDeleteExecutionResult.Type;

export const GraphFailedDeleteExecutionResult = S.Struct({
  schemaId: S.Literal(GRAPH_DELETE_EXECUTION_RESULT_SCHEMA_ID),
  _tag: S.Literal("Failed"),
  planDigest: GraphDigest,
  idempotencyKey: GraphDeleteRef,
  graphDigestBefore: GraphDigest,
  manifestDigestBefore: GraphDigest,
  artifactInventoryDigestBefore: GraphDigest,
  failureRef: GraphDeleteRef,
  completedActionRefs: S.optionalKey(S.Never),
  failedActionRefs: S.optionalKey(S.Never),
  graphDigestAfter: S.optionalKey(S.Never),
  manifestDigestAfter: S.optionalKey(S.Never),
  artifactInventoryDigestAfter: S.optionalKey(S.Never),
  resultDigest: GraphDigest,
});
export type GraphFailedDeleteExecutionResult = typeof GraphFailedDeleteExecutionResult.Type;

export const GraphDeleteExecutionResult = S.Union([
  GraphCompleteDeleteExecutionResult,
  GraphIncompleteDeleteExecutionResult,
  GraphFailedDeleteExecutionResult,
]);
export type GraphDeleteExecutionResult = typeof GraphDeleteExecutionResult.Type;

const receiptFields = {
  schemaId: S.Literal(GRAPH_DELETE_RECEIPT_SCHEMA_ID),
  receiptRef: GraphDeleteRef,
  planDigest: GraphDigest,
  idempotencyKey: GraphDeleteRef,
  resultDigest: GraphDigest,
  graphDigestBefore: GraphDigest,
  manifestDigestBefore: GraphDigest,
  artifactInventoryDigestBefore: GraphDigest,
  receiptDigest: GraphDigest,
};

export const GraphCompleteDeleteReceipt = S.Struct({
  ...receiptFields,
  _tag: S.Literal("Complete"),
  graphDigestAfter: GraphDigest,
  manifestDigestAfter: GraphDigest,
  artifactInventoryDigestAfter: GraphDigest,
  failureRef: S.optionalKey(S.Never),
});
export type GraphCompleteDeleteReceipt = typeof GraphCompleteDeleteReceipt.Type;

export const GraphIncompleteDeleteReceipt = S.Struct({
  ...receiptFields,
  _tag: S.Literal("Incomplete"),
  graphDigestAfter: GraphDigest,
  manifestDigestAfter: GraphDigest,
  artifactInventoryDigestAfter: GraphDigest,
  failureRef: S.optionalKey(S.Never),
});
export type GraphIncompleteDeleteReceipt = typeof GraphIncompleteDeleteReceipt.Type;

export const GraphFailedDeleteReceipt = S.Struct({
  ...receiptFields,
  _tag: S.Literal("Failed"),
  failureRef: GraphDeleteRef,
  graphDigestAfter: S.optionalKey(S.Never),
  manifestDigestAfter: S.optionalKey(S.Never),
  artifactInventoryDigestAfter: S.optionalKey(S.Never),
});
export type GraphFailedDeleteReceipt = typeof GraphFailedDeleteReceipt.Type;

export const GraphDeleteReceipt = S.Union([
  GraphCompleteDeleteReceipt,
  GraphIncompleteDeleteReceipt,
  GraphFailedDeleteReceipt,
]);
export type GraphDeleteReceipt = typeof GraphDeleteReceipt.Type;

const decodeInventory = S.decodeUnknownSync(GraphArtifactInventory);
const decodePlan = S.decodeUnknownSync(GraphDeletePlan);
const decodeExecutionResult = S.decodeUnknownSync(GraphDeleteExecutionResult);
const decodeReceipt = S.decodeUnknownSync(GraphDeleteReceipt);

const digest = (value: unknown): GraphDigest => graphDigest(sha256Hex(canonicalJson(value)));
const byRef = <A>(values: ReadonlyArray<A>, ref: (value: A) => string): ReadonlyArray<A> =>
  [...values].sort((left, right) => compareCanonicalText(ref(left), ref(right)));
const refSuffix = (value: string): string => value.slice(value.lastIndexOf(".") + 1);
const sameSource = (left: RlmSourceLocator, right: RlmSourceLocator): boolean =>
  canonicalJson(left) === canonicalJson(right);
const removeSource = (
  memberships: ReadonlyArray<GraphSourceMembership>,
  source: RlmSourceLocator,
): ReadonlyArray<GraphSourceMembership> =>
  canonicalSourceMemberships(memberships.filter((item) => !sameSource(item.source, source)));
const includesSource = (
  memberships: ReadonlyArray<GraphSourceMembership>,
  source: RlmSourceLocator,
): boolean => memberships.some((item) => sameSource(item.source, source));
const actionRef = (kind: string, value: unknown): GraphDeleteRef =>
  graphDeleteRef(`delete-action.${kind}.${sha256Hex(canonicalJson(value))}`);

const inventoryContent = (inventory: Omit<GraphArtifactInventory, "inventoryDigest">): unknown =>
  inventory;

export interface MakeGraphArtifactInventoryInput {
  readonly built: BuiltGraphCorpus;
  readonly vectors: ReadonlyArray<GraphVectorArtifact>;
  readonly summaries: ReadonlyArray<GraphSummaryArtifact>;
  readonly rankingRefs: ReadonlyArray<GraphRankingArtifact>;
  readonly coverage: GraphArtifactInventoryCoverage;
}

/** Bind a host-declared derived-artifact inventory to one immutable graph. */
export const makeGraphArtifactInventory = (
  input: MakeGraphArtifactInventoryInput,
): GraphArtifactInventory => {
  const vectors = byRef(structuredClone(input.vectors), (item) => item.artifactRef);
  const summaries = byRef(structuredClone(input.summaries), (item) => item.artifactRef);
  const rankingRefs = byRef(structuredClone(input.rankingRefs), (item) => item.artifactRef);
  const canonicalCoverage = (coverage: GraphArtifactPlaneCoverage): GraphArtifactPlaneCoverage =>
    coverage._tag === "Complete"
      ? { _tag: "Complete" }
      : { _tag: "Incomplete", gaps: byRef(structuredClone(coverage.gaps), canonicalJson) };
  const coverage = {
    vectors: canonicalCoverage(input.coverage.vectors),
    summaries: canonicalCoverage(input.coverage.summaries),
    rankingRefs: canonicalCoverage(input.coverage.rankingRefs),
  } as const;
  const common = {
    schemaId: GRAPH_ARTIFACT_INVENTORY_SCHEMA_ID,
    canonicalizationId: GRAPH_CANONICALIZATION_ID,
    graphRef: input.built.snapshot.graphRef,
    scopeRef: input.built.snapshot.scopeRef,
    graphDigest: input.built.snapshot.graphDigest,
    manifestDigest: input.built.manifest.manifestDigest,
    vectors,
    summaries,
    rankingRefs,
    coverage,
  } as const;
  const withoutDigest = Object.values(coverage).every((item) => item._tag === "Complete")
    ? { ...common, _tag: "Complete" as const }
    : { ...common, _tag: "Incomplete" as const };
  return decodeInventory({
    ...withoutDigest,
    inventoryDigest: digest(
      inventoryContent(withoutDigest as Omit<GraphArtifactInventory, "inventoryDigest">),
    ),
  });
};

const validateInventory = (
  built: BuiltGraphCorpus,
  inventory: GraphArtifactInventory,
): Effect.Effect<void, GraphDeletePlanningError> =>
  Effect.gen(function* () {
    let decoded: GraphArtifactInventory;
    try {
      decoded = decodeInventory(inventory);
    } catch {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_inventory",
        detailSafe: "The artifact inventory does not match its schema.",
      });
    }
    const { inventoryDigest, ...withoutDigest } = decoded;
    if (
      digest(inventoryContent(withoutDigest as Omit<GraphArtifactInventory, "inventoryDigest">)) !==
      inventoryDigest
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "inventory_changed",
        detailSafe: "The artifact inventory digest does not match its content.",
      });
    }
    if (
      decoded.graphRef !== built.snapshot.graphRef ||
      decoded.scopeRef !== built.snapshot.scopeRef ||
      decoded.graphDigest !== built.snapshot.graphDigest ||
      decoded.manifestDigest !== built.manifest.manifestDigest
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "inventory_changed",
        detailSafe: "The artifact inventory is bound to a different graph.",
      });
    }
    const incompletePlanes = Object.entries(decoded.coverage).filter(
      ([, coverage]) => coverage._tag === "Incomplete",
    );
    if (
      (decoded._tag === "Complete" && incompletePlanes.length > 0) ||
      (decoded._tag === "Incomplete" && incompletePlanes.length === 0) ||
      incompletePlanes.some(
        ([plane, coverage]) =>
          coverage._tag === "Incomplete" &&
          (coverage.gaps.length === 0 ||
            coverage.gaps.some((gap) =>
              plane === "vectors"
                ? gap.artifactKind !== "vector"
                : plane === "summaries"
                  ? gap.artifactKind !== "summary"
                  : gap.artifactKind !== "ranking_ref",
            )),
      )
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_inventory",
        detailSafe: "Artifact-plane coverage is incomplete or inconsistent.",
      });
    }
    const arraysAreCanonical =
      canonicalJson(decoded.vectors) ===
        canonicalJson(byRef(decoded.vectors, (item) => item.artifactRef)) &&
      canonicalJson(decoded.summaries) ===
        canonicalJson(byRef(decoded.summaries, (item) => item.artifactRef)) &&
      canonicalJson(decoded.rankingRefs) ===
        canonicalJson(byRef(decoded.rankingRefs, (item) => item.artifactRef)) &&
      Object.values(decoded.coverage).every(
        (coverage) =>
          coverage._tag === "Complete" ||
          canonicalJson(coverage.gaps) ===
            canonicalJson(byRef(coverage.gaps, (item) => canonicalJson(item))),
      );
    if (!arraysAreCanonical) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_inventory",
        detailSafe: "The artifact inventory is not in canonical order.",
      });
    }
    const allArtifacts = [...decoded.vectors, ...decoded.summaries, ...decoded.rankingRefs];
    if (new Set(allArtifacts.map((item) => item.artifactRef)).size !== allArtifacts.length) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_inventory",
        detailSafe: "The artifact inventory contains a duplicate artifact ref.",
      });
    }
    const elementRefs = new Set([
      ...built.snapshot.mentions.map((item) => item.elementRef),
      ...built.snapshot.entities.map((item) => item.elementRef),
      ...built.snapshot.relations.map((item) => item.elementRef),
    ]);
    if (allArtifacts.some((item) => !elementRefs.has(item.ownerElementRef))) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_inventory",
        detailSafe: "A declared artifact owner is not in the graph snapshot.",
      });
    }
  });

const membershipRemoval = (
  elementKind: "mention" | "entity" | "relation" | "merge",
  elementRef: GraphElementRef | GraphMergeRef,
  source: RlmSourceLocator,
): GraphSourceMembershipRemoval => {
  const value = { elementKind, elementRef, source } as const;
  return { actionRef: actionRef("membership", value), ...value };
};

const removableElement = (
  elementKind: "mention" | "entity" | "relation",
  elementRef: GraphElementRef,
): GraphRemovableElement => {
  const value = { elementKind, elementRef } as const;
  return { actionRef: actionRef("remove-element", value), ...value };
};

const mergeRefFor = (input: {
  readonly entityRef: string;
  readonly mentionRefs: ReadonlyArray<string>;
  readonly evidenceRef: string;
}): GraphMergeRef => graphMergeRef(`merge.${sha256Hex(canonicalJson(input))}`);

const unresolvedFromGap = (gap: GraphArtifactInventoryGap): GraphDeleteUnresolved => {
  const value = {
    targetKind: gap.artifactKind,
    ...(gap.ownerElementRef === undefined ? {} : { targetRef: gap.ownerElementRef }),
    reason: gap.reason,
    evidenceRef: gap.evidenceRef,
  } as const;
  return { unresolvedRef: actionRef("unresolved", value), ...value };
};

const artifactActions = (
  artifacts: ReadonlyArray<GraphVectorArtifact | GraphSummaryArtifact | GraphRankingArtifact>,
  removed: ReadonlySet<string>,
  rekeyed: ReadonlyMap<string, GraphElementRef>,
): ReadonlyArray<GraphDerivedArtifactAction> => {
  const actions: Array<GraphDerivedArtifactAction> = [];
  for (const artifact of artifacts) {
    if (removed.has(artifact.ownerElementRef)) {
      const value = {
        _tag: "Remove" as const,
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.artifactDigest,
        oldOwnerElementRef: artifact.ownerElementRef,
      };
      actions.push({ actionRef: actionRef("remove-artifact", value), ...value });
      continue;
    }
    const newOwnerElementRef = rekeyed.get(artifact.ownerElementRef);
    if (newOwnerElementRef === undefined) continue;
    const value = {
      _tag: "RekeyOwner" as const,
      artifactRef: artifact.artifactRef,
      artifactDigest: artifact.artifactDigest,
      oldOwnerElementRef: artifact.ownerElementRef,
      newOwnerElementRef,
    };
    actions.push({ actionRef: actionRef("rekey-artifact-owner", value), ...value });
  }
  return byRef(actions, (item) => item.actionRef);
};

const planContent = (plan: Omit<GraphDeletePlan, "planDigest" | "idempotencyKey">): unknown => plan;

/**
 * Plan deletion from one exact RLM source locator. The function does not delete,
 * authorize, persist, or call an adapter.
 */
export const planGraphSourceDeletion = Effect.fn("GraphCorpus.planSourceDeletion")(function* (
  built: BuiltGraphCorpus,
  source: RlmSourceLocator,
  inventory: GraphArtifactInventory,
) {
  yield* verifyBuiltGraphCorpus(built).pipe(
    Effect.mapError(
      () =>
        new GraphDeletePlanningError({
          reason: "invalid_graph",
          detailSafe: "The graph snapshot or manifest is invalid.",
        }),
    ),
  );
  yield* validateInventory(built, inventory);

  const sourceMembershipRemovals: Array<GraphSourceMembershipRemoval> = [];
  const removableElements: Array<GraphRemovableElement> = [];
  const entityRekeys: Array<GraphEntityRekeyAction> = [];
  const relationRekeys: Array<GraphRelationRekeyAction> = [];
  const removableMerges: Array<GraphRemovableMerge> = [];
  const mergeRekeys: Array<GraphMergeRekeyAction> = [];
  const unresolved: Array<GraphDeleteUnresolved> = Object.values(inventory.coverage).flatMap(
    (coverage) => (coverage._tag === "Incomplete" ? coverage.gaps.map(unresolvedFromGap) : []),
  );

  const removedMentionRefs = new Set<string>();
  const removedElementRefs = new Set<string>();
  const rekeyedElementRefs = new Map<string, GraphElementRef>();
  const entityRefMap = new Map<string, GraphEntityRef>();
  const removedEntityRefs = new Set<string>();

  for (const mention of built.snapshot.mentions) {
    if (!sameSource(mention.source, source)) continue;
    removedMentionRefs.add(mention.mentionRef);
    removedElementRefs.add(mention.elementRef);
    sourceMembershipRemovals.push(membershipRemoval("mention", mention.elementRef, source));
    removableElements.push(removableElement("mention", mention.elementRef));
  }

  for (const entity of built.snapshot.entities) {
    const retainedMentionRefs = entity.mentionRefs.filter((ref) => !removedMentionRefs.has(ref));
    const retainedMemberships = removeSource(entity.memberships, source);
    if (retainedMentionRefs.length === entity.mentionRefs.length) continue;
    sourceMembershipRemovals.push(membershipRemoval("entity", entity.elementRef, source));
    if (retainedMentionRefs.length === 0 || retainedMemberships.length === 0) {
      removedEntityRefs.add(entity.entityRef);
      removedElementRefs.add(entity.elementRef);
      removableElements.push(removableElement("entity", entity.elementRef));
      continue;
    }
    const newElementRef = deriveGraphElementRef({
      identity: entity.identity,
      memberships: retainedMemberships,
    });
    const newEntityRef = graphEntityRef(`entity.${refSuffix(newElementRef)}`);
    const value = {
      oldElementRef: entity.elementRef,
      newElementRef,
      oldEntityRef: entity.entityRef,
      newEntityRef,
      removedMentionRefs: entity.mentionRefs.filter((ref) => removedMentionRefs.has(ref)),
      retainedMentionRefs,
      retainedMemberships,
    };
    entityRekeys.push({ actionRef: actionRef("rekey-entity", value), ...value });
    rekeyedElementRefs.set(entity.elementRef, newElementRef);
    entityRefMap.set(entity.entityRef, newEntityRef);
  }

  for (const relation of built.snapshot.relations) {
    const retainedMemberships = removeSource(relation.memberships, source);
    const fromRemoved = removedEntityRefs.has(relation.fromEntityRef);
    const toRemoved = removedEntityRefs.has(relation.toEntityRef);
    const membershipChanged = retainedMemberships.length !== relation.memberships.length;
    if (membershipChanged) {
      sourceMembershipRemovals.push(membershipRemoval("relation", relation.elementRef, source));
    }
    if (membershipChanged && retainedMemberships.length === 0) {
      removedElementRefs.add(relation.elementRef);
      removableElements.push(removableElement("relation", relation.elementRef));
      continue;
    }
    if (fromRemoved || toRemoved) {
      const value = {
        targetKind: "relation" as const,
        targetRef: relation.relationRef,
        reason: "retained_relation_endpoint_removal" as const,
        evidenceRef: graphDeleteRef("graph.relation.endpoint-provenance"),
      };
      unresolved.push({ unresolvedRef: actionRef("unresolved", value), ...value });
      continue;
    }
    const newFromEntityRef = entityRefMap.get(relation.fromEntityRef) ?? relation.fromEntityRef;
    const newToEntityRef = entityRefMap.get(relation.toEntityRef) ?? relation.toEntityRef;
    if (
      !membershipChanged &&
      newFromEntityRef === relation.fromEntityRef &&
      newToEntityRef === relation.toEntityRef
    ) {
      continue;
    }
    const newElementRef = deriveGraphElementRef({
      identity: relation.identity,
      memberships: retainedMemberships,
    });
    const newRelationRef = graphRelationRef(`relation.${refSuffix(newElementRef)}`);
    const value = {
      oldElementRef: relation.elementRef,
      newElementRef,
      oldRelationRef: relation.relationRef,
      newRelationRef,
      oldFromEntityRef: relation.fromEntityRef,
      newFromEntityRef,
      oldToEntityRef: relation.toEntityRef,
      newToEntityRef,
      retainedMemberships,
    };
    relationRekeys.push({ actionRef: actionRef("rekey-relation", value), ...value });
    if (newElementRef !== relation.elementRef) {
      rekeyedElementRefs.set(relation.elementRef, newElementRef);
    }
  }

  for (const merge of built.snapshot.merges) {
    const retainedMentionRefs = merge.mentionRefs.filter((ref) => !removedMentionRefs.has(ref));
    const retainedMemberships = removeSource(merge.memberships, source);
    const newEntityRef = entityRefMap.get(merge.entityRef) ?? merge.entityRef;
    const changed =
      retainedMentionRefs.length !== merge.mentionRefs.length || newEntityRef !== merge.entityRef;
    if (!changed) continue;
    if (includesSource(merge.memberships, source)) {
      sourceMembershipRemovals.push(membershipRemoval("merge", merge.mergeRef, source));
    }
    if (removedEntityRefs.has(merge.entityRef) || retainedMentionRefs.length < 2) {
      const value = { mergeRef: merge.mergeRef };
      removableMerges.push({ actionRef: actionRef("remove-merge", value), ...value });
      continue;
    }
    const newMergeRef = mergeRefFor({
      entityRef: newEntityRef,
      mentionRefs: retainedMentionRefs,
      evidenceRef: merge.evidenceRef,
    });
    const value = {
      oldMergeRef: merge.mergeRef,
      newMergeRef,
      oldEntityRef: merge.entityRef,
      newEntityRef,
      retainedMentionRefs,
      retainedMemberships,
    };
    mergeRekeys.push({ actionRef: actionRef("rekey-merge", value), ...value });
  }

  const addRekeyCollisions = (
    targetKind: "entity" | "relation" | "merge",
    refs: ReadonlyArray<string>,
  ): void => {
    const counts = new Map<string, number>();
    for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
    for (const [targetRef, count] of counts) {
      if (count < 2) continue;
      const value = {
        targetKind,
        targetRef,
        reason: "rekey_collision" as const,
        evidenceRef: graphDeleteRef(`graph.${targetKind}.rekey-collision`),
      };
      unresolved.push({ unresolvedRef: actionRef("unresolved", value), ...value });
    }
  };
  const removedEntityElementRefs = new Set(
    removableElements
      .filter((item) => item.elementKind === "entity")
      .map((item) => item.elementRef),
  );
  const rekeyedEntityElementRefs = new Set(entityRekeys.map((item) => item.oldElementRef));
  addRekeyCollisions("entity", [
    ...built.snapshot.entities
      .filter(
        (item) =>
          !removedEntityElementRefs.has(item.elementRef) &&
          !rekeyedEntityElementRefs.has(item.elementRef),
      )
      .map((item) => item.elementRef),
    ...entityRekeys.map((item) => item.newElementRef),
  ]);
  const removedRelationElementRefs = new Set(
    removableElements
      .filter((item) => item.elementKind === "relation")
      .map((item) => item.elementRef),
  );
  const rekeyedRelationElementRefs = new Set(relationRekeys.map((item) => item.oldElementRef));
  addRekeyCollisions("relation", [
    ...built.snapshot.relations
      .filter(
        (item) =>
          !removedRelationElementRefs.has(item.elementRef) &&
          !rekeyedRelationElementRefs.has(item.elementRef),
      )
      .map((item) => item.elementRef),
    ...relationRekeys.map((item) => item.newElementRef),
  ]);
  const removedMergeRefs = new Set(removableMerges.map((item) => item.mergeRef));
  const rekeyedMergeRefs = new Set(mergeRekeys.map((item) => item.oldMergeRef));
  addRekeyCollisions("merge", [
    ...built.snapshot.merges
      .filter(
        (item) => !removedMergeRefs.has(item.mergeRef) && !rekeyedMergeRefs.has(item.mergeRef),
      )
      .map((item) => item.mergeRef),
    ...mergeRekeys.map((item) => item.newMergeRef),
  ]);

  const actions: GraphDeleteActionSet = {
    sourceMembershipRemovals: byRef(sourceMembershipRemovals, (item) => item.actionRef),
    removableElements: byRef(removableElements, (item) => item.actionRef),
    entityRekeys: byRef(entityRekeys, (item) => item.actionRef),
    relationRekeys: byRef(relationRekeys, (item) => item.actionRef),
    removableMerges: byRef(removableMerges, (item) => item.actionRef),
    mergeRekeys: byRef(mergeRekeys, (item) => item.actionRef),
    vectorActions: artifactActions(inventory.vectors, removedElementRefs, rekeyedElementRefs),
    summaryActions: artifactActions(inventory.summaries, removedElementRefs, rekeyedElementRefs),
    rankingRefActions: artifactActions(
      inventory.rankingRefs,
      removedElementRefs,
      rekeyedElementRefs,
    ),
  };
  const canonicalUnresolved = byRef(unresolved, (item) => item.unresolvedRef);
  const common = {
    schemaId: GRAPH_DELETE_PLAN_SCHEMA_ID,
    canonicalizationId: GRAPH_CANONICALIZATION_ID,
    graphRef: built.snapshot.graphRef,
    scopeRef: built.snapshot.scopeRef,
    graphDigest: built.snapshot.graphDigest,
    manifestDigest: built.manifest.manifestDigest,
    artifactInventoryDigest: inventory.inventoryDigest,
    source,
    actions,
  } as const;
  const withoutIdentity =
    canonicalUnresolved.length === 0
      ? { ...common, _tag: "Complete" as const }
      : { ...common, _tag: "Incomplete" as const, unresolved: canonicalUnresolved };
  const planDigest = digest(
    planContent(withoutIdentity as Omit<GraphDeletePlan, "planDigest" | "idempotencyKey">),
  );
  return decodePlan({
    ...withoutIdentity,
    planDigest,
    idempotencyKey: graphDeleteRef(`graph-delete.${planDigest}`),
  });
});

const allActionRefs = (actions: GraphDeleteActionSet): ReadonlyArray<GraphDeleteRef> =>
  [
    ...actions.sourceMembershipRemovals,
    ...actions.removableElements,
    ...actions.entityRekeys,
    ...actions.relationRekeys,
    ...actions.removableMerges,
    ...actions.mergeRekeys,
    ...actions.vectorActions,
    ...actions.summaryActions,
    ...actions.rankingRefActions,
  ]
    .map((item) => item.actionRef)
    .sort(compareCanonicalText);

export const graphDeleteActionRefs = (plan: GraphDeletePlan): ReadonlyArray<GraphDeleteRef> =>
  allActionRefs(plan.actions);

export const validateGraphDeletePlan = (
  plan: GraphDeletePlan,
): Effect.Effect<void, GraphDeletePlanningError> =>
  Effect.gen(function* () {
    let decoded: GraphDeletePlan;
    try {
      decoded = decodePlan(plan);
    } catch {
      return yield* new GraphDeletePlanningError({
        reason: "digest_substitution",
        detailSafe: "The delete plan does not match its schema.",
      });
    }
    if (decoded._tag === "Incomplete" && decoded.unresolved.length === 0) {
      return yield* new GraphDeletePlanningError({
        reason: "digest_substitution",
        detailSafe: "An incomplete delete plan requires an unresolved item.",
      });
    }
    const { planDigest: claimedDigest, idempotencyKey, ...withoutIdentity } = decoded;
    const expectedDigest = digest(
      planContent(withoutIdentity as Omit<GraphDeletePlan, "planDigest" | "idempotencyKey">),
    );
    if (
      expectedDigest !== claimedDigest ||
      idempotencyKey !== graphDeleteRef(`graph-delete.${expectedDigest}`) ||
      new Set(allActionRefs(decoded.actions)).size !== allActionRefs(decoded.actions).length
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "digest_substitution",
        detailSafe: "The delete plan identity does not match its content.",
      });
    }
  });

export const validateGraphDeletePlanCurrent = (
  plan: GraphDeletePlan,
  current: BuiltGraphCorpus,
): Effect.Effect<void, GraphDeletePlanningError> =>
  Effect.gen(function* () {
    yield* validateGraphDeletePlan(plan);
    yield* verifyBuiltGraphCorpus(current).pipe(
      Effect.mapError(
        () =>
          new GraphDeletePlanningError({
            reason: "invalid_graph",
            detailSafe: "The current graph snapshot or manifest is invalid.",
          }),
      ),
    );
    if (
      plan.graphRef !== current.snapshot.graphRef ||
      plan.scopeRef !== current.snapshot.scopeRef ||
      plan.graphDigest !== current.snapshot.graphDigest ||
      plan.manifestDigest !== current.manifest.manifestDigest
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "stale_plan",
        detailSafe: "The delete plan is not bound to the current graph.",
      });
    }
  });

export const requireExecutableGraphDeletePlan = (
  plan: GraphDeletePlan,
  current: BuiltGraphCorpus,
  currentInventory: GraphArtifactInventory,
): Effect.Effect<GraphCompleteDeletePlan, GraphDeletePlanningError> =>
  validateGraphDeletePlanCurrent(plan, current).pipe(
    Effect.flatMap(() => planGraphSourceDeletion(current, plan.source, currentInventory)),
    Effect.flatMap((recomputed) =>
      plan._tag !== "Complete" || recomputed._tag !== "Complete"
        ? Effect.fail(
            new GraphDeletePlanningError({
              reason: "incomplete_plan",
              detailSafe: "An incomplete delete plan cannot be executed as complete.",
            }),
          )
        : canonicalJson(recomputed) !== canonicalJson(plan)
          ? Effect.fail(
              new GraphDeletePlanningError({
                reason: "digest_substitution",
                detailSafe: "The delete plan does not match the current graph and inventory.",
              }),
            )
          : Effect.succeed(plan),
    ),
  );

const projectGraphAfter = Effect.fn("GraphCorpus.projectDeleteAfter")(function* (
  plan: GraphCompleteDeletePlan,
  before: BuiltGraphCorpus,
) {
  const removedElements = new Set(plan.actions.removableElements.map((item) => item.elementRef));
  const entityRekeys = new Map(plan.actions.entityRekeys.map((item) => [item.oldElementRef, item]));
  const relationRekeys = new Map(
    plan.actions.relationRekeys.map((item) => [item.oldElementRef, item]),
  );
  const removedMerges = new Set(plan.actions.removableMerges.map((item) => item.mergeRef));
  const mergeRekeys = new Map(plan.actions.mergeRekeys.map((item) => [item.oldMergeRef, item]));
  return yield* buildGraphCorpus({
    graphRef: before.snapshot.graphRef,
    scopeRef: before.snapshot.scopeRef,
    policy: before.snapshot.policy,
    mentions: before.snapshot.mentions.filter((item) => !removedElements.has(item.elementRef)),
    entities: before.snapshot.entities
      .filter((item) => !removedElements.has(item.elementRef))
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
      .filter((item) => !removedElements.has(item.elementRef))
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
  }).pipe(
    Effect.mapError(
      () =>
        new GraphDeletePlanningError({
          reason: "invalid_execution_result",
          detailSafe: "The planned after graph is not valid.",
        }),
    ),
  );
});

const applyArtifactActions = <
  A extends {
    readonly artifactRef: GraphDeleteRef;
    readonly ownerElementRef: GraphElementRef;
  },
>(
  artifacts: ReadonlyArray<A>,
  actions: ReadonlyArray<GraphDerivedArtifactAction>,
): ReadonlyArray<A> => {
  const byArtifact = new Map(actions.map((item) => [item.artifactRef, item]));
  return byRef(
    artifacts.flatMap((artifact) => {
      const action = byArtifact.get(artifact.artifactRef);
      if (action?._tag === "Remove") return [];
      return [
        action?._tag === "RekeyOwner"
          ? ({ ...artifact, ownerElementRef: action.newOwnerElementRef } as A)
          : artifact,
      ];
    }),
    (item) => item.artifactRef,
  );
};

const projectInventoryAfter = (
  plan: GraphCompleteDeletePlan,
  beforeInventory: GraphCompleteArtifactInventory,
  after: BuiltGraphCorpus,
): GraphCompleteArtifactInventory =>
  makeGraphArtifactInventory({
    built: after,
    vectors: applyArtifactActions(beforeInventory.vectors, plan.actions.vectorActions),
    summaries: applyArtifactActions(beforeInventory.summaries, plan.actions.summaryActions),
    rankingRefs: applyArtifactActions(beforeInventory.rankingRefs, plan.actions.rankingRefActions),
    coverage: {
      vectors: { _tag: "Complete" },
      summaries: { _tag: "Complete" },
      rankingRefs: { _tag: "Complete" },
    },
  }) as GraphCompleteArtifactInventory;

export interface GraphDeleteExecutionValidationContext {
  readonly before: BuiltGraphCorpus;
  readonly beforeInventory: GraphArtifactInventory;
  readonly after?: BuiltGraphCorpus;
  readonly afterInventory?: GraphArtifactInventory;
}

const validateExactPlan = Effect.fn("GraphCorpus.validateExactDeletePlan")(function* (
  plan: GraphDeletePlan,
  before: BuiltGraphCorpus,
  beforeInventory: GraphArtifactInventory,
) {
  yield* validateGraphDeletePlanCurrent(plan, before);
  const recomputed = yield* planGraphSourceDeletion(before, plan.source, beforeInventory);
  if (canonicalJson(recomputed) !== canonicalJson(plan)) {
    return yield* new GraphDeletePlanningError({
      reason: "digest_substitution",
      detailSafe: "The delete plan does not match the current graph and inventory.",
    });
  }
  return recomputed;
});

const validateCompleteAfter = Effect.fn("GraphCorpus.validateCompleteDeleteAfter")(function* (
  plan: GraphCompleteDeletePlan,
  context: Required<GraphDeleteExecutionValidationContext>,
) {
  if (context.beforeInventory._tag !== "Complete" || context.afterInventory._tag !== "Complete") {
    return yield* new GraphDeletePlanningError({
      reason: "invalid_execution_result",
      detailSafe: "A complete result requires complete before and after artifact inventories.",
    });
  }
  yield* verifyBuiltGraphCorpus(context.after).pipe(
    Effect.mapError(
      () =>
        new GraphDeletePlanningError({
          reason: "invalid_execution_result",
          detailSafe: "The reported after graph is invalid.",
        }),
    ),
  );
  yield* validateInventory(context.after, context.afterInventory);
  const expectedAfter = yield* projectGraphAfter(plan, context.before);
  const expectedInventory = projectInventoryAfter(plan, context.beforeInventory, expectedAfter);
  if (
    canonicalJson(expectedAfter) !== canonicalJson(context.after) ||
    canonicalJson(expectedInventory) !== canonicalJson(context.afterInventory)
  ) {
    return yield* new GraphDeletePlanningError({
      reason: "invalid_execution_result",
      detailSafe: "The reported after state does not match the complete delete plan.",
    });
  }
});

const resultContent = (result: Omit<GraphDeleteExecutionResult, "resultDigest">): unknown => result;

export const makeCompleteGraphDeleteExecutionResult = Effect.fn(
  "GraphCorpus.makeCompleteDeleteExecutionResult",
)(function* (plan: GraphDeletePlan, context: Required<GraphDeleteExecutionValidationContext>) {
  const admitted = yield* requireExecutableGraphDeletePlan(
    plan,
    context.before,
    context.beforeInventory,
  );
  yield* validateCompleteAfter(admitted, context);
  const withoutDigest = {
    schemaId: GRAPH_DELETE_EXECUTION_RESULT_SCHEMA_ID,
    _tag: "Complete" as const,
    planDigest: admitted.planDigest,
    idempotencyKey: admitted.idempotencyKey,
    graphDigestBefore: admitted.graphDigest,
    manifestDigestBefore: admitted.manifestDigest,
    artifactInventoryDigestBefore: context.beforeInventory.inventoryDigest,
    completedActionRefs: allActionRefs(admitted.actions),
    graphDigestAfter: context.after.snapshot.graphDigest,
    manifestDigestAfter: context.after.manifest.manifestDigest,
    artifactInventoryDigestAfter: context.afterInventory.inventoryDigest,
  };
  return decodeExecutionResult({
    ...withoutDigest,
    resultDigest: digest(resultContent(withoutDigest)),
  });
});

export const makeIncompleteGraphDeleteExecutionResult = Effect.fn(
  "GraphCorpus.makeIncompleteDeleteExecutionResult",
)(function* (
  plan: GraphDeletePlan,
  context: Required<GraphDeleteExecutionValidationContext>,
  completedActionRefs: ReadonlyArray<GraphDeleteRef>,
  failedActionRefs: ReadonlyArray<GraphDeleteRef>,
) {
  yield* validateExactPlan(plan, context.before, context.beforeInventory);
  yield* verifyBuiltGraphCorpus(context.after).pipe(
    Effect.mapError(
      () =>
        new GraphDeletePlanningError({
          reason: "invalid_execution_result",
          detailSafe: "The partial after graph is invalid.",
        }),
    ),
  );
  yield* validateInventory(context.after, context.afterInventory);
  const completed = [...new Set(completedActionRefs)].sort(compareCanonicalText);
  const failed = [...new Set(failedActionRefs)].sort(compareCanonicalText);
  const accounted = [...completed, ...failed].sort(compareCanonicalText);
  if (
    failed.length === 0 ||
    canonicalJson(accounted) !== canonicalJson(allActionRefs(plan.actions)) ||
    new Set(accounted).size !== accounted.length
  ) {
    return yield* new GraphDeletePlanningError({
      reason: "invalid_execution_result",
      detailSafe: "An incomplete result must account for each planned action.",
    });
  }
  const withoutDigest = {
    schemaId: GRAPH_DELETE_EXECUTION_RESULT_SCHEMA_ID,
    _tag: "Incomplete" as const,
    planDigest: plan.planDigest,
    idempotencyKey: plan.idempotencyKey,
    graphDigestBefore: plan.graphDigest,
    manifestDigestBefore: plan.manifestDigest,
    artifactInventoryDigestBefore: context.beforeInventory.inventoryDigest,
    completedActionRefs: completed,
    failedActionRefs: failed,
    graphDigestAfter: context.after.snapshot.graphDigest,
    manifestDigestAfter: context.after.manifest.manifestDigest,
    artifactInventoryDigestAfter: context.afterInventory.inventoryDigest,
  };
  return decodeExecutionResult({
    ...withoutDigest,
    resultDigest: digest(resultContent(withoutDigest)),
  });
});

export const makeFailedGraphDeleteExecutionResult = Effect.fn(
  "GraphCorpus.makeFailedDeleteExecutionResult",
)(function* (
  plan: GraphDeletePlan,
  before: BuiltGraphCorpus,
  beforeInventory: GraphArtifactInventory,
  failureRef: GraphDeleteRef,
) {
  yield* validateExactPlan(plan, before, beforeInventory);
  const withoutDigest = {
    schemaId: GRAPH_DELETE_EXECUTION_RESULT_SCHEMA_ID,
    _tag: "Failed" as const,
    planDigest: plan.planDigest,
    idempotencyKey: plan.idempotencyKey,
    graphDigestBefore: plan.graphDigest,
    manifestDigestBefore: plan.manifestDigest,
    artifactInventoryDigestBefore: beforeInventory.inventoryDigest,
    failureRef,
  };
  return decodeExecutionResult({
    ...withoutDigest,
    resultDigest: digest(resultContent(withoutDigest)),
  });
});

export const validateGraphDeleteExecutionResult = (
  plan: GraphDeletePlan,
  result: GraphDeleteExecutionResult,
  context: GraphDeleteExecutionValidationContext,
): Effect.Effect<void, GraphDeletePlanningError> =>
  Effect.gen(function* () {
    yield* validateExactPlan(plan, context.before, context.beforeInventory);
    let decoded: GraphDeleteExecutionResult;
    try {
      decoded = decodeExecutionResult(result);
    } catch {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_execution_result",
        detailSafe: "The execution result does not match its schema.",
      });
    }
    const { resultDigest: claimedDigest, ...withoutDigest } = decoded;
    if (
      decoded.planDigest !== plan.planDigest ||
      decoded.idempotencyKey !== plan.idempotencyKey ||
      decoded.graphDigestBefore !== plan.graphDigest ||
      decoded.manifestDigestBefore !== plan.manifestDigest ||
      decoded.artifactInventoryDigestBefore !== context.beforeInventory.inventoryDigest ||
      digest(resultContent(withoutDigest as Omit<GraphDeleteExecutionResult, "resultDigest">)) !==
        claimedDigest
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_execution_result",
        detailSafe: "The execution result does not match its bound plan.",
      });
    }
    if (decoded._tag === "Failed") return;
    const completed = [...decoded.completedActionRefs].sort(compareCanonicalText);
    const failed =
      decoded._tag === "Incomplete" ? [...decoded.failedActionRefs].sort(compareCanonicalText) : [];
    const accounted = [...completed, ...failed].sort(compareCanonicalText);
    if (
      canonicalJson(accounted) !== canonicalJson(allActionRefs(plan.actions)) ||
      new Set(accounted).size !== accounted.length ||
      (decoded._tag === "Incomplete" && failed.length === 0) ||
      (decoded._tag === "Complete" && plan._tag !== "Complete")
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_execution_result",
        detailSafe: "The execution result does not account for each planned action.",
      });
    }
    if (context.after === undefined || context.afterInventory === undefined) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_execution_result",
        detailSafe: "A non-failed result requires the exact after state.",
      });
    }
    if (
      decoded.graphDigestAfter !== context.after.snapshot.graphDigest ||
      decoded.manifestDigestAfter !== context.after.manifest.manifestDigest ||
      decoded.artifactInventoryDigestAfter !== context.afterInventory.inventoryDigest
    ) {
      return yield* new GraphDeletePlanningError({
        reason: "invalid_execution_result",
        detailSafe: "The result substitutes an after-state digest.",
      });
    }
    if (decoded._tag === "Complete") {
      yield* validateCompleteAfter(plan as GraphCompleteDeletePlan, {
        ...context,
        after: context.after,
        afterInventory: context.afterInventory,
      });
    } else {
      yield* verifyBuiltGraphCorpus(context.after).pipe(
        Effect.mapError(
          () =>
            new GraphDeletePlanningError({
              reason: "invalid_execution_result",
              detailSafe: "The partial after graph is invalid.",
            }),
        ),
      );
      yield* validateInventory(context.after, context.afterInventory);
    }
  });

const receiptContent = (
  receipt: Omit<GraphDeleteReceipt, "receiptDigest" | "receiptRef">,
): unknown => receipt;

export const makeGraphDeleteReceipt = Effect.fn("GraphCorpus.makeDeleteReceipt")(function* (
  plan: GraphDeletePlan,
  result: GraphDeleteExecutionResult,
  context: GraphDeleteExecutionValidationContext,
) {
  yield* validateGraphDeleteExecutionResult(plan, result, context);
  const withoutIdentity = {
    schemaId: GRAPH_DELETE_RECEIPT_SCHEMA_ID,
    _tag: result._tag,
    planDigest: plan.planDigest,
    idempotencyKey: plan.idempotencyKey,
    resultDigest: result.resultDigest,
    graphDigestBefore: result.graphDigestBefore,
    manifestDigestBefore: result.manifestDigestBefore,
    artifactInventoryDigestBefore: result.artifactInventoryDigestBefore,
    ...(result._tag === "Failed"
      ? { failureRef: result.failureRef }
      : {
          graphDigestAfter: result.graphDigestAfter,
          manifestDigestAfter: result.manifestDigestAfter,
          artifactInventoryDigestAfter: result.artifactInventoryDigestAfter,
        }),
  };
  const receiptDigest = digest(receiptContent(withoutIdentity));
  return decodeReceipt({
    ...withoutIdentity,
    receiptDigest,
    receiptRef: graphDeleteRef(`graph-delete-receipt.${receiptDigest}`),
  });
});

export const validateGraphDeleteReceipt = (
  plan: GraphDeletePlan,
  result: GraphDeleteExecutionResult,
  receipt: GraphDeleteReceipt,
  context: GraphDeleteExecutionValidationContext,
): Effect.Effect<void, GraphDeletePlanningError> =>
  validateGraphDeleteExecutionResult(plan, result, context).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        let decoded: GraphDeleteReceipt;
        try {
          decoded = decodeReceipt(receipt);
        } catch {
          return yield* new GraphDeletePlanningError({
            reason: "invalid_receipt",
            detailSafe: "The delete receipt does not match its schema.",
          });
        }
        const { receiptDigest: claimedDigest, receiptRef, ...withoutIdentity } = decoded;
        const expectedDigest = digest(receiptContent(withoutIdentity));
        const sameAfter =
          decoded._tag === "Failed" && result._tag === "Failed"
            ? decoded.failureRef === result.failureRef
            : decoded._tag !== "Failed" && result._tag !== "Failed"
              ? decoded.graphDigestAfter === result.graphDigestAfter &&
                decoded.manifestDigestAfter === result.manifestDigestAfter &&
                decoded.artifactInventoryDigestAfter === result.artifactInventoryDigestAfter
              : false;
        if (
          decoded._tag !== result._tag ||
          decoded.planDigest !== plan.planDigest ||
          decoded.idempotencyKey !== plan.idempotencyKey ||
          decoded.resultDigest !== result.resultDigest ||
          decoded.graphDigestBefore !== result.graphDigestBefore ||
          decoded.manifestDigestBefore !== result.manifestDigestBefore ||
          decoded.artifactInventoryDigestBefore !== result.artifactInventoryDigestBefore ||
          !sameAfter ||
          claimedDigest !== expectedDigest ||
          receiptRef !== graphDeleteRef(`graph-delete-receipt.${expectedDigest}`)
        ) {
          return yield* new GraphDeletePlanningError({
            reason: "invalid_receipt",
            detailSafe: "The delete receipt does not match its plan or execution result.",
          });
        }
      }),
    ),
  );
