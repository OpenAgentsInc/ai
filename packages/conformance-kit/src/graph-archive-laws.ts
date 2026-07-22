import { createHash } from "node:crypto";
import { Effect, Schema as S } from "effect";
import {
  GraphArchiveRef,
  type GraphCorpusArchive,
  type encodeGraphCorpusArchive,
  type exportGraphCorpusArchive,
  type importGraphCorpusArchive,
} from "@openagentsinc/graph-corpus/archive";
import {
  canonicalJson,
  GraphSummaryArtifact,
  graphDigest,
  sha256Hex,
  type GraphDigest,
  buildGraphCorpus,
  makeGraphAdapterCapabilities,
  makeGraphArtifactInventory,
  makeGraphMention,
} from "@openagentsinc/graph-corpus";
import {
  GRAPH_RANKING_ALGORITHM_VERSION,
  GRAPH_RANKING_SNAPSHOT_SCHEMA_ID,
  GraphRankingSnapshot,
} from "@openagentsinc/graph-corpus/ranking";
import { describe, expect, test } from "vite-plus/test";

import {
  graphArchiveCorruptionFixtures,
  graphConformanceDerivation,
  graphConformancePolicy,
  graphConformanceSource,
} from "./graph-fixtures.ts";

export interface GraphArchiveLawsConfig {
  readonly label: string;
  readonly buildGraphCorpus: typeof buildGraphCorpus;
  readonly makeGraphMention: typeof makeGraphMention;
  readonly makeGraphAdapterCapabilities: typeof makeGraphAdapterCapabilities;
  readonly makeGraphArtifactInventory: typeof makeGraphArtifactInventory;
  readonly exportGraphCorpusArchive: typeof exportGraphCorpusArchive;
  readonly encodeGraphCorpusArchive: typeof encodeGraphCorpusArchive;
  readonly importGraphCorpusArchive: typeof importGraphCorpusArchive;
}

type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends ReadonlyArray<infer U>
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
const digest = (value: unknown): GraphDigest => graphDigest(sha256Hex(canonicalJson(value)));
const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJson(value));
const payloadDigest = (bytes: Uint8Array): GraphDigest =>
  graphDigest(createHash("sha256").update(bytes).digest("hex"));
const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(""));
const rehash = (value: GraphCorpusArchive | Mutable<GraphCorpusArchive>): GraphCorpusArchive => {
  const archive = structuredClone(value) as unknown as Mutable<GraphCorpusArchive>;
  const update = (section: { sectionDigest: GraphDigest; [key: string]: unknown }) => {
    const { sectionDigest: _old, ...content } = section;
    section.sectionDigest = digest(content);
  };
  update(archive.sections.graph);
  update(archive.sections.nodes);
  update(archive.sections.edges);
  update(archive.sections.sourceMemberships);
  update(archive.sections.mergeEvidence);
  update(archive.sections.provenance);
  update(archive.sections.descriptors);
  if (archive.sections.vectors !== undefined) update(archive.sections.vectors);
  if (archive.sections.summaries !== undefined) update(archive.sections.summaries);
  if (archive.sections.ranking !== undefined) update(archive.sections.ranking);
  if (archive.sections.contentExtension !== undefined) update(archive.sections.contentExtension);
  archive.manifest.sectionDigests = {
    graph: archive.sections.graph.sectionDigest,
    nodes: archive.sections.nodes.sectionDigest,
    edges: archive.sections.edges.sectionDigest,
    sourceMemberships: archive.sections.sourceMemberships.sectionDigest,
    mergeEvidence: archive.sections.mergeEvidence.sectionDigest,
    provenance: archive.sections.provenance.sectionDigest,
    descriptors: archive.sections.descriptors.sectionDigest,
    ...(archive.sections.vectors === undefined
      ? {}
      : { vectors: archive.sections.vectors.sectionDigest }),
    ...(archive.sections.summaries === undefined
      ? {}
      : { summaries: archive.sections.summaries.sectionDigest }),
    ...(archive.sections.ranking === undefined
      ? {}
      : { ranking: archive.sections.ranking.sectionDigest }),
    ...(archive.sections.contentExtension === undefined
      ? {}
      : { contentExtension: archive.sections.contentExtension.sectionDigest }),
  };
  archive.manifest.contentDigest = digest(archive.sections);
  const {
    manifestDigest: _manifestDigest,
    archiveRef: _archiveRef,
    ...manifestContent
  } = archive.manifest;
  archive.manifest.manifestDigest = digest(manifestContent);
  archive.manifest.archiveRef = S.decodeUnknownSync(GraphArchiveRef)(
    `archive.${sha256Hex(canonicalJson({ contentDigest: archive.manifest.contentDigest, manifestDigest: archive.manifest.manifestDigest }))}`,
  );
  return archive as unknown as GraphCorpusArchive;
};

/** Laws for canonical graph archive round trips and semantic corruption refusal. */
export const runGraphArchiveLaws = (implementation: GraphArchiveLawsConfig): void => {
  const fixture = async () => {
    const mention = implementation.makeGraphMention({
      identityNamespace: "archive",
      canonicalKey: "alex",
      identityScopeRef: "tenant.a",
      source: graphConformanceSource("archive"),
      derivation: graphConformanceDerivation,
    });
    const built = await Effect.runPromise(
      implementation.buildGraphCorpus({
        graphRef: "graph.archive.conformance",
        scopeRef: "tenant.a",
        policy: graphConformancePolicy,
        mentions: [mention],
        entities: [],
        relations: [],
      }),
    );
    const summaryBytes = new TextEncoder().encode("public conformance summary");
    const summary = S.decodeUnknownSync(GraphSummaryArtifact)({
      artifactKind: "summary",
      artifactRef: "summary.conformance",
      artifactDigest: payloadDigest(summaryBytes),
      ownerElementRef: mention.elementRef,
    });
    const inventory = implementation.makeGraphArtifactInventory({
      built,
      vectors: [],
      summaries: [summary],
      rankingRefs: [],
      coverage: {
        vectors: { _tag: "Complete" },
        summaries: { _tag: "Complete" },
        rankingRefs: { _tag: "Complete" },
      },
    });
    const rankingContent = {
      schemaId: GRAPH_RANKING_SNAPSHOT_SCHEMA_ID,
      graphRef: built.snapshot.graphRef,
      scopeRef: built.snapshot.scopeRef,
      graphDigest: built.snapshot.graphDigest,
      manifestDigest: built.manifest.manifestDigest,
      corpusRef: "corpus.archive.conformance",
      contentDigest: "c".repeat(64),
      corpusManifestDigest: "d".repeat(64),
      classificationDigest: "e".repeat(64),
      algorithmVersion: GRAPH_RANKING_ALGORITHM_VERSION,
      feedbackObservations: [],
      confidences: [],
      features: [],
    } as const;
    const ranking = S.decodeUnknownSync(GraphRankingSnapshot)({
      ...rankingContent,
      snapshotRef: `ranking-snapshot.${sha256Hex(canonicalJson(rankingContent))}`,
      snapshotDigest: digest(rankingContent),
    });
    return { built, inventory, ranking, summary, summaryBytes };
  };

  describe(`[${implementation.label}] graph archive`, () => {
    test("graph, provenance, inventory, and ranking round-trip in stable inert bytes", async () => {
      const value = await fixture();
      const capabilities = implementation.makeGraphAdapterCapabilities(["snapshot_export"]);
      const input = {
        built: value.built,
        capabilities,
        artifactInventory: value.inventory,
        summaryRecords: [
          {
            artifact: value.summary,
            summarySchemaId: "summary.conformance.v1",
            encoding: "utf8-base64" as const,
            payloadBase64: base64(value.summaryBytes),
            payloadDigest: payloadDigest(value.summaryBytes),
            visibility: "private" as const,
            redactionClass: "none" as const,
          },
        ],
        rankingSnapshots: [value.ranking],
      };
      const left = await Effect.runPromise(implementation.encodeGraphCorpusArchive(input));
      const right = await Effect.runPromise(implementation.encodeGraphCorpusArchive(input));
      expect(right).toEqual(left);
      const imported = await Effect.runPromise(implementation.importGraphCorpusArchive(left));
      expect(imported.built).toEqual(value.built);
      expect(imported.artifactInventory).toEqual(value.inventory);
      expect(imported.rankingSnapshots).toEqual([value.ranking]);
      expect(Object.isFrozen(imported)).toBe(true);
      expect(Object.isFrozen(imported.archive)).toBe(true);
      expect(Object.isFrozen(imported.archive.sections)).toBe(true);
      expect(Object.isFrozen(imported.built.snapshot)).toBe(true);
      expect(Object.isFrozen(imported.built.snapshot.mentions)).toBe(true);
      expect(Object.isFrozen(imported.artifactInventory)).toBe(true);
      expect(Object.isFrozen(imported.rankingSnapshots)).toBe(true);
      expect(Object.isFrozen(imported.rankingSnapshots[0])).toBe(true);
    });

    test("semantic corruption reaches exact fail-closed reasons", async () => {
      expect(graphArchiveCorruptionFixtures).toEqual(
        expect.arrayContaining([
          "changed_graph_identity",
          "missing_provenance",
          "unsupported_version",
          "non_canonical_bytes",
        ]),
      );
      const value = await fixture();
      const capabilities = implementation.makeGraphAdapterCapabilities(["snapshot_export"]);
      const archive = await Effect.runPromise(
        implementation.exportGraphCorpusArchive({
          built: value.built,
          capabilities,
          artifactInventory: value.inventory,
          summaryRecords: [
            {
              artifact: value.summary,
              summarySchemaId: "summary.conformance.v1",
              encoding: "utf8-base64",
              payloadBase64: base64(value.summaryBytes),
              payloadDigest: payloadDigest(value.summaryBytes),
              visibility: "private",
              redactionClass: "none",
            },
          ],
          rankingSnapshots: [value.ranking],
        }),
      );
      const missing = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
      missing.sections.provenance.entries.pop();
      await expect(
        Effect.runPromise(implementation.importGraphCorpusArchive(bytesOf(rehash(missing)))),
      ).rejects.toMatchObject({
        _tag: "GraphCorpus.ArchiveError",
        reason: "stale_binding",
      });
      await expect(
        Effect.runPromise(
          implementation.importGraphCorpusArchive(
            new TextEncoder().encode('{"manifest":{"formatVersion":2}}'),
          ),
        ),
      ).rejects.toMatchObject({ reason: "unsupported_version" });
      const canonical = bytesOf(archive);
      await expect(
        Effect.runPromise(
          implementation.importGraphCorpusArchive(new Uint8Array([...canonical, 32])),
        ),
      ).rejects.toMatchObject({ reason: "non_canonical" });
      const changed = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
      changed.sections.graph.graphDigest = "f".repeat(64) as GraphDigest;
      await expect(
        Effect.runPromise(implementation.importGraphCorpusArchive(bytesOf(rehash(changed)))),
      ).rejects.toMatchObject({ reason: "stale_binding" });
    });
  });
};
