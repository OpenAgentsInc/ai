import { Effect, Schema as S } from "effect";
import { buildInlineCorpusInput, makeInlineCorpusHandle } from "@openagentsinc/rlm";
import {
  GraphDeleteRef,
  type buildGraphCorpus,
  type makeCanonicalEntity,
  type makeGraphAdapterCapabilities,
  type makeGraphMention,
  type makeEmbeddingProjectionDescriptor,
  type makeGraphRlmClassificationProjection,
  type makeGraphRlmProjection,
  type makeInMemoryGraphSnapshotHandle,
} from "@openagentsinc/graph-corpus";
import {
  GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
  GraphRankingOperationBinding,
  type GraphRankingConfidence,
  type makeGraphRankingSnapshot,
  type makeGraphFeedbackObservation,
  type rankGraphOperationResult,
  type validateGraphUsedElementEvidence,
  type validateGraphRankingSnapshot,
} from "@openagentsinc/graph-corpus/ranking";
import { describe, expect, test } from "vite-plus/test";

import { graphConformanceDerivation, graphConformancePolicy } from "./graph-fixtures.ts";

export interface GraphRankingLawsConfig {
  readonly label: string;
  readonly buildGraphCorpus: typeof buildGraphCorpus;
  readonly makeGraphMention: typeof makeGraphMention;
  readonly makeCanonicalEntity: typeof makeCanonicalEntity;
  readonly makeEmbeddingProjectionDescriptor: typeof makeEmbeddingProjectionDescriptor;
  readonly makeInMemoryGraphSnapshotHandle: typeof makeInMemoryGraphSnapshotHandle;
  readonly makeGraphRlmClassificationProjection: typeof makeGraphRlmClassificationProjection;
  readonly makeGraphAdapterCapabilities: typeof makeGraphAdapterCapabilities;
  readonly makeGraphRlmProjection: typeof makeGraphRlmProjection;
  readonly makeGraphRankingSnapshot: typeof makeGraphRankingSnapshot;
  readonly makeGraphFeedbackObservation: typeof makeGraphFeedbackObservation;
  readonly validateGraphRankingSnapshot: typeof validateGraphRankingSnapshot;
  readonly rankGraphOperationResult: typeof rankGraphOperationResult;
  readonly validateGraphUsedElementEvidence: typeof validateGraphUsedElementEvidence;
}

/** Laws for deterministic ranking that cannot mutate graph identity. */
export const runGraphRankingLaws = (implementation: GraphRankingLawsConfig): void => {
  const fixture = async () => {
    const original = await Effect.runPromise(
      makeInlineCorpusHandle(
        buildInlineCorpusInput({
          corpusRef: "corpus.ranking.conformance",
          scopeRef: "tenant.a",
          policy: graphConformancePolicy,
          entries: ["a", "b"].map((entryRef) => ({
            entryRef,
            scopeRef: "tenant.a",
            sourcePlane: "repository" as const,
            sourceKind: "conformance_fixture",
            sourceAddress: {
              addressSchemaId: "conformance.path.v1",
              encodedAddress: `fixture:${entryRef}`,
            },
            text: `source ${entryRef}`,
            visibility: "private" as const,
            redactionClass: "none" as const,
          })),
        }),
      ),
    );
    const sources = await Promise.all(
      ["a", "b"].map((entryRef) =>
        Effect.runPromise(
          original
            .validateSourceAddress({
              addressSchemaId: "conformance.path.v1",
              encodedAddress: `fixture:${entryRef}`,
            })
            .pipe(Effect.map(({ origin }) => origin)),
        ),
      ),
    );
    const mentions = sources.map((source, index) =>
      implementation.makeGraphMention({
        identityNamespace: "people",
        canonicalKey: `alex:${index}`,
        identityScopeRef: "tenant.a",
        source,
        derivation: graphConformanceDerivation,
      }),
    );
    const entity = implementation.makeCanonicalEntity({
      identityNamespace: "people",
      canonicalKey: "alex",
      identityScopeRef: "tenant.a",
      mentions,
      derivation: graphConformanceDerivation,
    });
    const descriptor = implementation.makeEmbeddingProjectionDescriptor({
      projectionSchemaId: "graph.embedding.conformance.v1",
      elementKinds: ["mention", "entity"],
      embeddableFields: ["identity.canonicalKey"],
      dimensions: 2,
    });
    const built = await Effect.runPromise(
      implementation.buildGraphCorpus({
        graphRef: "graph.ranking.conformance",
        scopeRef: "tenant.a",
        policy: graphConformancePolicy,
        mentions,
        entities: [entity],
        relations: [],
        embeddingProjections: [descriptor],
      }),
    );
    const handle = await Effect.runPromise(implementation.makeInMemoryGraphSnapshotHandle(built));
    const classification = implementation.makeGraphRlmClassificationProjection(
      handle,
      [...mentions, entity].map(({ elementRef }) => ({
        elementRef,
        visibility: "private" as const,
        redactionClass: "none" as const,
      })),
      [original],
    );
    const projection = await Effect.runPromise(
      implementation.makeGraphRlmProjection({
        handle,
        capabilities: implementation.makeGraphAdapterCapabilities([
          "graph_read",
          "rlm_v2_projection",
        ]),
        classification,
        corpusRef: "rlm.ranking.conformance",
        supportingCorpora: [original],
      }),
    );
    const limits = {
      maxDepth: 2,
      maxVisitedElements: 10,
      maxReturnedElements: 10,
      maxSourceAddresses: 10,
      maxCharactersPerResult: 2_048,
      maxObservationCharacters: 10_000,
    };
    const result = await Effect.runPromise(
      projection.operators.neighbors(entity.elementRef, limits),
    );
    if (result._tag !== "Complete")
      throw new Error("The ranking conformance fixture must complete.");
    const binding = S.decodeUnknownSync(GraphRankingOperationBinding)({
      schemaId: GRAPH_RANKING_OPERATION_BINDING_SCHEMA_ID,
      _tag: "Neighbors",
      elementRef: entity.elementRef,
    });
    return { built, projection, result, binding, mentions, entity, descriptor, limits };
  };

  const confidence = (
    value: Awaited<ReturnType<typeof fixture>>,
    elementRef: GraphRankingConfidence["elementRef"],
    confidenceMicros: number,
  ): GraphRankingConfidence => ({
    graphRef: value.built.snapshot.graphRef,
    scopeRef: value.built.snapshot.scopeRef,
    graphDigest: value.result.graphDigest,
    manifestDigest: value.result.manifestDigest,
    corpusRef: value.result.corpusRef,
    contentDigest: value.result.contentDigest,
    corpusManifestDigest: value.result.corpusManifestDigest,
    classificationDigest: value.result.classificationDigest,
    elementRef,
    confidenceMicros,
    evidenceRef: S.decodeUnknownSync(GraphDeleteRef)(`evidence.${elementRef}`),
  });

  describe(`[${implementation.label}] graph ranking`, () => {
    test("equal graph and ranking inputs produce deterministic order and evidence", async () => {
      const value = await fixture();
      const context = {
        built: value.built,
        projection: value.projection,
        result: value.result,
        expectedOperationDigest: value.result.operationDigest,
        binding: value.binding,
      };
      const inputs = {
        ...context,
        confidences: [
          confidence(value, value.mentions[0]!.elementRef, 900_000),
          confidence(value, value.mentions[1]!.elementRef, 100_000),
        ],
      };
      const left = await Effect.runPromise(implementation.makeGraphRankingSnapshot(inputs));
      const right = await Effect.runPromise(implementation.makeGraphRankingSnapshot(inputs));
      expect(right).toEqual(left);
      const ranked = await Effect.runPromise(
        implementation.rankGraphOperationResult({ ...context, snapshot: left }),
      );
      expect(ranked._tag).toBe("Ranked");
      expect(ranked.evidence.rankingSnapshotDigest).toBe(left.snapshotDigest);
      expect(ranked.observations[0]?.elementRef).toBe(value.mentions[0]?.elementRef);
    });

    test("ranking-only changes leave graph and manifest bytes unchanged", async () => {
      const value = await fixture();
      const graphBefore = structuredClone(value.built);
      const resultBefore = structuredClone(value.result);
      const context = {
        built: value.built,
        projection: value.projection,
        result: value.result,
        expectedOperationDigest: value.result.operationDigest,
        binding: value.binding,
      };
      const highA = await Effect.runPromise(
        implementation.makeGraphRankingSnapshot({
          ...context,
          confidences: [confidence(value, value.mentions[0]!.elementRef, 900_000)],
        }),
      );
      const highB = await Effect.runPromise(
        implementation.makeGraphRankingSnapshot({
          ...context,
          confidences: [confidence(value, value.mentions[1]!.elementRef, 900_000)],
        }),
      );
      expect(highB.snapshotDigest).not.toBe(highA.snapshotDigest);
      const rankedA = await Effect.runPromise(
        implementation.rankGraphOperationResult({ ...context, snapshot: highA }),
      );
      const rankedB = await Effect.runPromise(
        implementation.rankGraphOperationResult({ ...context, snapshot: highB }),
      );
      expect(rankedA.observations.map(({ elementRef }) => elementRef)).not.toEqual(
        rankedB.observations.map(({ elementRef }) => elementRef),
      );
      expect(value.built).toEqual(graphBefore);
      expect(value.built.snapshot.graphDigest).toBe(graphBefore.snapshot.graphDigest);
      expect(value.built.manifest.manifestDigest).toBe(graphBefore.manifest.manifestDigest);
      expect(value.built.snapshot.embeddingProjections).toEqual([value.descriptor]);
      expect(value.result).toEqual(resultBefore);
    });

    test("disabled and truncated ranking is explicit and never drops observations", async () => {
      const value = await fixture();
      const context = {
        built: value.built,
        projection: value.projection,
        result: value.result,
        expectedOperationDigest: value.result.operationDigest,
        binding: value.binding,
      };
      const unranked = await Effect.runPromise(implementation.rankGraphOperationResult(context));
      expect(unranked).toMatchObject({ _tag: "Unranked", disabledReason: "ranking_disabled" });
      expect(unranked.observations).toEqual(value.result.observations);
      const truncated = await Effect.runPromise(
        value.projection.operators.neighbors(value.entity.elementRef, {
          ...value.limits,
          maxReturnedElements: 1,
        }),
      );
      expect(truncated._tag).toBe("Truncated");
      const truncatedOutcome = await Effect.runPromise(
        implementation.rankGraphOperationResult({
          ...context,
          result: truncated,
          expectedOperationDigest: truncated.operationDigest,
        }),
      );
      expect(truncatedOutcome).toMatchObject({
        _tag: "Unranked",
        disabledReason: "operation_truncated",
      });
      expect(truncatedOutcome.observations).toEqual(truncated.observations);
    });

    test("missing features degrade without dropping data and evidence substitution fails", async () => {
      const value = await fixture();
      const context = {
        built: value.built,
        projection: value.projection,
        result: value.result,
        expectedOperationDigest: value.result.operationDigest,
        binding: value.binding,
      };
      const snapshot = await Effect.runPromise(
        implementation.makeGraphRankingSnapshot({
          ...context,
          confidences: [confidence(value, value.mentions[0]!.elementRef, 900_000)],
        }),
      );
      const outcome = await Effect.runPromise(
        implementation.rankGraphOperationResult({ ...context, snapshot }),
      );
      expect(outcome.observations).toHaveLength(value.result.observations.length);
      expect(outcome.missingFeatureElementRefs.length).toBeGreaterThan(0);
      const changed = {
        ...outcome.evidence,
        evidenceDigest: "f".repeat(64),
      } as typeof outcome.evidence;
      const error = await Effect.runPromise(
        implementation
          .validateGraphUsedElementEvidence(changed, { ...context, snapshot })
          .pipe(Effect.flip),
      );
      expect(error).toMatchObject({
        _tag: "GraphCorpus.RankingError",
        reason: "invalid_evidence",
      });
    });

    test("feedback for an unknown element is rejected exactly", async () => {
      const value = await fixture();
      const error = await Effect.runPromise(
        implementation
          .makeGraphFeedbackObservation({
            built: value.built,
            projection: value.projection,
            result: value.result,
            expectedOperationDigest: value.result.operationDigest,
            binding: value.binding,
            elementRef: "graph.element.unknown",
            feedbackWeightMicros: 1,
            evidenceRef: "evidence.unknown",
          })
          .pipe(Effect.flip),
      );
      expect(error).toMatchObject({
        _tag: "GraphCorpus.RankingError",
        reason: "unknown_element",
      });
    });

    test("a snapshot bound to another graph fails with stale_graph", async () => {
      const value = await fixture();
      const context = {
        built: value.built,
        projection: value.projection,
        result: value.result,
        expectedOperationDigest: value.result.operationDigest,
        binding: value.binding,
      };
      const snapshot = await Effect.runPromise(implementation.makeGraphRankingSnapshot(context));
      const changed = await Effect.runPromise(
        implementation.buildGraphCorpus({
          graphRef: "graph.ranking.other",
          scopeRef: value.built.snapshot.scopeRef,
          policy: value.built.snapshot.policy,
          mentions: value.built.snapshot.mentions,
          entities: value.built.snapshot.entities,
          relations: value.built.snapshot.relations,
        }),
      );
      const error = await Effect.runPromise(
        implementation
          .validateGraphRankingSnapshot(snapshot, { ...context, built: changed })
          .pipe(Effect.flip),
      );
      expect(error.reason).toBe("stale_graph");
    });
  });
};
