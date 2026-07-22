import { Effect, Schema as S } from "effect";
import { GraphDerivation } from "@openagentsinc/graph-corpus";
import type {
  buildGraphCorpus,
  makeCanonicalEntity,
  makeGraphMention,
  makeGraphRelation,
  makeMergeEvidence,
  verifyBuiltGraphCorpus,
} from "@openagentsinc/graph-corpus";
import { describe, expect, test } from "vite-plus/test";

import {
  graphConformanceDerivation,
  graphConformancePolicy,
  graphConformanceSource,
} from "./graph-fixtures.ts";

export interface GraphIdentityLawsConfig {
  readonly label: string;
  readonly buildGraphCorpus: typeof buildGraphCorpus;
  readonly verifyBuiltGraphCorpus: typeof verifyBuiltGraphCorpus;
  readonly makeGraphMention: typeof makeGraphMention;
  readonly makeCanonicalEntity: typeof makeCanonicalEntity;
  readonly makeGraphRelation: typeof makeGraphRelation;
  readonly makeMergeEvidence: typeof makeMergeEvidence;
}

/** Laws for graph identity, rebuild stability, merge evidence, and provenance. */
export const runGraphIdentityLaws = (implementation: GraphIdentityLawsConfig): void => {
  const makeFixture = () => {
    const mentionA = implementation.makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "alex:a",
      identityScopeRef: "tenant.a",
      source: graphConformanceSource("a"),
      derivation: graphConformanceDerivation,
    });
    const mentionB = implementation.makeGraphMention({
      identityNamespace: "people",
      canonicalKey: "alex:b",
      identityScopeRef: "tenant.a",
      source: graphConformanceSource("b"),
      derivation: graphConformanceDerivation,
    });
    const entity = implementation.makeCanonicalEntity({
      identityNamespace: "people",
      canonicalKey: "alex",
      identityScopeRef: "tenant.a",
      mentions: [mentionA, mentionB],
      derivation: graphConformanceDerivation,
    });
    const merge = implementation.makeMergeEvidence({
      entity,
      mentions: [mentionA, mentionB],
      evidenceRef: "evidence.explicit-merge.v1",
    });
    const mentionC = implementation.makeGraphMention({
      identityNamespace: "organizations",
      canonicalKey: "openagents:c",
      identityScopeRef: "tenant.a",
      source: graphConformanceSource("c"),
      derivation: graphConformanceDerivation,
    });
    const mentionD = implementation.makeGraphMention({
      identityNamespace: "organizations",
      canonicalKey: "openagents:d",
      identityScopeRef: "tenant.a",
      source: graphConformanceSource("d"),
      derivation: graphConformanceDerivation,
    });
    const organization = implementation.makeCanonicalEntity({
      identityNamespace: "organizations",
      canonicalKey: "openagents",
      identityScopeRef: "tenant.a",
      mentions: [mentionC, mentionD],
      derivation: graphConformanceDerivation,
    });
    const relationA = implementation.makeGraphRelation({
      identityNamespace: "relations",
      canonicalKey: "alex:member",
      identityScopeRef: "tenant.a",
      relationKind: "member_of",
      from: entity,
      to: organization,
      memberships: [...entity.memberships, ...organization.memberships],
      derivation: graphConformanceDerivation,
    });
    const relationB = implementation.makeGraphRelation({
      identityNamespace: "relations",
      canonicalKey: "openagents:employs",
      identityScopeRef: "tenant.a",
      relationKind: "employs",
      from: organization,
      to: entity,
      memberships: [...organization.memberships, ...entity.memberships],
      derivation: graphConformanceDerivation,
    });
    const organizationMerge = implementation.makeMergeEvidence({
      entity: organization,
      mentions: [mentionC, mentionD],
      evidenceRef: "evidence.organization-merge.v1",
    });
    return {
      mentionA,
      mentionB,
      mentionC,
      mentionD,
      entity,
      organization,
      relationA,
      relationB,
      merge,
      organizationMerge,
    };
  };

  describe(`[${implementation.label}] graph identity and provenance`, () => {
    test("same names remain separate across namespaces and scopes", async () => {
      const make = (identityNamespace: string, identityScopeRef: string) =>
        implementation.makeGraphMention({
          identityNamespace,
          canonicalKey: "Alex",
          identityScopeRef,
          source: graphConformanceSource("same-name"),
          derivation: graphConformanceDerivation,
        });
      const mentions = [
        make("people", "tenant.a"),
        make("people", "tenant.b"),
        make("orgs", "tenant.a"),
      ];
      expect(new Set(mentions.map(({ elementRef }) => elementRef)).size).toBe(3);
      const entities = mentions.map((mention) =>
        implementation.makeCanonicalEntity({
          identityNamespace: mention.identity.identityNamespace,
          canonicalKey: "Alex",
          ...(mention.identity.identityScope._tag === "Scoped"
            ? { identityScopeRef: mention.identity.identityScope.scopeRef }
            : {}),
          mentions: [mention],
          derivation: graphConformanceDerivation,
        }),
      );
      expect(new Set(entities.map(({ elementRef }) => elementRef)).size).toBe(3);
      const built = await Effect.runPromise(
        implementation.buildGraphCorpus({
          graphRef: "graph.same-name.conformance",
          scopeRef: "tenant.a",
          policy: graphConformancePolicy,
          mentions: [mentions[0]!, mentions[2]!],
          entities: [entities[0]!, entities[2]!],
          relations: [],
          merges: [],
        }),
      );
      const otherScope = await Effect.runPromise(
        implementation.buildGraphCorpus({
          graphRef: "graph.same-name.other-scope",
          scopeRef: "tenant.b",
          policy: graphConformancePolicy,
          mentions: [mentions[1]!],
          entities: [entities[1]!],
          relations: [],
          merges: [],
        }),
      );
      expect(built.snapshot.entities).toHaveLength(2);
      expect(otherScope.snapshot.entities).toHaveLength(1);
      expect(built.snapshot.merges).toEqual([]);
    });

    test("input permutation produces the same graph and manifest", async () => {
      const value = makeFixture();
      const base = {
        graphRef: "graph.conformance",
        scopeRef: "tenant.a",
        policy: graphConformancePolicy,
        mentions: [value.mentionA, value.mentionB, value.mentionC, value.mentionD],
        entities: [value.entity, value.organization],
        relations: [value.relationA, value.relationB],
        merges: [value.merge, value.organizationMerge],
      } as const;
      const left = await Effect.runPromise(implementation.buildGraphCorpus(base));
      const right = await Effect.runPromise(
        implementation.buildGraphCorpus({
          ...base,
          mentions: [...base.mentions].reverse(),
          entities: [...base.entities].reverse(),
          relations: [...base.relations].reverse(),
          merges: [...base.merges].reverse(),
        }),
      );
      expect(right).toEqual(left);
      await expect(
        Effect.runPromise(implementation.verifyBuiltGraphCorpus(right)),
      ).resolves.toBeUndefined();
    });

    test("merge evidence is explicit and provenance contains no source text", async () => {
      const value = makeFixture();
      const built = await Effect.runPromise(
        implementation.buildGraphCorpus({
          graphRef: "graph.merge.conformance",
          scopeRef: "tenant.a",
          policy: graphConformancePolicy,
          mentions: [value.mentionB, value.mentionA],
          entities: [value.entity],
          relations: [],
          merges: [value.merge],
        }),
      );
      expect(built.snapshot.merges).toHaveLength(1);
      expect(built.snapshot.merges[0]?.evidenceRef).toBe("evidence.explicit-merge.v1");
      expect(
        built.snapshot.mentions.every((item) => item.derivation._tag === "Deterministic"),
      ).toBe(true);

      const corrupt = structuredClone(built);
      Object.defineProperty(corrupt.snapshot.mentions[0]!, "elementRef", {
        value: "graph.mention.corrupt",
      });
      const error = await Effect.runPromise(
        implementation.verifyBuiltGraphCorpus(corrupt).pipe(Effect.flip),
      );
      expect(error.reason).toBe("invalid_graph");
    });

    test("model provenance is retained and changes graph identity", async () => {
      const value = makeFixture();
      const makeModelMention = (extractionInputDigest: string) =>
        implementation.makeGraphMention({
          identityNamespace: "people",
          canonicalKey: "model:alex",
          identityScopeRef: "tenant.a",
          source: graphConformanceSource("model"),
          derivation: S.decodeUnknownSync(GraphDerivation)({
            _tag: "Model",
            extractorKind: "entity_relation",
            dseSignatureRef: "GraphCorpus/EntityRelationExtraction.v1",
            compiledProgramDigest: "b".repeat(64),
            extractionInputDigest,
            decodeOutcome: "decoded",
            usageReceiptRef: "usage.conformance",
          }),
        });
      const build = (mention: ReturnType<typeof makeModelMention>) =>
        Effect.runPromise(
          implementation.buildGraphCorpus({
            graphRef: "graph.model-provenance",
            scopeRef: "tenant.a",
            policy: graphConformancePolicy,
            mentions: [value.mentionA, value.mentionB, mention],
            entities: [value.entity],
            relations: [],
            merges: [value.merge],
          }),
        );
      const left = await build(makeModelMention("c".repeat(64)));
      const right = await build(makeModelMention("d".repeat(64)));
      expect(
        left.snapshot.mentions.find(({ derivation }) => derivation._tag === "Model")?.derivation,
      ).toMatchObject({ usageReceiptRef: "usage.conformance", decodeOutcome: "decoded" });
      expect(right.snapshot.graphDigest).not.toBe(left.snapshot.graphDigest);
    });
  });
};
