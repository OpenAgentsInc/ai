import { createHash } from "node:crypto";
import { Effect, Schema as S } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { buildInlineCorpusInput, makeInlineCorpusHandle } from "@openagentsinc/rlm/corpus";

import {
  GRAPH_ARCHIVE_MAX_BYTES,
  GraphArchiveRef,
  GraphArchiveError,
  encodeGraphCorpusArchive,
  exportGraphCorpusArchive,
  importGraphCorpusArchive,
  type GraphCorpusArchive,
} from "./archive.ts";
import {
  GraphDerivation,
  GraphVectorArtifact,
  GraphSummaryArtifact,
  buildGraphCorpus,
  canonicalJson,
  graphDigest,
  makeCanonicalEntity,
  makeEmbeddingProjectionDescriptor,
  makeGraphAdapterCapabilities,
  makeGraphArtifactInventory,
  makeGraphMention,
  makeGraphRelation,
  planGraphSourceDeletion,
  sha256Hex,
  type GraphDigest,
} from "./index.ts";
import {
  GRAPH_RANKING_ALGORITHM_VERSION,
  GRAPH_RANKING_SNAPSHOT_SCHEMA_ID,
  GraphRankingSnapshot,
} from "./ranking.ts";

const digest = (value: unknown) => graphDigest(sha256Hex(canonicalJson(value)));
const payloadDigest = (bytes: Uint8Array) =>
  graphDigest(createHash("sha256").update(bytes).digest("hex"));
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(""));
const capabilities = makeGraphAdapterCapabilities(["snapshot_export"]);
type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends ReadonlyArray<infer U>
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
const rehash = (value: GraphCorpusArchive | Mutable<GraphCorpusArchive>): GraphCorpusArchive => {
  const archive = structuredClone(value) as unknown as Mutable<GraphCorpusArchive>;
  const update = (section: { sectionDigest: GraphDigest; [key: string]: unknown }) => {
    const { sectionDigest: _sectionDigest, ...content } = section;
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
    `archive.${sha256Hex(
      canonicalJson({
        contentDigest: archive.manifest.contentDigest,
        manifestDigest: archive.manifest.manifestDigest,
      }),
    )}`,
  );
  return archive as unknown as GraphCorpusArchive;
};
const bytesOf = (archive: GraphCorpusArchive) => new TextEncoder().encode(canonicalJson(archive));

const fixture = async () => {
  const corpus = await Effect.runPromise(
    makeInlineCorpusHandle(
      buildInlineCorpusInput({
        corpusRef: "archive.source",
        scopeRef: "tenant.archive",
        policy: {
          includeVisibilities: ["private"],
          includeRedactionClasses: ["none"],
        },
        entries: ["a", "b"].map((entryRef) => ({
          entryRef,
          scopeRef: "tenant.archive",
          sourcePlane: "repository" as const,
          sourceKind: "fixture",
          sourceAddress: {
            addressSchemaId: "fixture.address.v1",
            encodedAddress: `path:${entryRef}`,
          },
          text: `PRIVATE-FIXTURE-${entryRef}`,
          visibility: "private" as const,
          redactionClass: "none" as const,
        })),
      }),
    ),
  );
  const sources = await Promise.all(
    ["a", "b"].map((entryRef) =>
      Effect.runPromise(
        corpus
          .validateSourceAddress({
            addressSchemaId: "fixture.address.v1",
            encodedAddress: `path:${entryRef}`,
          })
          .pipe(Effect.map((value) => value.origin)),
      ),
    ),
  );
  const derivation = S.decodeUnknownSync(GraphDerivation)({
    _tag: "Deterministic",
    parserRef: "archive.parser",
    parserVersion: "1.0.0",
  });
  const mentionA = makeGraphMention({
    identityNamespace: "archive",
    canonicalKey: "mention:a",
    identityScopeRef: "tenant.archive",
    source: sources[0]!,
    derivation,
  });
  const mentionB = makeGraphMention({
    identityNamespace: "archive",
    canonicalKey: "mention:b",
    identityScopeRef: "tenant.archive",
    source: sources[1]!,
    derivation,
  });
  const entityA = makeCanonicalEntity({
    identityNamespace: "archive",
    canonicalKey: "entity:a",
    identityScopeRef: "tenant.archive",
    mentions: [mentionA],
    derivation,
  });
  const entityB = makeCanonicalEntity({
    identityNamespace: "archive",
    canonicalKey: "entity:b",
    identityScopeRef: "tenant.archive",
    mentions: [mentionB],
    derivation,
  });
  const relation = makeGraphRelation({
    identityNamespace: "archive",
    canonicalKey: "relation:a-b",
    identityScopeRef: "tenant.archive",
    relationKind: "related_to",
    from: entityA,
    to: entityB,
    memberships: [{ source: sources[0]! }],
    derivation,
  });
  const descriptor = makeEmbeddingProjectionDescriptor({
    projectionSchemaId: "archive.embedding.v1",
    elementKinds: ["entity"],
    embeddableFields: ["identity.canonicalKey"],
    dimensions: 2,
  });
  const built = await Effect.runPromise(
    buildGraphCorpus({
      graphRef: "graph.archive.fixture",
      scopeRef: "tenant.archive",
      policy: {
        includeVisibilities: ["private"],
        includeRedactionClasses: ["none"],
      },
      mentions: [mentionB, mentionA],
      entities: [entityB, entityA],
      relations: [relation],
      embeddingProjections: [descriptor],
    }),
  );
  return { built, descriptor, entityA, mentionA, source: sources[0]! };
};

const makeRankingSnapshot = (built: Awaited<ReturnType<typeof fixture>>["built"]) => {
  const content = {
    schemaId: GRAPH_RANKING_SNAPSHOT_SCHEMA_ID,
    graphRef: built.snapshot.graphRef,
    scopeRef: built.snapshot.scopeRef,
    graphDigest: built.snapshot.graphDigest,
    manifestDigest: built.manifest.manifestDigest,
    corpusRef: "archive.rlm",
    contentDigest: "1".repeat(64),
    corpusManifestDigest: "2".repeat(64),
    classificationDigest: "3".repeat(64),
    algorithmVersion: GRAPH_RANKING_ALGORITHM_VERSION,
    feedbackObservations: [],
    confidences: [],
    features: [],
  };
  return S.decodeUnknownSync(GraphRankingSnapshot)({
    ...content,
    snapshotRef: `ranking-snapshot.${sha256Hex(canonicalJson(content))}`,
    snapshotDigest: digest(content),
  });
};

describe("graph corpus archive v1", () => {
  test("round-trips stable canonical bytes without source text or active behavior", async () => {
    const { built } = await fixture();
    const bytesA = await Effect.runPromise(encodeGraphCorpusArchive({ built, capabilities }));
    const bytesB = await Effect.runPromise(encodeGraphCorpusArchive({ built, capabilities }));
    expect(bytesA).toEqual(bytesB);
    expect(new TextDecoder().decode(bytesA)).not.toContain("PRIVATE-FIXTURE");
    const imported = await Effect.runPromise(importGraphCorpusArchive(bytesA));
    expect(imported.built).toEqual(built);
    expect(Object.isFrozen(imported)).toBe(true);
    expect(Object.isFrozen(imported.archive.sections.nodes.mentions)).toBe(true);
    expect(JSON.stringify(imported)).not.toContain("function");
    await expect(
      Effect.runPromise(
        exportGraphCorpusArchive({
          built,
          capabilities: makeGraphAdapterCapabilities([]),
        }),
      ),
    ).rejects.toBeInstanceOf(GraphArchiveError);
  });

  test("round-trips portable vector, summary, ranking, and deletion state", async () => {
    const { built, descriptor, entityA, source } = await fixture();
    const vectorBytes = new Uint8Array(new Float32Array([1, 2]).buffer);
    const summaryBytes = new TextEncoder().encode("bounded summary");
    const vectorArtifact = S.decodeUnknownSync(GraphVectorArtifact)({
      artifactKind: "vector",
      artifactRef: "archive.vector.a",
      artifactDigest: payloadDigest(vectorBytes),
      ownerElementRef: entityA.elementRef,
    });
    const summaryArtifact = S.decodeUnknownSync(GraphSummaryArtifact)({
      artifactKind: "summary",
      artifactRef: "archive.summary.a",
      artifactDigest: payloadDigest(summaryBytes),
      ownerElementRef: entityA.elementRef,
    });
    const inventory = makeGraphArtifactInventory({
      built,
      vectors: [vectorArtifact],
      summaries: [summaryArtifact],
      rankingRefs: [],
      coverage: {
        vectors: { _tag: "Complete" },
        summaries: { _tag: "Complete" },
        rankingRefs: { _tag: "Complete" },
      },
    });
    const rankingSnapshot = makeRankingSnapshot(built);
    const archive = await Effect.runPromise(
      exportGraphCorpusArchive({
        built,
        capabilities,
        artifactInventory: inventory,
        vectorRecords: [
          {
            artifact: vectorArtifact,
            descriptorRef: descriptor.descriptorRef,
            dimensions: 2,
            encoding: "float32-le-base64",
            payloadBase64: base64(vectorBytes),
            payloadDigest: payloadDigest(vectorBytes),
            visibility: "private",
            redactionClass: "none",
          },
        ],
        summaryRecords: [
          {
            artifact: summaryArtifact,
            summarySchemaId: "archive.summary.v1",
            encoding: "utf8-base64",
            payloadBase64: base64(summaryBytes),
            payloadDigest: payloadDigest(summaryBytes),
            visibility: "private",
            redactionClass: "none",
          },
        ],
        rankingSnapshots: [rankingSnapshot],
      }),
    );
    const bytes = bytesOf(archive);
    const imported = await Effect.runPromise(importGraphCorpusArchive(bytes));
    expect(imported.artifactInventory).toEqual(inventory);
    expect(imported.rankingSnapshots).toEqual([rankingSnapshot]);
    const plan = await Effect.runPromise(
      planGraphSourceDeletion(imported.built, source, imported.artifactInventory!),
    );
    expect(plan.artifactInventoryDigest).toBe(inventory.inventoryDigest);
    expect(imported.built.snapshot.graphDigest).toBe(built.snapshot.graphDigest);

    const payloadSubstitution = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
    const changedBytes = new Uint8Array(new Float32Array([3, 4]).buffer);
    payloadSubstitution.sections.vectors!.records[0]!.payloadBase64 = base64(changedBytes);
    payloadSubstitution.sections.vectors!.records[0]!.payloadDigest = payloadDigest(changedBytes);
    await expect(
      Effect.runPromise(importGraphCorpusArchive(bytesOf(rehash(payloadSubstitution)))),
    ).rejects.toMatchObject({ reason: "stale_binding" });

    const missingPlane = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
    delete missingPlane.sections.summaries;
    await expect(
      Effect.runPromise(importGraphCorpusArchive(bytesOf(rehash(missingPlane)))),
    ).rejects.toBeInstanceOf(GraphArchiveError);
  });

  test("refuses malformed, noncanonical, unsupported, legacy, and oversized bytes", async () => {
    const { built } = await fixture();
    const bytes = await Effect.runPromise(encodeGraphCorpusArchive({ built, capabilities }));
    await expect(
      Effect.runPromise(importGraphCorpusArchive(new Uint8Array([...bytes, 32]))),
    ).rejects.toMatchObject({ reason: "non_canonical" });
    await expect(
      Effect.runPromise(importGraphCorpusArchive(new TextEncoder().encode("{bad"))),
    ).rejects.toMatchObject({ reason: "invalid_json" });
    await expect(
      Effect.runPromise(importGraphCorpusArchive(Uint8Array.of(0xff))),
    ).rejects.toMatchObject({ reason: "invalid_utf8" });
    await expect(
      Effect.runPromise(importGraphCorpusArchive(new TextEncoder().encode("{}"))),
    ).rejects.toMatchObject({ reason: "migration_required" });
    await expect(
      Effect.runPromise(
        importGraphCorpusArchive(new TextEncoder().encode('{"manifest":{"formatVersion":2}}')),
      ),
    ).rejects.toMatchObject({ reason: "unsupported_version" });
    const schemaVersion = structuredClone(
      await Effect.runPromise(exportGraphCorpusArchive({ built, capabilities })),
    ) as unknown as Mutable<GraphCorpusArchive>;
    schemaVersion.manifest.graphSchemaId = "openagents.ai.graph_snapshot.v2";
    await expect(
      Effect.runPromise(importGraphCorpusArchive(bytesOf(rehash(schemaVersion)))),
    ).rejects.toMatchObject({ reason: "unsupported_version" });
    const canonicalizationVersion = structuredClone(
      await Effect.runPromise(exportGraphCorpusArchive({ built, capabilities })),
    ) as unknown as Mutable<GraphCorpusArchive>;
    canonicalizationVersion.manifest.canonicalizationId = "openagents.ai.graph_canonicalization.v2";
    await expect(
      Effect.runPromise(importGraphCorpusArchive(bytesOf(rehash(canonicalizationVersion)))),
    ).rejects.toMatchObject({ reason: "unsupported_version" });
    await expect(
      Effect.runPromise(importGraphCorpusArchive(new Uint8Array(GRAPH_ARCHIVE_MAX_BYTES + 1))),
    ).rejects.toMatchObject({ reason: "oversized" });
  });

  test("requires separate trusted authority for policy-bound content", async () => {
    const { built, mentionA, source } = await fixture();
    const entryContent = {
      elementRef: mentionA.elementRef,
      source,
      text: "authorized content",
      visibility: "private" as const,
      redactionClass: "none" as const,
    };
    const authorization = {
      authorizationRef: "authority.archive.test",
      authorityEvidenceRef: "evidence.archive.test",
      allowedVisibilities: ["private"] as const,
      allowedRedactionClasses: ["none"] as const,
      classifications: [
        {
          elementRef: mentionA.elementRef,
          source,
          visibility: "private" as const,
          redactionClass: "none" as const,
        },
      ],
    };
    const archive = await Effect.runPromise(
      exportGraphCorpusArchive({
        built,
        capabilities,
        contentExtension: {
          authorizationRef: authorization.authorizationRef,
          authorityEvidenceRef: authorization.authorityEvidenceRef,
          allowedVisibilities: authorization.allowedVisibilities,
          allowedRedactionClasses: authorization.allowedRedactionClasses,
          entries: [{ ...entryContent, contentDigest: digest(entryContent) }],
        },
      }),
    );
    const bytes = bytesOf(archive);
    await expect(Effect.runPromise(importGraphCorpusArchive(bytes))).rejects.toMatchObject({
      reason: "forbidden_content",
    });
    const imported = await Effect.runPromise(
      importGraphCorpusArchive(bytes, { contentAuthorization: authorization }),
    );
    expect(imported.contentExtension?.entries[0]?.text).toBe("authorized content");

    await expect(
      Effect.runPromise(
        exportGraphCorpusArchive({
          built,
          capabilities,
          contentExtension: {
            authorizationRef: authorization.authorizationRef,
            authorityEvidenceRef: authorization.authorityEvidenceRef,
            allowedVisibilities: authorization.allowedVisibilities,
            allowedRedactionClasses: ["none", "private_ref"],
            entries: [{ ...entryContent, contentDigest: digest(entryContent) }],
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "forbidden_content" });

    const extraClass = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
    extraClass.sections.contentExtension!.allowedRedactionClasses.push("private_ref");
    await expect(
      Effect.runPromise(
        importGraphCorpusArchive(bytesOf(rehash(extraClass)), {
          contentAuthorization: {
            ...authorization,
            allowedRedactionClasses: ["none", "private_ref"],
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "forbidden_content" });

    const oversizedEntries = Array.from({ length: 9 }, (_, index) => {
      const content = {
        ...entryContent,
        text: "x".repeat(262_144),
        source: { ...source, entryRef: `oversized-${index}` },
      };
      return { ...content, contentDigest: digest(content) };
    });
    await expect(
      Effect.runPromise(
        exportGraphCorpusArchive({
          built,
          capabilities,
          contentExtension: { ...authorization, entries: oversizedEntries },
        }),
      ),
    ).rejects.toMatchObject({ reason: "oversized" });

    const sourceSubstitution = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
    const entry = sourceSubstitution.sections.contentExtension!.entries[0]!;
    entry.source.entryRef = "not-a-member";
    const { contentDigest: _contentDigest, ...changedContent } = entry;
    entry.contentDigest = digest(changedContent);
    await expect(
      Effect.runPromise(
        importGraphCorpusArchive(bytesOf(rehash(sourceSubstitution)), {
          contentAuthorization: authorization,
        }),
      ),
    ).rejects.toMatchObject({ reason: "forbidden_content" });
  });

  test("rejects section corruption before reconstruction", async () => {
    const { built } = await fixture();
    const archive = await Effect.runPromise(exportGraphCorpusArchive({ built, capabilities }));
    const changed = structuredClone(archive) as GraphCorpusArchive;
    Object.defineProperty(changed.sections.nodes.mentions[0]!, "elementRef", {
      value: "graph.mention.changed",
    });
    await expect(
      Effect.runPromise(importGraphCorpusArchive(new TextEncoder().encode(canonicalJson(changed)))),
    ).rejects.toMatchObject({ reason: "digest_mismatch" });
  });

  test("rejects rehashed mandatory-section reordering and missing provenance", async () => {
    const { built } = await fixture();
    const archive = await Effect.runPromise(exportGraphCorpusArchive({ built, capabilities }));
    const reordered = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
    reordered.sections.nodes.mentions.reverse();
    await expect(
      Effect.runPromise(importGraphCorpusArchive(bytesOf(rehash(reordered)))),
    ).rejects.toMatchObject({ reason: "stale_binding" });

    const missingProvenance = structuredClone(archive) as unknown as Mutable<GraphCorpusArchive>;
    missingProvenance.sections.provenance.entries.pop();
    await expect(
      Effect.runPromise(importGraphCorpusArchive(bytesOf(rehash(missingProvenance)))),
    ).rejects.toMatchObject({ reason: "stale_binding" });
  });
});
