import { Effect, Schema as S } from "effect";
import {
  GraphDeleteRef,
  GraphRankingArtifact,
  GraphSummaryArtifact,
  GraphVectorArtifact,
} from "@openagentsinc/graph-corpus";
import type {
  buildGraphCorpus,
  makeCanonicalEntity,
  makeGraphAdapterCapabilities,
  makeGraphArtifactInventory,
  makeGraphMention,
  makeCompleteGraphDeleteExecutionResult,
  validateGraphDeleteExecutionResult,
  makeGraphDeleteReceipt,
  validateGraphDeleteReceipt,
  planGraphSourceDeletion,
  requireExecutableGraphDeletePlan,
  requireGraphAdapterCapability,
  GraphAdapterCapability,
} from "@openagentsinc/graph-corpus";
import { describe, expect, test } from "vite-plus/test";

import {
  graphConformanceDerivation,
  graphConformancePolicy,
  graphConformanceSource,
} from "./graph-fixtures.ts";

export interface GraphCapabilityDeleteLawsConfig {
  readonly label: string;
  readonly buildGraphCorpus: typeof buildGraphCorpus;
  readonly makeGraphMention: typeof makeGraphMention;
  readonly makeCanonicalEntity: typeof makeCanonicalEntity;
  readonly makeGraphAdapterCapabilities: typeof makeGraphAdapterCapabilities;
  readonly requireGraphAdapterCapability: typeof requireGraphAdapterCapability;
  readonly makeGraphArtifactInventory: typeof makeGraphArtifactInventory;
  readonly planGraphSourceDeletion: typeof planGraphSourceDeletion;
  readonly requireExecutableGraphDeletePlan: typeof requireExecutableGraphDeletePlan;
  readonly makeCompleteGraphDeleteExecutionResult: typeof makeCompleteGraphDeleteExecutionResult;
  readonly validateGraphDeleteExecutionResult: typeof validateGraphDeleteExecutionResult;
  readonly makeGraphDeleteReceipt: typeof makeGraphDeleteReceipt;
  readonly validateGraphDeleteReceipt: typeof validateGraphDeleteReceipt;
}

const capabilities: ReadonlyArray<GraphAdapterCapability> = [
  "graph_read",
  "rlm_v2_projection",
  "vector_read",
  "hybrid_query",
  "atomic_graph_vector_projection",
  "provenance_delete_planning",
  "snapshot_export",
];

/** Laws for explicit adapter capability refusal and source-outward delete plans. */
export const runGraphCapabilityDeleteLaws = (
  implementation: GraphCapabilityDeleteLawsConfig,
): void => {
  const fixture = async () => {
    const sourceA = graphConformanceSource("a");
    const sourceB = graphConformanceSource("b");
    const mentionA = implementation.makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "alex:a",
      identityScopeRef: "tenant.a",
      source: sourceA,
      derivation: graphConformanceDerivation,
    });
    const mentionB = implementation.makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "alex:b",
      identityScopeRef: "tenant.a",
      source: sourceB,
      derivation: graphConformanceDerivation,
    });
    const entity = implementation.makeCanonicalEntity({
      identityNamespace: "people",
      canonicalKey: "alex",
      identityScopeRef: "tenant.a",
      mentions: [mentionA, mentionB],
      derivation: graphConformanceDerivation,
    });
    const built = await Effect.runPromise(
      implementation.buildGraphCorpus({
        graphRef: "graph.delete.conformance",
        scopeRef: "tenant.a",
        policy: graphConformancePolicy,
        mentions: [mentionA, mentionB],
        entities: [entity],
        relations: [],
      }),
    );
    return { built, sourceA, mentionA, entity };
  };

  describe(`[${implementation.label}] graph capabilities and deletion`, () => {
    test("every undeclared capability fails with its exact typed name", async () => {
      const none = implementation.makeGraphAdapterCapabilities([]);
      for (const capability of capabilities) {
        const error = await Effect.runPromise(
          implementation.requireGraphAdapterCapability(none, capability).pipe(Effect.flip),
        );
        expect(error).toMatchObject({
          _tag: "GraphCorpus.AdapterCapabilityError",
          reason: "unsupported_operation",
          capability,
        });
      }
      const declared = implementation.makeGraphAdapterCapabilities(["graph_read"]);
      await expect(
        Effect.runPromise(implementation.requireGraphAdapterCapability(declared, "graph_read")),
      ).resolves.toBeUndefined();
    });

    test("shared-source deletion retains and rekeys the shared entity", async () => {
      const { built, sourceA, mentionA, entity } = await fixture();
      const vectorRemove = S.decodeUnknownSync(GraphVectorArtifact)({
        artifactKind: "vector",
        artifactRef: "vector.mention-a",
        artifactDigest: "1".repeat(64),
        ownerElementRef: mentionA.elementRef,
      });
      const vectorRebuild = S.decodeUnknownSync(GraphVectorArtifact)({
        artifactKind: "vector",
        artifactRef: "vector.entity",
        artifactDigest: "2".repeat(64),
        ownerElementRef: entity.elementRef,
      });
      const summary = S.decodeUnknownSync(GraphSummaryArtifact)({
        artifactKind: "summary",
        artifactRef: "summary.entity",
        artifactDigest: "3".repeat(64),
        ownerElementRef: entity.elementRef,
      });
      const ranking = S.decodeUnknownSync(GraphRankingArtifact)({
        artifactKind: "ranking_ref",
        artifactRef: "ranking.entity",
        artifactDigest: "4".repeat(64),
        ownerElementRef: entity.elementRef,
      });
      const inventory = implementation.makeGraphArtifactInventory({
        built,
        vectors: [vectorRemove, vectorRebuild],
        summaries: [summary],
        rankingRefs: [ranking],
        coverage: {
          vectors: { _tag: "Complete" },
          summaries: { _tag: "Complete" },
          rankingRefs: { _tag: "Complete" },
        },
      });
      const plan = await Effect.runPromise(
        implementation.planGraphSourceDeletion(built, sourceA, inventory),
      );
      expect(plan._tag).toBe("Complete");
      expect(plan.actions.removableElements.map(({ elementKind }) => elementKind)).toEqual([
        "mention",
      ]);
      expect(plan.actions.entityRekeys).toHaveLength(1);
      expect(plan.actions.entityRekeys[0]?.retainedMentionRefs).toHaveLength(1);
      expect(plan.actions.vectorActions.map(({ _tag }) => _tag).sort()).toEqual([
        "RebuildRequired",
        "Remove",
      ]);
      expect(plan.actions.summaryActions.map(({ _tag }) => _tag)).toEqual(["RebuildRequired"]);
      expect(plan.actions.rankingRefActions.map(({ _tag }) => _tag)).toEqual(["RebuildRequired"]);
      await expect(
        Effect.runPromise(implementation.requireExecutableGraphDeletePlan(plan, built, inventory)),
      ).resolves.toEqual(plan);
      if (plan._tag !== "Complete")
        throw new Error("The complete inventory must produce a complete plan.");
      const rekey = plan.actions.entityRekeys[0]!;
      const retainedMention = built.snapshot.mentions.find(
        ({ elementRef }) => elementRef !== mentionA.elementRef,
      )!;
      const after = await Effect.runPromise(
        implementation.buildGraphCorpus({
          graphRef: built.snapshot.graphRef,
          scopeRef: built.snapshot.scopeRef,
          policy: built.snapshot.policy,
          mentions: [retainedMention],
          entities: [
            {
              ...entity,
              elementRef: rekey.newElementRef,
              entityRef: rekey.newEntityRef,
              mentionRefs: rekey.retainedMentionRefs,
              memberships: rekey.retainedMemberships,
            },
          ],
          relations: [],
        }),
      );
      const afterInventory = implementation.makeGraphArtifactInventory({
        built: after,
        vectors: [],
        summaries: [],
        rankingRefs: [],
        coverage: {
          vectors: { _tag: "Complete" },
          summaries: { _tag: "Complete" },
          rankingRefs: { _tag: "Complete" },
        },
      });
      const execution = await Effect.runPromise(
        implementation.makeCompleteGraphDeleteExecutionResult(plan, {
          before: built,
          beforeInventory: inventory,
          after,
          afterInventory,
        }),
      );
      await expect(
        Effect.runPromise(
          implementation.validateGraphDeleteExecutionResult(plan, execution, {
            before: built,
            beforeInventory: inventory,
            after,
            afterInventory,
          }),
        ),
      ).resolves.toBeUndefined();
      const receipt = await Effect.runPromise(
        implementation.makeGraphDeleteReceipt(plan, execution, {
          before: built,
          beforeInventory: inventory,
          after,
          afterInventory,
        }),
      );
      await expect(
        Effect.runPromise(
          implementation.validateGraphDeleteReceipt(plan, execution, receipt, {
            before: built,
            beforeInventory: inventory,
            after,
            afterInventory,
          }),
        ),
      ).resolves.toBeUndefined();
      expect(
        after.snapshot.mentions.some(({ elementRef }) => elementRef === mentionA.elementRef),
      ).toBe(false);
      expect(afterInventory.vectors).toEqual([]);
      expect(afterInventory.summaries).toEqual([]);
      expect(afterInventory.rankingRefs).toEqual([]);
    });

    test("an incomplete artifact inventory cannot become executable", async () => {
      const { built, sourceA } = await fixture();
      for (const artifactKind of ["vector", "summary", "ranking_ref"] as const) {
        const incomplete = {
          _tag: "Incomplete" as const,
          gaps: [
            {
              artifactKind,
              reason: "adapter_unavailable" as const,
              evidenceRef: S.decodeUnknownSync(GraphDeleteRef)(`fixture.gap.${artifactKind}`),
            },
          ],
        };
        const inventory = implementation.makeGraphArtifactInventory({
          built,
          vectors: [],
          summaries: [],
          rankingRefs: [],
          coverage: {
            vectors: artifactKind === "vector" ? incomplete : { _tag: "Complete" },
            summaries: artifactKind === "summary" ? incomplete : { _tag: "Complete" },
            rankingRefs: artifactKind === "ranking_ref" ? incomplete : { _tag: "Complete" },
          },
        });
        const plan = await Effect.runPromise(
          implementation.planGraphSourceDeletion(built, sourceA, inventory),
        );
        expect(plan._tag).toBe("Incomplete");
        const error = await Effect.runPromise(
          implementation.requireExecutableGraphDeletePlan(plan, built, inventory).pipe(Effect.flip),
        );
        expect(error).toMatchObject({
          _tag: "GraphCorpus.DeletePlanningError",
          reason: "incomplete_plan",
        });
      }
    });
  });
};
