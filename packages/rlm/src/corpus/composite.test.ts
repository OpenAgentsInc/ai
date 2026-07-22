import { Effect, Schema as S, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  RlmCitation,
  RlmCorpusInput,
  RlmCorpusInputV1,
  type RlmCorpusEntry,
} from "../schemas/corpus.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import { runDeterministicOperation } from "../interpreter/deterministic.ts";
import { defaultRlmBudget } from "../schemas/budget.ts";
import { makeRlmEnvironment } from "../environment/values.ts";
import { executeProgram } from "../program/execute.ts";
import { validateCitations } from "./citations.ts";
import { citationFromEntry } from "./citations.ts";
import {
  buildInMemoryCompositeProjection,
  IN_MEMORY_COMPOSITE_PROJECTION_ENTRY_CEILING,
  makeCompositeCorpusHandle,
  type MakeCompositeCorpusHandleInput,
  type RlmCompositeProjection,
} from "./composite.ts";
import {
  canonicalJson,
  computeCompositeProjectionDigest,
  excerptDigest,
  sha256Hex,
} from "./digest.ts";
import {
  buildInlineCorpusInput,
  makeInlineCorpusHandle,
  migrateRlmCorpusV1,
  type RlmCorpusHandle,
} from "./handle.ts";

const policy = {
  includeVisibilities: ["public"] as const,
  includeRedactionClasses: ["none"] as const,
};

const child = (ref: string, address: string, text = "fact") =>
  buildInlineCorpusInput({
    corpusRef: ref,
    scopeRef: "scope",
    policy,
    entries: [
      {
        scopeRef: "scope",
        sourcePlane: "repository",
        sourceKind: "fixture",
        sourceAddress: { addressSchemaId: "fixture.address.v1", encodedAddress: address },
        text,
        visibility: "public",
        redactionClass: "none",
      },
    ],
  });

const make = (input: ReturnType<typeof child>) => Effect.runPromise(makeInlineCorpusHandle(input));

const compose = Effect.fn("test.compose")(function* (
  input: Omit<MakeCompositeCorpusHandleInput, "projection">,
) {
  const projection = yield* buildInMemoryCompositeProjection(input);
  return yield* makeCompositeCorpusHandle({ ...input, projection });
});

describe("RLM composite corpus", () => {
  test("binds ordered child identities and preserves exact citation origins", async () => {
    const first = await make(child("child.a", "a"));
    const second = await make(child("child.b", "b"));
    const composite = await Effect.runPromise(
      compose({
        corpusRef: "composite.ab",
        scopeRef: "scope",
        policy,
        children: [
          { expectedIdentity: first.identity, handle: first },
          { expectedIdentity: second.identity, handle: second },
        ],
      }),
    );
    const reversed = await Effect.runPromise(
      compose({
        corpusRef: "composite.ba",
        scopeRef: "scope",
        policy,
        children: [
          { expectedIdentity: second.identity, handle: second },
          { expectedIdentity: first.identity, handle: first },
        ],
      }),
    );
    expect(composite.identity.contentDigest).not.toBe(reversed.identity.contentDigest);

    const result = await Effect.runPromise(
      runDeterministicOperation(
        composite,
        { _tag: "Grep", pattern: "fact" },
        { maxEntriesScanned: 10, maxSpans: 10, maxCharsPerSpan: 100, maxObservationChars: 1000 },
      ),
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.citation.sourceOrigin.corpusRef).toBe("child.a");
    const validation = await Effect.runPromise(
      validateCitations(
        composite,
        result.findings.map((f) => f.citation),
      ),
    );
    expect(validation.invalid).toEqual([]);
  });

  test("fails closed on policy widening and duplicate source addresses", async () => {
    const first = await make(child("child.a", "same"));
    const second = await make(child("child.b", "same"));
    const duplicate = await Effect.runPromise(
      compose({
        corpusRef: "composite",
        scopeRef: "scope",
        policy,
        children: [
          { expectedIdentity: first.identity, handle: first },
          { expectedIdentity: second.identity, handle: second },
        ],
      }).pipe(Effect.flip),
    );
    expect(duplicate.reason).toBe("duplicate_source");

    const widened = await Effect.runPromise(
      compose({
        corpusRef: "composite",
        scopeRef: "scope",
        policy: { includeVisibilities: ["public", "private"], includeRedactionClasses: ["none"] },
        children: [{ expectedIdentity: first.identity, handle: first }],
      }).pipe(Effect.flip),
    );
    expect(widened.reason).toBe("policy_widened");
  });

  test("checks child freshness before every bounded operation", async () => {
    const base = await make(child("child.a", "a"));
    let changed = false;
    const stale: RlmCorpusHandle = {
      ...base,
      assertUnchanged: () =>
        changed ? Effect.fail(new RlmCorpusError({ reason: "changed" })) : Effect.void,
    };
    const composite = await Effect.runPromise(
      compose({
        corpusRef: "composite",
        scopeRef: "scope",
        policy,
        children: [{ expectedIdentity: stale.identity, handle: stale }],
      }),
    );
    changed = true;
    const error = await Effect.runPromise(
      composite
        .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 10 })
        .pipe(Effect.flip),
    );
    expect(error.reason).toBe("changed");
  });

  test("does not require materializeAll for bounded scans", async () => {
    const base = await make(child("child.a", "a", "needle"));
    const outOfCore: RlmCorpusHandle = {
      ...base,
      materializeAll: () => Effect.die("materializeAll must not run"),
    };
    const result = await Effect.runPromise(
      runDeterministicOperation(
        outOfCore,
        { _tag: "Grep", pattern: "needle" },
        { maxEntriesScanned: 1, maxSpans: 1, maxCharsPerSpan: 100, maxObservationChars: 100 },
      ),
    );
    expect(result.findings).toHaveLength(1);
  });

  test("preserves corpus_changed for deterministic and program bounded paths", async () => {
    const base = await make(child("child.changed", "changed"));
    const changed: RlmCorpusHandle = {
      ...base,
      read: () => Effect.fail(new RlmCorpusError({ reason: "changed" })),
      scan: () => Stream.fail(new RlmCorpusError({ reason: "changed" })),
    };
    const limits = {
      maxEntriesScanned: 1,
      maxSpans: 1,
      maxCharsPerSpan: 10,
      maxObservationChars: 100,
    };
    const scanError = await Effect.runPromise(
      runDeterministicOperation(changed, { _tag: "Grep", pattern: "x" }, limits).pipe(Effect.flip),
    );
    expect(scanError.reason).toBe("corpus_changed");
    const ordinalError = await Effect.runPromise(
      runDeterministicOperation(
        changed,
        { _tag: "OrdinalSlice", start: 0, endInclusive: 0 },
        limits,
      ).pipe(Effect.flip),
    );
    expect(ordinalError.reason).toBe("corpus_changed");

    const env = await Effect.runPromise(makeRlmEnvironment(defaultRlmBudget));
    const programError = await Effect.runPromise(
      executeProgram(
        {
          schemaId: "openagents.ai.rlm_program.v1",
          programRef: "program.changed",
          nodes: [
            {
              _tag: "CorpusOp",
              nodeRef: "node.changed",
              operator: "OrdinalSlice",
              params: { start: 0, endInclusive: 0 },
              inputValueRefs: [],
              outputValueRef: "value.changed",
            },
          ],
        },
        {
          handle: changed,
          env,
          budget: defaultRlmBudget,
          depth: 0,
          runRef: "run.changed",
          emit: () => Effect.void,
          clockMs: () => Effect.succeed(0),
        },
      ).pipe(Effect.flip),
    );
    expect(programError.reason).toBe("corpus_changed");
    const programScanError = await Effect.runPromise(
      executeProgram(
        {
          schemaId: "openagents.ai.rlm_program.v1",
          programRef: "program.changed.scan",
          nodes: [
            {
              _tag: "CorpusOp",
              nodeRef: "node.changed.scan",
              operator: "Grep",
              params: { pattern: "x" },
              inputValueRefs: [],
              outputValueRef: "value.changed.scan",
            },
          ],
        },
        {
          handle: changed,
          env,
          budget: defaultRlmBudget,
          depth: 0,
          runRef: "run.changed.scan",
          emit: () => Effect.void,
          clockMs: () => Effect.succeed(0),
        },
      ).pipe(Effect.flip),
    );
    expect(programScanError.reason).toBe("corpus_changed");
  });

  test("requires explicit v1 source classification and policy migration", () => {
    const legacy = S.decodeUnknownSync(RlmCorpusInputV1)({
      _tag: "Inline",
      manifest: {
        schemaId: "openagents.ai.rlm_corpus.v1",
        corpusRef: "legacy",
        contentDigest: "old-content",
        manifestDigest: "old-manifest",
        ordering: { rule: "explicit_array" },
        coverage: { note: "legacy", entryCount: 1, encodedBytes: 1, exclusions: [] },
        scopeRef: "scope",
      },
      entries: [
        {
          ordinal: 0,
          entryRef: "entry.0",
          scopeRef: "scope",
          sourceKind: "legacy",
          sourceAddress: { addressSchemaId: "legacy.v1", encodedAddress: "a" },
          text: "text",
          visibility: "public",
          redactionClass: "none",
        },
      ],
    });
    if (legacy._tag !== "Inline") throw new Error("expected inline fixture");
    const migrated = migrateRlmCorpusV1(legacy, { sourcePlane: "repository", policy });
    expect(migrated.manifest.schemaId).toBe("openagents.ai.rlm_corpus.v2");
    expect(migrated.entries[0]!.sourcePlane).toBe("repository");
    expect(migrated.manifest.contentDigest).not.toBe("old-content");
  });

  test("rejects cross-paired v1 and v2 inline fields", () => {
    const current = child("current", "a");
    const malformed = {
      ...current,
      manifest: { ...current.manifest, schemaId: "openagents.ai.rlm_corpus.v1" },
    };
    expect(() => S.decodeUnknownSync(RlmCorpusInput)(malformed)).toThrow();
  });

  test("rejects inline entry scope mismatch and cross-scope composition", async () => {
    const inline = child("child.scope", "scope");
    const mismatchedInline = {
      ...inline,
      entries: [{ ...inline.entries[0]!, scopeRef: "other.scope" }],
    };
    const inlineError = await Effect.runPromise(
      makeInlineCorpusHandle(mismatchedInline).pipe(Effect.flip),
    );
    expect(inlineError.reason).toBe("invalid_inline");

    const base = await make(inline);
    const foreign: RlmCorpusHandle = {
      ...base,
      manifest: { ...base.manifest, scopeRef: "other.scope" },
    };
    const projection = await Effect.runPromise(
      buildInMemoryCompositeProjection({
        corpusRef: "cross.scope",
        scopeRef: "scope",
        policy,
        children: [{ expectedIdentity: base.identity, handle: base }],
      }),
    );
    const error = await Effect.runPromise(
      makeCompositeCorpusHandle({
        corpusRef: "cross.scope",
        scopeRef: "scope",
        policy,
        children: [{ expectedIdentity: foreign.identity, handle: foreign }],
        projection,
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("invalid_inline");
  });

  test("rejects a substituted citation excerpt even with its recomputed digest", async () => {
    const base = await make(child("child.citation", "citation", "original bytes"));
    const entry = (
      await Effect.runPromise(
        base.read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 100 }),
      )
    )[0]!;
    const citation = citationFromEntry(base, entry);
    const { excerptDigest: _excerptDigest, ...missingDigest } = citation;
    expect(() => S.decodeUnknownSync(RlmCitation)(missingDigest)).toThrow();
    const substituted = {
      ...citation,
      excerpt: "substitute bytes",
      excerptDigest: excerptDigest("substitute bytes"),
    };
    const result = await Effect.runPromise(validateCitations(base, [substituted]));
    expect(result.invalid[0]?.reason).toBe("excerpt_mismatch");

    const extraSource = {
      ...citation,
      supportingSources: [citation.sourceOrigin],
    };
    const supportingResult = await Effect.runPromise(validateCitations(base, [extraSource]));
    expect(supportingResult.invalid[0]?.reason).toBe("source_mismatch");
  });

  test("bounds citation excerpts before any entry read", async () => {
    const base = await make(child("child.excerpt-cap", "excerpt-cap", "actual bytes"));
    const entry = (
      await Effect.runPromise(
        base.read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 100 }),
      )
    )[0]!;
    const citation = citationFromEntry(base, entry);
    const longExcerpt = "x".repeat(513);
    const overlong = {
      ...citation,
      excerpt: longExcerpt,
      excerptDigest: excerptDigest(longExcerpt),
    };
    expect(() => S.decodeUnknownSync(RlmCitation)(overlong)).toThrow();
    let reads = 0;
    const counted: RlmCorpusHandle = {
      ...base,
      read: (...args) => {
        reads += 1;
        return base.read(...args);
      },
    };
    const result = await Effect.runPromise(validateCitations(counted, [overlong]));
    expect(result.invalid[0]?.reason).toBe("excerpt_mismatch");
    expect(reads).toBe(0);
  });

  test("accepts canonical-equivalent extension plane key order in citations", async () => {
    const sourcePlane = {
      _tag: "Extension" as const,
      schemaId: "openagents.ai.rlm_source_plane_extension.v1" as const,
      registrySchemaId: "fixture.extension.registry.v1",
      plane: "fixture_plane",
    };
    const input = buildInlineCorpusInput({
      corpusRef: "child.extension-order",
      scopeRef: "scope",
      policy,
      entries: [
        {
          scopeRef: "scope",
          sourcePlane,
          sourceKind: "fixture",
          sourceAddress: { addressSchemaId: "extension.order.v1", encodedAddress: "a" },
          text: "extension bytes",
          visibility: "public",
          redactionClass: "none",
        },
      ],
    });
    const base = await Effect.runPromise(makeInlineCorpusHandle(input));
    const entry = (
      await Effect.runPromise(
        base.read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 100 }),
      )
    )[0]!;
    const citation = citationFromEntry(base, entry);
    const reorderedPlane = {
      plane: sourcePlane.plane,
      registrySchemaId: sourcePlane.registrySchemaId,
      schemaId: sourcePlane.schemaId,
      _tag: sourcePlane._tag,
    };
    const reordered = {
      ...citation,
      sourcePlane: reorderedPlane,
      sourceOrigin: { ...citation.sourceOrigin, sourcePlane: reorderedPlane },
    };
    const result = await Effect.runPromise(validateCitations(base, [reordered]));
    expect(result.invalid).toEqual([]);
  });

  test("binds the pointer root and calls projection freshness during construction", async () => {
    const base = await make(child("child.root", "root"));
    const input = {
      corpusRef: "composite.root",
      scopeRef: "scope",
      policy,
      children: [{ expectedIdentity: base.identity, handle: base }],
    };
    const projection = await Effect.runPromise(buildInMemoryCompositeProjection(input));
    let freshnessChecks = 0;
    const checked: RlmCompositeProjection = {
      ...projection,
      assertUnchanged: () => {
        freshnessChecks += 1;
        return projection.assertUnchanged();
      },
    };
    const first = await Effect.runPromise(
      makeCompositeCorpusHandle({ ...input, projection: checked }),
    );
    expect(freshnessChecks).toBe(1);

    const { projectionDigest: _digest, ...changedSummary } = {
      ...projection.summary,
      pointerIndexDigest: sha256Hex("different pointer mapping"),
    };
    const changedProjection: RlmCompositeProjection = {
      ...projection,
      summary: {
        ...changedSummary,
        projectionDigest: computeCompositeProjectionDigest(changedSummary),
      },
      assertUnchanged: () => Effect.void,
    };
    const second = await Effect.runPromise(
      makeCompositeCorpusHandle({ ...input, projection: changedProjection }),
    );
    expect(second.identity.contentDigest).toBe(first.identity.contentDigest);
    expect(second.identity.manifestDigest).not.toBe(first.identity.manifestDigest);
  });

  test("rejects a pointer plane that its projection summary does not declare", async () => {
    const base = await make(child("child.undeclared-plane", "undeclared-plane"));
    const input = {
      corpusRef: "composite.undeclared-plane",
      scopeRef: "scope",
      policy,
      children: [{ expectedIdentity: base.identity, handle: base }],
    };
    const projection = await Effect.runPromise(buildInMemoryCompositeProjection(input));
    const { projectionDigest: _digest, ...summaryWithoutDigest } = {
      ...projection.summary,
      sourcePlanes: [],
    };
    const undeclared: RlmCompositeProjection = {
      ...projection,
      summary: {
        projectionDigest: computeCompositeProjectionDigest(summaryWithoutDigest),
        ...summaryWithoutDigest,
      },
      assertUnchanged: () => Effect.void,
    };
    const composite = await Effect.runPromise(
      makeCompositeCorpusHandle({ ...input, projection: undeclared }),
    );
    const error = await Effect.runPromise(
      composite
        .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 20 })
        .pipe(Effect.flip),
    );
    expect(error.reason).toBe("unsupported_plane");
  });

  test("the fixture projection cap uses actual streamed entries", async () => {
    const base = await make(child("child.cap", "cap"));
    const streamed: RlmCorpusHandle = {
      ...base,
      manifest: {
        ...base.manifest,
        coverage: { ...base.manifest.coverage, entryCount: 1 },
      },
      scan: () => {
        const entries = {
          *[Symbol.iterator](): Iterator<RlmCorpusEntry> {
            for (
              let ordinal = 0;
              ordinal <= IN_MEMORY_COMPOSITE_PROJECTION_ENTRY_CEILING;
              ordinal++
            ) {
              yield {
                ordinal,
                entryRef: `entry.${ordinal}`,
                scopeRef: "scope",
                sourcePlane: "repository",
                sourceKind: "fixture",
                sourceAddress: {
                  addressSchemaId: "fixture.cap.v1",
                  encodedAddress: String(ordinal),
                },
                visibility: "public",
                redactionClass: "none",
              };
            }
          },
        };
        return Stream.fromIterable(entries);
      },
    };
    const error = await Effect.runPromise(
      buildInMemoryCompositeProjection({
        corpusRef: "composite.cap",
        scopeRef: "scope",
        policy,
        children: [{ expectedIdentity: streamed.identity, handle: streamed }],
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("byte_ceiling");
  });

  test("rejects substituted addresses, incomplete projection ranges, and overflow", async () => {
    const inputValue = buildInlineCorpusInput({
      corpusRef: "child.pointer",
      scopeRef: "scope",
      policy,
      entries: [
        {
          scopeRef: "scope",
          sourcePlane: "repository",
          sourceKind: "fixture",
          sourceAddress: { addressSchemaId: "pointer.v1", encodedAddress: "a" },
          text: "a",
          visibility: "public",
          redactionClass: "none",
        },
        {
          scopeRef: "scope",
          sourcePlane: "repository",
          sourceKind: "fixture",
          sourceAddress: { addressSchemaId: "pointer.v1", encodedAddress: "b" },
          text: "b",
          visibility: "public",
          redactionClass: "none",
        },
      ],
    });
    const base = await Effect.runPromise(makeInlineCorpusHandle(inputValue));
    const input = {
      corpusRef: "composite.pointer",
      scopeRef: "scope",
      policy,
      children: [{ expectedIdentity: base.identity, handle: base }],
    };
    const projection = await Effect.runPromise(buildInMemoryCompositeProjection(input));
    const pointer = (
      await Effect.runPromise(
        projection.readPointers({ start: 0, endInclusive: 0 }, { maxEntries: 1 }),
      )
    )[0]!;

    const substitutedProjection: RlmCompositeProjection = {
      ...projection,
      lookupAddress: () =>
        Effect.succeed({
          _tag: "Unique",
          pointer: {
            ...pointer,
            sourceAddress: { ...pointer.sourceAddress, encodedAddress: "substituted" },
          },
        }),
    };
    const substituted = await Effect.runPromise(
      makeCompositeCorpusHandle({ ...input, projection: substitutedProjection }),
    );
    const addressError = await Effect.runPromise(
      substituted
        .validateSourceAddress(pointer.sourceAddress, pointer.sourcePlane)
        .pipe(Effect.flip),
    );
    expect(addressError.reason).toBe("changed");

    const incompleteProjection: RlmCompositeProjection = {
      ...projection,
      readPointers: () => Effect.succeed([]),
      scanPointers: () => Stream.empty,
    };
    const incomplete = await Effect.runPromise(
      makeCompositeCorpusHandle({ ...input, projection: incompleteProjection }),
    );
    const incompleteReadError = await Effect.runPromise(
      incomplete
        .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 10 })
        .pipe(Effect.flip),
    );
    expect(incompleteReadError.reason).toBe("changed");
    const incompleteScanError = await Effect.runPromise(
      incomplete.scan({ maxEntries: 1 }).pipe(Stream.runCollect, Effect.flip),
    );
    expect(incompleteScanError.reason).toBe("changed");

    const overflowOrdinal = projection.summary.coverage.entryCount;
    const overflowProjection: RlmCompositeProjection = {
      ...projection,
      readPointers: () => Effect.succeed([{ ...pointer, globalOrdinal: overflowOrdinal }]),
    };
    const overflow = await Effect.runPromise(
      makeCompositeCorpusHandle({ ...input, projection: overflowProjection }),
    );
    const overflowError = await Effect.runPromise(
      overflow
        .read(
          { start: overflowOrdinal, endInclusive: overflowOrdinal },
          { maxEntries: 1, maxCharsPerEntry: 10 },
        )
        .pipe(Effect.flip),
    );
    expect(overflowError.reason).toBe("changed");
  });

  test("constructs and reads a million-entry projection with bounded work", async () => {
    const base = await make(child("lazy", "seed"));
    const size = 1_000_000;
    let materialized = false;
    let childReads = 0;
    let childScans = 0;
    let projectionReads = 0;
    const entryAt = (ordinal: number): RlmCorpusEntry => ({
      ordinal,
      entryRef: `entry.${ordinal}`,
      scopeRef: "scope",
      sourcePlane: "repository",
      sourceKind: "lazy_fixture",
      sourceAddress: {
        addressSchemaId: "lazy.address.v1",
        encodedAddress: String(ordinal),
      },
      text: `entry ${ordinal}`,
      visibility: "public",
      redactionClass: "none",
    });
    const lazy: RlmCorpusHandle = {
      ...base,
      manifest: {
        ...base.manifest,
        coverage: { ...base.manifest.coverage, entryCount: size, encodedBytes: size * 32 },
      },
      read: (range, limits) =>
        Effect.sync(() => {
          childReads += 1;
          return Array.from(
            { length: Math.min(limits.maxEntries, range.endInclusive - range.start + 1) },
            (_, offset) => entryAt(range.start + offset),
          );
        }),
      scan: (request) => {
        childScans += 1;
        const from = request.fromOrdinal ?? 0;
        const iterable = {
          *[Symbol.iterator](): Iterator<RlmCorpusEntry> {
            const end = Math.min(size, from + request.maxEntries);
            for (let ordinal = from; ordinal < end; ordinal++) yield entryAt(ordinal);
          },
        };
        return Stream.fromIterable(iterable);
      },
      validateSourceAddress: (address) => {
        const ordinal = Number(address.encodedAddress);
        const entry = entryAt(ordinal);
        return Effect.succeed({
          address,
          sourcePlane: entry.sourcePlane,
          entryRef: entry.entryRef,
          ordinal,
          origin: {
            sourcePlane: entry.sourcePlane,
            sourceKind: entry.sourceKind,
            sourceAddress: address,
            corpusRef: base.identity.corpusRef,
            contentDigest: base.identity.contentDigest,
            entryRef: entry.entryRef,
          },
        });
      },
      materializeAll: () => {
        materialized = true;
        return Effect.die("materializeAll must not run");
      },
    };
    const pointerAt = (ordinal: number) => {
      const entry = entryAt(ordinal);
      return {
        globalOrdinal: ordinal,
        compositeEntryRef: `composite.0.${entry.entryRef}`,
        childIndex: 0,
        childOrdinal: ordinal,
        childEntryRef: entry.entryRef,
        sourcePlane: entry.sourcePlane,
        sourceAddress: entry.sourceAddress,
        sourceOrigin: {
          sourcePlane: entry.sourcePlane,
          sourceKind: entry.sourceKind,
          sourceAddress: entry.sourceAddress,
          corpusRef: lazy.identity.corpusRef,
          contentDigest: lazy.identity.contentDigest,
          entryRef: entry.entryRef,
        },
      } as const;
    };
    const summaryWithoutDigest = {
      scopeRef: "scope",
      orderedChildren: [
        {
          childIndex: 0,
          corpusRef: lazy.identity.corpusRef,
          contentDigest: lazy.identity.contentDigest,
          manifestDigest: lazy.identity.manifestDigest,
        },
      ],
      policy,
      orderingRule: "composite_child_then_ordinal" as const,
      coverage: {
        note: "million entry projection",
        entryCount: size,
        encodedBytes: size * 32,
        exclusions: [],
      },
      exclusions: [],
      sourcePlanes: ["repository" as const],
      duplicateSourceCount: 0,
      pointerIndexDigest: sha256Hex(canonicalJson({ generator: "ordinal-v1", size })),
    };
    const projection: RlmCompositeProjection = {
      summary: {
        projectionDigest: computeCompositeProjectionDigest(summaryWithoutDigest),
        ...summaryWithoutDigest,
      },
      assertUnchanged: () => Effect.void,
      readPointers: (range, limits) =>
        Effect.sync(() => {
          projectionReads += 1;
          return Array.from(
            { length: Math.min(limits.maxEntries, range.endInclusive - range.start + 1) },
            (_, offset) => pointerAt(range.start + offset),
          );
        }),
      scanPointers: (request) => {
        const from = request.fromOrdinal ?? 0;
        return Stream.fromIterable(
          Array.from({ length: request.maxEntries }, (_, offset) => pointerAt(from + offset)),
        );
      },
      lookupAddress: (address) =>
        Effect.succeed({ _tag: "Unique", pointer: pointerAt(Number(address.encodedAddress)) }),
    };
    const composite = await Effect.runPromise(
      makeCompositeCorpusHandle({
        corpusRef: "large.composite",
        scopeRef: "scope",
        policy,
        children: [{ expectedIdentity: lazy.identity, handle: lazy }],
        projection,
      }),
    );
    expect(childReads).toBe(0);
    expect(childScans).toBe(0);
    expect(projectionReads).toBe(0);
    const entries = await Effect.runPromise(
      composite.read(
        { start: size - 1, endInclusive: size - 1 },
        { maxEntries: 1, maxCharsPerEntry: 100 },
      ),
    );
    expect(entries[0]?.text).toBe(`entry ${size - 1}`);
    expect(childReads).toBe(1);
    expect(childScans).toBe(0);
    expect(projectionReads).toBe(1);
    expect(materialized).toBe(false);
  });
});
