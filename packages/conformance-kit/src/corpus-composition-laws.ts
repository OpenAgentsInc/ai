import { Effect, Stream } from "effect";
import {
  buildInlineCorpusInput,
  citationFromEntry,
  canonicalJson,
  computeCompositeProjectionDigest,
  makeInlineCorpusHandle,
  validateCitations,
  sha256Hex,
  RlmCorpusError,
  type MakeCompositeCorpusHandleInput,
  type RlmCompositeProjection,
  type RlmCorpusEntry,
  type RlmCorpusHandle,
} from "@openagentsinc/rlm";
import { describe, expect, test } from "vite-plus/test";

export interface CorpusCompositionLawsConfig {
  readonly label: string;
  readonly compose: (
    input: MakeCompositeCorpusHandleInput,
  ) => Effect.Effect<RlmCorpusHandle, RlmCorpusError>;
  readonly makeProjection: (
    input: Omit<MakeCompositeCorpusHandleInput, "projection">,
  ) => Effect.Effect<RlmCompositeProjection, RlmCorpusError>;
}

const policy = {
  includeVisibilities: ["public"] as const,
  includeRedactionClasses: ["none"] as const,
};

const childInput = (
  corpusRef: string,
  address: string,
  options?: {
    readonly scopeRef?: string;
    readonly sourcePlane?: RlmCorpusEntry["sourcePlane"];
    readonly exclusions?: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
  },
) => {
  const scopeRef = options?.scopeRef ?? "scope.conformance";
  return buildInlineCorpusInput({
    corpusRef,
    scopeRef,
    policy,
    ...(options?.exclusions === undefined ? {} : { exclusions: options.exclusions }),
    entries: [
      {
        scopeRef,
        sourcePlane: options?.sourcePlane ?? "repository",
        sourceKind: "fixture",
        sourceAddress: { addressSchemaId: "conformance.address.v1", encodedAddress: address },
        text: `content ${address}`,
        visibility: "public",
        redactionClass: "none",
      },
    ],
  });
};

const makeChild = (input: ReturnType<typeof childInput>) =>
  Effect.runPromise(makeInlineCorpusHandle(input));

const composeWithProjection = (
  config: CorpusCompositionLawsConfig,
  input: Omit<MakeCompositeCorpusHandleInput, "projection">,
) =>
  Effect.gen(function* () {
    const projection = yield* config.makeProjection(input);
    return yield* config.compose({ ...input, projection });
  });

/** Published laws for an application-authorized RLM composite implementation. */
export const runCorpusCompositionLaws = (config: CorpusCompositionLawsConfig): void => {
  describe(`[${config.label}] RLM corpus composition`, () => {
    test("same ordered identities and policy produce the same identity", async () => {
      const first = await makeChild(childInput("child.a", "a"));
      const second = await makeChild(childInput("child.b", "b"));
      const input = {
        corpusRef: "composite",
        scopeRef: "scope.conformance",
        policy,
        children: [
          { expectedIdentity: first.identity, handle: first },
          { expectedIdentity: second.identity, handle: second },
        ],
      } satisfies Omit<MakeCompositeCorpusHandleInput, "projection">;
      const left = await Effect.runPromise(composeWithProjection(config, input));
      const right = await Effect.runPromise(composeWithProjection(config, input));
      expect(left.identity).toEqual(right.identity);
    });

    test("semantic child reordering changes the composite content digest", async () => {
      const first = await makeChild(childInput("child.a", "a"));
      const second = await makeChild(childInput("child.b", "b"));
      const left = await Effect.runPromise(
        composeWithProjection(config, {
          corpusRef: "left",
          scopeRef: "scope.conformance",
          policy,
          children: [
            { expectedIdentity: first.identity, handle: first },
            { expectedIdentity: second.identity, handle: second },
          ],
        }),
      );
      const right = await Effect.runPromise(
        composeWithProjection(config, {
          corpusRef: "right",
          scopeRef: "scope.conformance",
          policy,
          children: [
            { expectedIdentity: second.identity, handle: second },
            { expectedIdentity: first.identity, handle: first },
          ],
        }),
      );
      expect(left.identity.contentDigest).not.toBe(right.identity.contentDigest);
    });

    test("a composite policy cannot widen a child policy", async () => {
      const child = await makeChild(childInput("child.a", "a"));
      const input = {
        corpusRef: "composite",
        scopeRef: "scope.conformance",
        policy: {
          includeVisibilities: ["public", "private"] as const,
          includeRedactionClasses: ["none"] as const,
        },
        children: [{ expectedIdentity: child.identity, handle: child }],
      };
      const projection = await Effect.runPromise(config.makeProjection({ ...input, policy }));
      const error = await Effect.runPromise(
        config.compose({ ...input, projection }).pipe(Effect.flip),
      );
      expect(error.reason).toBe("policy_widened");
    });

    test("a composite cannot cross child manifest scopes", async () => {
      const base = await makeChild(childInput("child.scope", "scope"));
      const input = {
        corpusRef: "composite.scope",
        scopeRef: "scope.conformance",
        policy,
        children: [{ expectedIdentity: base.identity, handle: base }],
      };
      const projection = await Effect.runPromise(config.makeProjection(input));
      const foreign: RlmCorpusHandle = {
        ...base,
        manifest: { ...base.manifest, scopeRef: "foreign.scope" },
      };
      const error = await Effect.runPromise(
        config
          .compose({
            ...input,
            children: [{ expectedIdentity: foreign.identity, handle: foreign }],
            projection,
          })
          .pipe(Effect.flip),
      );
      expect(error.reason).toBe("invalid_inline");
    });

    test("a stale child or projection fails bounded reads", async () => {
      const base = await makeChild(childInput("child.stale", "stale"));
      let childChanged = false;
      const child: RlmCorpusHandle = {
        ...base,
        assertUnchanged: () =>
          childChanged ? Effect.fail(new RlmCorpusError({ reason: "changed" })) : Effect.void,
      };
      const input = {
        corpusRef: "composite.stale",
        scopeRef: "scope.conformance",
        policy,
        children: [{ expectedIdentity: child.identity, handle: child }],
      };
      const projection = await Effect.runPromise(config.makeProjection(input));
      const composite = await Effect.runPromise(config.compose({ ...input, projection }));
      childChanged = true;
      const childError = await Effect.runPromise(
        composite
          .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 20 })
          .pipe(Effect.flip),
      );
      expect(childError.reason).toBe("changed");

      childChanged = false;
      let projectionChanged = false;
      const wrapped: RlmCompositeProjection = {
        ...projection,
        assertUnchanged: () =>
          projectionChanged
            ? Effect.fail(new RlmCorpusError({ reason: "changed" }))
            : projection.assertUnchanged(),
      };
      const second = await Effect.runPromise(config.compose({ ...input, projection: wrapped }));
      projectionChanged = true;
      const projectionError = await Effect.runPromise(
        second
          .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 20 })
          .pipe(Effect.flip),
      );
      expect(projectionError.reason).toBe("changed");
    });

    test("citations retain and validate the exact child locator", async () => {
      const child = await makeChild(childInput("child.citation", "citation"));
      const composite = await Effect.runPromise(
        composeWithProjection(config, {
          corpusRef: "composite.citation",
          scopeRef: "scope.conformance",
          policy,
          children: [{ expectedIdentity: child.identity, handle: child }],
        }),
      );
      const entry = (
        await Effect.runPromise(
          composite.read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 100 }),
        )
      )[0]!;
      const citation = citationFromEntry(composite, entry);
      expect(citation.sourceOrigin.contentDigest).toBe(child.identity.contentDigest);
      const valid = await Effect.runPromise(validateCitations(composite, [citation]));
      expect(valid.invalid).toEqual([]);
      const changedLocators = [
        { ...citation.sourceOrigin, contentDigest: "changed-child-digest" },
        { ...citation.sourceOrigin, entryRef: "changed-entry-ref" },
        { ...citation.sourceOrigin, sourcePlane: "evidence_pack" as const },
        {
          ...citation.sourceOrigin,
          sourceAddress: { ...citation.sourceOrigin.sourceAddress, encodedAddress: "changed" },
        },
      ];
      for (const sourceOrigin of changedLocators) {
        const invalid = await Effect.runPromise(
          validateCitations(composite, [{ ...citation, sourceOrigin }]),
        );
        expect(invalid.invalid[0]?.reason).toBe("source_mismatch");
      }
    });

    test("duplicate addresses and unsupported planes fail closed", async () => {
      const first = await makeChild(childInput("child.dup.a", "same"));
      const second = await makeChild(childInput("child.dup.b", "same"));
      const duplicateInput = {
        corpusRef: "composite.duplicate",
        scopeRef: "scope.conformance",
        policy,
        children: [
          { expectedIdentity: first.identity, handle: first },
          { expectedIdentity: second.identity, handle: second },
        ],
      };
      const duplicateProjection = await Effect.runPromise(config.makeProjection(duplicateInput));
      const duplicate = await Effect.runPromise(
        config.compose({ ...duplicateInput, projection: duplicateProjection }).pipe(Effect.flip),
      );
      expect(duplicate.reason).toBe("duplicate_source");

      const extended = await makeChild(
        childInput("child.extension", "extension", {
          sourcePlane: {
            _tag: "Extension",
            schemaId: "openagents.ai.rlm_source_plane_extension.v1",
            registrySchemaId: "unadmitted.registry.v1",
            plane: "unadmitted",
          },
        }),
      );
      const extensionInput = {
        corpusRef: "composite.extension",
        scopeRef: "scope.conformance",
        policy,
        children: [{ expectedIdentity: extended.identity, handle: extended }],
      };
      const extensionProjection = await Effect.runPromise(config.makeProjection(extensionInput));
      const unsupported = await Effect.runPromise(
        config.compose({ ...extensionInput, projection: extensionProjection }).pipe(Effect.flip),
      );
      expect(unsupported.reason).toBe("unsupported_plane");
    });

    test("coverage and exclusion changes change the manifest digest", async () => {
      const child = await makeChild(childInput("child.coverage", "coverage"));
      const input = {
        corpusRef: "composite.coverage",
        scopeRef: "scope.conformance",
        policy,
        children: [{ expectedIdentity: child.identity, handle: child }],
      };
      const projection = await Effect.runPromise(config.makeProjection(input));
      const left = await Effect.runPromise(config.compose({ ...input, projection }));
      const { projectionDigest: _digest, ...summaryWithoutDigest } = projection.summary;
      const changedSummary = {
        ...summaryWithoutDigest,
        coverage: {
          ...summaryWithoutDigest.coverage,
          exclusions: [{ reason: "fixture_exclusion", count: 1 }],
        },
        exclusions: [
          {
            childCorpusRef: child.identity.corpusRef,
            reason: "fixture_exclusion",
            count: 1,
          },
        ],
      };
      const changedProjection: RlmCompositeProjection = {
        ...projection,
        summary: {
          projectionDigest: computeCompositeProjectionDigest(changedSummary),
          ...changedSummary,
        },
        assertUnchanged: () => Effect.void,
      };
      const right = await Effect.runPromise(
        config.compose({ ...input, projection: changedProjection }),
      );
      expect(left.identity.contentDigest).toBe(right.identity.contentDigest);
      expect(left.identity.manifestDigest).not.toBe(right.identity.manifestDigest);

      const changedRootSummary = {
        ...summaryWithoutDigest,
        pointerIndexDigest: sha256Hex("changed conformance pointer root"),
      };
      const changedRoot: RlmCompositeProjection = {
        ...projection,
        summary: {
          projectionDigest: computeCompositeProjectionDigest(changedRootSummary),
          ...changedRootSummary,
        },
        assertUnchanged: () => Effect.void,
      };
      const rooted = await Effect.runPromise(config.compose({ ...input, projection: changedRoot }));
      expect(rooted.identity.contentDigest).toBe(left.identity.contentDigest);
      expect(rooted.identity.manifestDigest).not.toBe(left.identity.manifestDigest);
    });

    test("incomplete ranges and pointer-child mismatches fail changed", async () => {
      const child = await makeChild(childInput("child.pointer-law", "pointer-law"));
      const input = {
        corpusRef: "composite.pointer-law",
        scopeRef: "scope.conformance",
        policy,
        children: [{ expectedIdentity: child.identity, handle: child }],
      };
      const projection = await Effect.runPromise(config.makeProjection(input));
      const incomplete: RlmCompositeProjection = {
        ...projection,
        readPointers: () => Effect.succeed([]),
        scanPointers: () => Stream.empty,
      };
      const incompleteComposite = await Effect.runPromise(
        config.compose({ ...input, projection: incomplete }),
      );
      const readError = await Effect.runPromise(
        incompleteComposite
          .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 20 })
          .pipe(Effect.flip),
      );
      expect(readError.reason).toBe("changed");
      const scanError = await Effect.runPromise(
        incompleteComposite.scan({ maxEntries: 1 }).pipe(Stream.runCollect, Effect.flip),
      );
      expect(scanError.reason).toBe("changed");

      const pointer = (
        await Effect.runPromise(
          projection.readPointers({ start: 0, endInclusive: 0 }, { maxEntries: 1 }),
        )
      )[0]!;
      const mismatched: RlmCompositeProjection = {
        ...projection,
        readPointers: () =>
          Effect.succeed([{ ...pointer, childEntryRef: "different-child-entry" }]),
      };
      const mismatchComposite = await Effect.runPromise(
        config.compose({ ...input, projection: mismatched }),
      );
      const mismatchError = await Effect.runPromise(
        mismatchComposite
          .read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 20 })
          .pipe(Effect.flip),
      );
      expect(mismatchError.reason).toBe("changed");
    });

    test("constructor and one bounded read do not enumerate a large child", async () => {
      const base = await makeChild(childInput("child.large", "0"));
      let reads = 0;
      let scans = 0;
      let materializes = 0;
      let projectionReads = 0;
      const entry = (ordinal: number): RlmCorpusEntry => ({
        ordinal,
        entryRef: `entry.${ordinal}`,
        scopeRef: "scope.conformance",
        sourcePlane: "repository",
        sourceKind: "fixture",
        sourceAddress: {
          addressSchemaId: "conformance.large.v1",
          encodedAddress: String(ordinal),
        },
        text: `entry ${ordinal}`,
        visibility: "public",
        redactionClass: "none",
      });
      const child: RlmCorpusHandle = {
        ...base,
        manifest: {
          ...base.manifest,
          coverage: { ...base.manifest.coverage, entryCount: 1_000_000 },
        },
        read: (range) =>
          Effect.sync(() => {
            reads += 1;
            return [entry(range.start)];
          }),
        scan: () => {
          scans += 1;
          return Stream.empty;
        },
        materializeAll: () => {
          materializes += 1;
          return Effect.succeed([]);
        },
      };
      const pointer = {
        globalOrdinal: 0,
        compositeEntryRef: "composite.0.entry.0",
        childIndex: 0,
        childOrdinal: 0,
        childEntryRef: "entry.0",
        sourcePlane: "repository" as const,
        sourceAddress: entry(0).sourceAddress,
        sourceOrigin: {
          sourcePlane: "repository" as const,
          sourceKind: "fixture",
          sourceAddress: entry(0).sourceAddress,
          corpusRef: child.identity.corpusRef,
          contentDigest: child.identity.contentDigest,
          entryRef: "entry.0",
        },
      };
      const summaryWithoutDigest = {
        scopeRef: "scope.conformance",
        orderedChildren: [
          {
            childIndex: 0,
            corpusRef: child.identity.corpusRef,
            contentDigest: child.identity.contentDigest,
            manifestDigest: child.identity.manifestDigest,
          },
        ],
        policy,
        orderingRule: "composite_child_then_ordinal" as const,
        coverage: {
          note: "large projection",
          entryCount: 1_000_000,
          encodedBytes: 1_000_000,
          exclusions: [],
        },
        exclusions: [],
        sourcePlanes: ["repository" as const],
        duplicateSourceCount: 0,
        pointerIndexDigest: sha256Hex(
          canonicalJson({ generator: "conformance-single-pointer-v1", size: 1_000_000 }),
        ),
      };
      const projection: RlmCompositeProjection = {
        summary: {
          projectionDigest: computeCompositeProjectionDigest(summaryWithoutDigest),
          ...summaryWithoutDigest,
        },
        assertUnchanged: () => Effect.void,
        readPointers: () =>
          Effect.sync(() => {
            projectionReads += 1;
            return [pointer];
          }),
        scanPointers: () => Stream.make(pointer),
        lookupAddress: () => Effect.succeed({ _tag: "Unique", pointer }),
      };
      const composite = await Effect.runPromise(
        config.compose({
          corpusRef: "composite.large",
          scopeRef: "scope.conformance",
          policy,
          children: [{ expectedIdentity: child.identity, handle: child }],
          projection,
        }),
      );
      expect({ reads, scans, materializes, projectionReads }).toEqual({
        reads: 0,
        scans: 0,
        materializes: 0,
        projectionReads: 0,
      });
      await Effect.runPromise(
        composite.read({ start: 0, endInclusive: 0 }, { maxEntries: 1, maxCharsPerEntry: 20 }),
      );
      expect({ reads, scans, materializes, projectionReads }).toEqual({
        reads: 1,
        scans: 0,
        materializes: 0,
        projectionReads: 1,
      });
    });
  });
};
