import { Effect, Schema as S, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { RlmCorpusInput, RlmCorpusInputV1, type RlmCorpusEntry } from "../schemas/corpus.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import { runDeterministicOperation } from "../interpreter/deterministic.ts";
import { validateCitations } from "./citations.ts";
import { makeCompositeCorpusHandle } from "./composite.ts";
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

describe("RLM composite corpus", () => {
  test("binds ordered child identities and preserves exact citation origins", async () => {
    const first = await make(child("child.a", "a"));
    const second = await make(child("child.b", "b"));
    const composite = await Effect.runPromise(
      makeCompositeCorpusHandle({
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
      makeCompositeCorpusHandle({
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
      makeCompositeCorpusHandle({
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
      makeCompositeCorpusHandle({
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
      makeCompositeCorpusHandle({
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

  test("composes and reads a large lazy child without materializeAll", async () => {
    const base = await make(child("lazy", "seed"));
    const size = 5_000;
    let materialized = false;
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
        Effect.succeed(
          Array.from(
            { length: Math.min(limits.maxEntries, range.endInclusive - range.start + 1) },
            (_, offset) => entryAt(range.start + offset),
          ),
        ),
      scan: (request) => {
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
    const composite = await Effect.runPromise(
      makeCompositeCorpusHandle({
        corpusRef: "large.composite",
        scopeRef: "scope",
        policy,
        children: [{ expectedIdentity: lazy.identity, handle: lazy }],
      }),
    );
    const entries = await Effect.runPromise(
      composite.read(
        { start: size - 1, endInclusive: size - 1 },
        { maxEntries: 1, maxCharsPerEntry: 100 },
      ),
    );
    expect(entries[0]?.text).toBe(`entry ${size - 1}`);
    expect(materialized).toBe(false);
  });
});
