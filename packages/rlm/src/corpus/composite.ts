import { Effect, Stream } from "effect";
import type {
  RlmCompositeChildIdentity,
  RlmCompositionExclusion,
  RlmCorpusCoverage,
  RlmCorpusEntry,
  RlmCorpusIdentity,
  RlmCorpusManifest,
  RlmCorpusPolicy,
  RlmOrdinalRange,
  RlmReadLimits,
  RlmScanRequest,
  RlmSourceAddress,
  RlmSourceLocator,
  RlmSourcePlane,
} from "../schemas/corpus.ts";
import {
  RLM_COMPOSITION_SCHEMA_ID,
  RLM_CORPUS_SCHEMA_ID,
  type RlmCorpusComposition,
} from "../schemas/corpus.ts";
import type { RlmDigest } from "../schemas/primitives.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import {
  canonicalJson,
  computeCompositeContentDigest,
  computeCompositeProjectionDigest,
  computeManifestDigest,
  sha256Hex,
} from "./digest.ts";
import {
  canonicalizeRlmCorpusPolicy,
  type RlmCorpusHandle,
  type RlmValidatedSourceAddress,
} from "./handle.ts";

export interface RlmCompositeChild {
  readonly expectedIdentity: RlmCorpusIdentity;
  readonly handle: RlmCorpusHandle;
}

export interface RlmCompositeEntryPointer {
  readonly globalOrdinal: number;
  readonly compositeEntryRef: string;
  readonly childIndex: number;
  readonly childOrdinal: number;
  readonly childEntryRef: string;
  readonly sourcePlane: RlmSourcePlane;
  readonly sourceAddress: RlmSourceAddress;
  readonly sourceOrigin: RlmSourceLocator;
}

export interface RlmCompositeProjectionSummary {
  readonly projectionDigest: RlmDigest;
  readonly scopeRef: string;
  readonly orderedChildren: ReadonlyArray<RlmCompositeChildIdentity>;
  readonly policy: RlmCorpusPolicy;
  readonly orderingRule: "composite_child_then_ordinal";
  readonly coverage: RlmCorpusCoverage;
  readonly exclusions: ReadonlyArray<RlmCompositionExclusion>;
  readonly sourcePlanes: ReadonlyArray<RlmSourcePlane>;
  readonly duplicateSourceCount: number;
  /** Root digest for the complete ordered pointer mapping. */
  readonly pointerIndexDigest: RlmDigest;
}

export type RlmCompositeAddressLookup =
  | { readonly _tag: "Unique"; readonly pointer: RlmCompositeEntryPointer }
  | { readonly _tag: "Duplicate" };

export interface RlmCompositeProjection {
  readonly summary: RlmCompositeProjectionSummary;
  readonly assertUnchanged: () => Effect.Effect<void, RlmCorpusError>;
  readonly readPointers: (
    range: RlmOrdinalRange,
    limits: Pick<RlmReadLimits, "maxEntries">,
  ) => Effect.Effect<ReadonlyArray<RlmCompositeEntryPointer>, RlmCorpusError>;
  readonly scanPointers: (
    request: RlmScanRequest,
  ) => Stream.Stream<RlmCompositeEntryPointer, RlmCorpusError>;
  readonly lookupAddress: (
    address: RlmSourceAddress,
    sourcePlane?: RlmSourcePlane,
  ) => Effect.Effect<RlmCompositeAddressLookup, RlmCorpusError>;
}

export interface MakeCompositeCorpusHandleInput {
  readonly corpusRef: string;
  readonly scopeRef: string;
  readonly children: ReadonlyArray<RlmCompositeChild>;
  readonly policy: RlmCorpusPolicy;
  readonly projection: RlmCompositeProjection;
  /** The trusted host must explicitly admit every extension registry. */
  readonly supportedExtensionSchemaIds?: ReadonlyArray<string>;
}

export const IN_MEMORY_COMPOSITE_PROJECTION_ENTRY_CEILING = 10_000;

const addressKey = (address: RlmSourceAddress): string =>
  `${address.addressSchemaId}\u0000${address.encodedAddress}`;

const planeKey = (plane: RlmSourcePlane): string => canonicalJson(plane);

const sameIdentity = (left: RlmCorpusIdentity, right: RlmCorpusIdentity): boolean =>
  left.schemaId === right.schemaId &&
  left.corpusRef === right.corpusRef &&
  left.contentDigest === right.contentDigest &&
  left.manifestDigest === right.manifestDigest;

const sameAddress = (left: RlmSourceAddress, right: RlmSourceAddress): boolean =>
  left.addressSchemaId === right.addressSchemaId && left.encodedAddress === right.encodedAddress;

const sameLocator = (left: RlmSourceLocator, right: RlmSourceLocator): boolean =>
  left.corpusRef === right.corpusRef &&
  left.contentDigest === right.contentDigest &&
  left.entryRef === right.entryRef &&
  planeKey(left.sourcePlane) === planeKey(right.sourcePlane) &&
  left.sourceKind === right.sourceKind &&
  sameAddress(left.sourceAddress, right.sourceAddress);

const isSubset = (requested: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean => {
  const allowedSet = new Set(allowed);
  return requested.every((value) => allowedSet.has(value));
};

const planeSupported = (plane: RlmSourcePlane, extensionIds: ReadonlySet<string>): boolean =>
  typeof plane === "string" || extensionIds.has(plane.registrySchemaId);

const entryAllowed = (entry: RlmCorpusEntry, policy: RlmCorpusPolicy): boolean =>
  policy.includeVisibilities.includes(entry.visibility) &&
  policy.includeRedactionClasses.includes(entry.redactionClass);

const originFor = (child: RlmCorpusHandle, entry: RlmCorpusEntry): RlmSourceLocator =>
  entry.sourceOrigin ?? {
    sourcePlane: entry.sourcePlane,
    sourceKind: entry.sourceKind,
    sourceAddress: entry.sourceAddress,
    corpusRef: child.identity.corpusRef,
    contentDigest: child.identity.contentDigest,
    entryRef: entry.entryRef,
  };

const orderedChildren = (
  children: ReadonlyArray<RlmCompositeChild>,
): ReadonlyArray<RlmCompositeChildIdentity> =>
  children.map((child, childIndex) => ({
    childIndex,
    corpusRef: child.handle.identity.corpusRef,
    contentDigest: child.handle.identity.contentDigest,
    manifestDigest: child.handle.identity.manifestDigest,
  }));

const projectionDigest = (
  summary: Omit<RlmCompositeProjectionSummary, "projectionDigest">,
): RlmDigest => computeCompositeProjectionDigest(summary);

const sameCanonical = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const aggregateExclusions = (
  exclusions: ReadonlyArray<RlmCompositionExclusion>,
): RlmCorpusCoverage["exclusions"] =>
  [...new Set(exclusions.map((item) => item.reason))].sort().map((reason) => ({
    reason,
    count: exclusions
      .filter((item) => item.reason === reason)
      .reduce((sum, item) => sum + item.count, 0),
  }));

/**
 * Build a hard-capped in-memory projection for tests and small fixtures.
 * Durable applications can supply a digest-bound out-of-core projection.
 */
export const buildInMemoryCompositeProjection = Effect.fn("Rlm.buildInMemoryCompositeProjection")(
  function* (input: Omit<MakeCompositeCorpusHandleInput, "projection">) {
    const policy = canonicalizeRlmCorpusPolicy(input.policy);
    const pointers: Array<RlmCompositeEntryPointer> = [];
    const byAddress = new Map<string, Array<RlmCompositeEntryPointer>>();
    const sourcePlanes = new Map<string, RlmSourcePlane>();
    const exclusions: Array<RlmCompositionExclusion> = input.children.flatMap((child) =>
      child.handle.manifest.coverage.exclusions.map((exclusion) => ({
        childCorpusRef: child.handle.identity.corpusRef,
        reason: exclusion.reason,
        count: exclusion.count,
      })),
    );
    let encodedBytes = 0;
    let streamedCount = 0;

    for (let childIndex = 0; childIndex < input.children.length; childIndex++) {
      const child = input.children[childIndex]!;
      if (child.handle.manifest.scopeRef !== input.scopeRef) {
        return yield* new RlmCorpusError({
          reason: "invalid_inline",
          detailSafe: "composite and child scopes differ",
        });
      }
      let policyExcluded = 0;
      let childStreamedCount = 0;
      yield* child.handle
        .scan({ maxEntries: IN_MEMORY_COMPOSITE_PROJECTION_ENTRY_CEILING - streamedCount + 1 })
        .pipe(
          Stream.take(IN_MEMORY_COMPOSITE_PROJECTION_ENTRY_CEILING - streamedCount + 1),
          Stream.runForEach((entry) =>
            Effect.gen(function* () {
              streamedCount += 1;
              childStreamedCount += 1;
              if (streamedCount > IN_MEMORY_COMPOSITE_PROJECTION_ENTRY_CEILING) {
                return yield* new RlmCorpusError({
                  reason: "byte_ceiling",
                  detailSafe: "in-memory composite projection exceeds its entry ceiling",
                });
              }
              if (entry.scopeRef !== input.scopeRef) {
                return yield* new RlmCorpusError({
                  reason: "invalid_inline",
                  detailSafe: "composite and child entry scopes differ",
                });
              }
              sourcePlanes.set(planeKey(entry.sourcePlane), entry.sourcePlane);
              if (!entryAllowed(entry, policy)) {
                policyExcluded += 1;
                return;
              }
              const pointer: RlmCompositeEntryPointer = {
                globalOrdinal: pointers.length,
                compositeEntryRef: `composite.${childIndex}.${entry.entryRef}`,
                childIndex,
                childOrdinal: entry.ordinal,
                childEntryRef: entry.entryRef,
                sourcePlane: entry.sourcePlane,
                sourceAddress: entry.sourceAddress,
                sourceOrigin: originFor(child.handle, entry),
              };
              pointers.push(pointer);
              const key = addressKey(entry.sourceAddress);
              const matches = byAddress.get(key) ?? [];
              matches.push(pointer);
              byAddress.set(key, matches);
              encodedBytes += new TextEncoder().encode(
                JSON.stringify({
                  ...entry,
                  ordinal: pointer.globalOrdinal,
                  entryRef: pointer.compositeEntryRef,
                  sourceOrigin: pointer.sourceOrigin,
                }),
              ).length;
            }),
          ),
        );
      if (childStreamedCount !== child.handle.manifest.coverage.entryCount) {
        return yield* new RlmCorpusError({
          reason: "changed",
          detailSafe: "child stream count differs from its manifest coverage",
        });
      }
      if (policyExcluded > 0) {
        exclusions.push({
          childCorpusRef: child.handle.identity.corpusRef,
          reason: "composite_policy",
          count: policyExcluded,
        });
      }
    }

    const coverage: RlmCorpusCoverage = {
      note: "In-memory projection coverage.",
      entryCount: pointers.length,
      encodedBytes,
      exclusions: aggregateExclusions(exclusions),
    };
    const summaryWithoutDigest: Omit<RlmCompositeProjectionSummary, "projectionDigest"> = {
      scopeRef: input.scopeRef,
      orderedChildren: orderedChildren(input.children),
      policy,
      orderingRule: "composite_child_then_ordinal",
      coverage,
      exclusions,
      sourcePlanes: [...sourcePlanes.values()].sort((left, right) =>
        planeKey(left).localeCompare(planeKey(right)),
      ),
      duplicateSourceCount: [...byAddress.values()].reduce(
        (count, matches) => count + Math.max(0, matches.length - 1),
        0,
      ),
      pointerIndexDigest: sha256Hex(canonicalJson(pointers)),
    };
    const summary: RlmCompositeProjectionSummary = {
      projectionDigest: projectionDigest(summaryWithoutDigest),
      ...summaryWithoutDigest,
    };

    const assertUnchanged = Effect.fn("RlmInMemoryCompositeProjection.assertUnchanged")(
      function* () {
        for (const child of input.children) {
          if (!sameIdentity(child.expectedIdentity, child.handle.identity)) {
            return yield* new RlmCorpusError({
              reason: "changed",
              detailSafe: "projection child identity changed",
            });
          }
          yield* child.handle.assertUnchanged();
        }
        if (projectionDigest(summaryWithoutDigest) !== summary.projectionDigest) {
          return yield* new RlmCorpusError({
            reason: "changed",
            detailSafe: "projection summary changed",
          });
        }
        if (sha256Hex(canonicalJson(pointers)) !== summary.pointerIndexDigest) {
          return yield* new RlmCorpusError({
            reason: "changed",
            detailSafe: "projection pointer index changed",
          });
        }
      },
    );

    return {
      summary,
      assertUnchanged,
      readPointers: Effect.fn("RlmInMemoryCompositeProjection.readPointers")(
        function* (range, limits) {
          yield* assertUnchanged();
          if (range.start > range.endInclusive) {
            return yield* new RlmCorpusError({
              reason: "invalid_range",
              detailSafe: "start > endInclusive",
            });
          }
          return pointers.slice(range.start, range.endInclusive + 1).slice(0, limits.maxEntries);
        },
      ),
      scanPointers: (request) =>
        Stream.unwrap(
          assertUnchanged().pipe(
            Effect.as(
              Stream.fromIterable(
                pointers.slice(
                  request.fromOrdinal ?? 0,
                  (request.fromOrdinal ?? 0) + request.maxEntries,
                ),
              ),
            ),
          ),
        ),
      lookupAddress: (address, sourcePlane) =>
        assertUnchanged().pipe(
          Effect.flatMap(() => {
            const matches = (byAddress.get(addressKey(address)) ?? []).filter(
              (pointer) =>
                sourcePlane === undefined ||
                planeKey(pointer.sourcePlane) === planeKey(sourcePlane),
            );
            if (matches.length === 0) {
              return Effect.fail(
                new RlmCorpusError({
                  reason: "invalid_address",
                  detailSafe: "source address not in composite projection",
                }),
              );
            }
            return Effect.succeed(
              matches.length === 1
                ? ({ _tag: "Unique", pointer: matches[0]! } as const)
                : ({ _tag: "Duplicate" } as const),
            );
          }),
        ),
    } satisfies RlmCompositeProjection;
  },
);

/** Build an immutable composite handle without reading projection entries. */
export const makeCompositeCorpusHandle = Effect.fn("Rlm.makeCompositeCorpusHandle")(function* (
  input: MakeCompositeCorpusHandleInput,
) {
  if (input.children.length === 0) {
    return yield* new RlmCorpusError({
      reason: "unavailable",
      detailSafe: "a composite corpus requires at least one child",
    });
  }
  const extensionIds = new Set(input.supportedExtensionSchemaIds ?? []);
  const policy = canonicalizeRlmCorpusPolicy(input.policy);
  const children = input.children;
  const expectedChildren = orderedChildren(children);

  for (const child of children) {
    if (!sameIdentity(child.expectedIdentity, child.handle.identity)) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "child identity changed before composition",
      });
    }
    yield* child.handle.assertUnchanged();
    if (child.handle.manifest.scopeRef !== input.scopeRef) {
      return yield* new RlmCorpusError({
        reason: "invalid_inline",
        detailSafe: "composite and child scopes differ",
      });
    }
    if (
      !isSubset(policy.includeVisibilities, child.handle.manifest.policy.includeVisibilities) ||
      !isSubset(
        policy.includeRedactionClasses,
        child.handle.manifest.policy.includeRedactionClasses,
      )
    ) {
      return yield* new RlmCorpusError({
        reason: "policy_widened",
        detailSafe: "composite policy is wider than a child policy",
      });
    }
  }

  const summary = input.projection.summary;
  const { projectionDigest: suppliedDigest, ...summaryWithoutDigest } = summary;
  if (
    summary.scopeRef !== input.scopeRef ||
    summary.orderingRule !== "composite_child_then_ordinal" ||
    !sameCanonical(summary.orderedChildren, expectedChildren) ||
    !sameCanonical(summary.policy, policy) ||
    suppliedDigest !== projectionDigest(summaryWithoutDigest)
  ) {
    return yield* new RlmCorpusError({
      reason: "invalid_inline",
      detailSafe: "projection summary does not match the composition request",
    });
  }
  if (summary.duplicateSourceCount > 0) {
    return yield* new RlmCorpusError({
      reason: "duplicate_source",
      detailSafe: "projection contains duplicate source addresses",
    });
  }
  if (summary.sourcePlanes.some((plane) => !planeSupported(plane, extensionIds))) {
    return yield* new RlmCorpusError({
      reason: "unsupported_plane",
      detailSafe: "projection uses an unsupported source plane",
    });
  }
  yield* input.projection.assertUnchanged();

  const composition: RlmCorpusComposition = {
    schemaId: RLM_COMPOSITION_SCHEMA_ID,
    children: expectedChildren,
    policy,
    orderingRule: "composite_child_then_ordinal",
    exclusions: summary.exclusions,
    projectionDigest: summary.projectionDigest,
  };
  const ordering = {
    rule: "composite_child_then_ordinal" as const,
    note: "Child array order, then child ordinal.",
  };
  const contentDigest = computeCompositeContentDigest({ scopeRef: input.scopeRef, composition });
  const manifestDigest = computeManifestDigest({
    contentDigest,
    coverage: summary.coverage,
    policy,
    scopeRef: input.scopeRef,
    ordering,
    composition,
  });
  const identity: RlmCorpusIdentity = {
    schemaId: RLM_CORPUS_SCHEMA_ID,
    corpusRef: input.corpusRef,
    contentDigest,
    manifestDigest,
  };
  const manifest: RlmCorpusManifest = {
    ...identity,
    ordering,
    coverage: summary.coverage,
    policy,
    scopeRef: input.scopeRef,
    composition,
  };

  const assertUnchanged = Effect.fn("RlmCompositeCorpusHandle.assertUnchanged")(function* () {
    for (const child of children) {
      if (!sameIdentity(child.expectedIdentity, child.handle.identity)) {
        return yield* new RlmCorpusError({
          reason: "changed",
          detailSafe: "composite child identity changed",
        });
      }
      yield* child.handle.assertUnchanged();
    }
    yield* input.projection.assertUnchanged();
  });

  const planeDeclared = (plane: RlmSourcePlane): boolean =>
    summary.sourcePlanes.some((declared) => planeKey(declared) === planeKey(plane));
  const validatePointerBounds = (
    pointer: RlmCompositeEntryPointer,
  ): Effect.Effect<RlmCompositeChild, RlmCorpusError> => {
    const child = children[pointer.childIndex];
    if (
      child === undefined ||
      !Number.isSafeInteger(pointer.globalOrdinal) ||
      pointer.globalOrdinal < 0 ||
      pointer.globalOrdinal >= summary.coverage.entryCount ||
      !Number.isSafeInteger(pointer.childOrdinal) ||
      pointer.childOrdinal < 0 ||
      pointer.childOrdinal >= child.handle.manifest.coverage.entryCount
    ) {
      return Effect.fail(
        new RlmCorpusError({
          reason: "changed",
          detailSafe: "projection pointer is outside bound coverage",
        }),
      );
    }
    return Effect.succeed(child);
  };

  const load = Effect.fn("RlmCompositeCorpusHandle.load")(function* (
    pointer: RlmCompositeEntryPointer,
    maxCharsPerEntry: number,
  ) {
    const child = yield* validatePointerBounds(pointer);
    const entries = yield* child.handle.read(
      { start: pointer.childOrdinal, endInclusive: pointer.childOrdinal },
      { maxEntries: 1, maxCharsPerEntry },
    );
    const entry = entries[0];
    if (entry === undefined) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "projection child entry is absent",
      });
    }
    const origin = originFor(child.handle, entry);
    if (
      entry.ordinal !== pointer.childOrdinal ||
      entry.entryRef !== pointer.childEntryRef ||
      entry.scopeRef !== input.scopeRef ||
      planeKey(entry.sourcePlane) !== planeKey(pointer.sourcePlane) ||
      !sameAddress(entry.sourceAddress, pointer.sourceAddress) ||
      !sameLocator(origin, pointer.sourceOrigin) ||
      pointer.compositeEntryRef !== `composite.${pointer.childIndex}.${entry.entryRef}`
    ) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "projection pointer does not match the child entry",
      });
    }
    if (!planeDeclared(entry.sourcePlane) || !planeSupported(entry.sourcePlane, extensionIds)) {
      return yield* new RlmCorpusError({
        reason: "unsupported_plane",
        detailSafe: "projection entry uses an undeclared or unsupported source plane",
      });
    }
    if (!entryAllowed(entry, policy)) {
      return yield* new RlmCorpusError({
        reason: "invalid_inline",
        detailSafe: "projection entry is outside the composite policy",
      });
    }
    return {
      ...entry,
      ordinal: pointer.globalOrdinal,
      entryRef: pointer.compositeEntryRef,
      sourceOrigin: pointer.sourceOrigin,
    } satisfies RlmCorpusEntry;
  });

  const validateAddressPointer = Effect.fn("RlmCompositeCorpusHandle.validateAddressPointer")(
    function* (
      pointer: RlmCompositeEntryPointer,
      address: RlmSourceAddress,
      sourcePlane?: RlmSourcePlane,
    ) {
      if (
        !sameAddress(pointer.sourceAddress, address) ||
        (sourcePlane !== undefined && planeKey(pointer.sourcePlane) !== planeKey(sourcePlane))
      ) {
        return yield* new RlmCorpusError({
          reason: "changed",
          detailSafe: "projection address lookup returned a different source",
        });
      }
      const child = yield* validatePointerBounds(pointer);
      const validated = yield* child.handle.validateSourceAddress(address, sourcePlane);
      if (
        validated.entryRef !== pointer.childEntryRef ||
        validated.ordinal !== pointer.childOrdinal ||
        planeKey(validated.sourcePlane) !== planeKey(pointer.sourcePlane) ||
        !sameLocator(validated.origin, pointer.sourceOrigin) ||
        pointer.compositeEntryRef !== `composite.${pointer.childIndex}.${pointer.childEntryRef}`
      ) {
        return yield* new RlmCorpusError({
          reason: "changed",
          detailSafe: "projection address pointer does not match the child index",
        });
      }
      if (
        !planeDeclared(pointer.sourcePlane) ||
        !planeSupported(pointer.sourcePlane, extensionIds)
      ) {
        return yield* new RlmCorpusError({
          reason: "unsupported_plane",
          detailSafe: "projection address uses an undeclared or unsupported source plane",
        });
      }
      return {
        address,
        sourcePlane: pointer.sourcePlane,
        entryRef: pointer.compositeEntryRef,
        ordinal: pointer.globalOrdinal,
        origin: pointer.sourceOrigin,
      } satisfies RlmValidatedSourceAddress;
    },
  );

  const validatePointers = Effect.fn("RlmCompositeCorpusHandle.validatePointers")(function* (
    pointers: ReadonlyArray<RlmCompositeEntryPointer>,
    range: RlmOrdinalRange,
    maxEntries: number,
  ) {
    const expectedCount = Math.min(
      maxEntries,
      Math.max(0, range.endInclusive - range.start + 1),
      Math.max(0, summary.coverage.entryCount - range.start),
    );
    if (pointers.length !== expectedCount) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "projection returned an incomplete bounded pointer range",
      });
    }
    for (let index = 0; index < pointers.length; index++) {
      const ordinal = pointers[index]!.globalOrdinal;
      if (ordinal !== range.start + index || ordinal > range.endInclusive) {
        return yield* new RlmCorpusError({
          reason: "changed",
          detailSafe: "projection returned a non-contiguous ordinal",
        });
      }
    }
  });

  return {
    identity,
    manifest,
    assertUnchanged,
    read: Effect.fn("RlmCompositeCorpusHandle.read")(function* (range, limits) {
      yield* assertUnchanged();
      if (range.start > range.endInclusive) {
        return yield* new RlmCorpusError({
          reason: "invalid_range",
          detailSafe: "start > endInclusive",
        });
      }
      const pointers = yield* input.projection.readPointers(range, {
        maxEntries: limits.maxEntries,
      });
      yield* validatePointers(pointers, range, limits.maxEntries);
      return yield* Effect.forEach(pointers, (pointer) => load(pointer, limits.maxCharsPerEntry), {
        concurrency: 1,
      });
    }),
    scan: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* assertUnchanged();
          const fromOrdinal = request.fromOrdinal ?? 0;
          const expectedCount = Math.min(
            request.maxEntries,
            Math.max(0, summary.coverage.entryCount - fromOrdinal),
          );
          let emitted = 0;
          let previousOrdinal = fromOrdinal - 1;
          const entries = input.projection.scanPointers(request).pipe(
            Stream.take(expectedCount + 1),
            Stream.mapEffect((pointer) =>
              Effect.gen(function* () {
                if (emitted >= expectedCount) {
                  return yield* new RlmCorpusError({
                    reason: "changed",
                    detailSafe: "projection scan exceeded bounded coverage",
                  });
                }
                if (pointer.globalOrdinal !== previousOrdinal + 1) {
                  return yield* new RlmCorpusError({
                    reason: "changed",
                    detailSafe: "projection scan returned a non-contiguous ordinal",
                  });
                }
                previousOrdinal = pointer.globalOrdinal;
                emitted += 1;
                return yield* load(pointer, Number.MAX_SAFE_INTEGER);
              }),
            ),
          );
          const completeness = Stream.fromEffect(
            Effect.suspend(() =>
              emitted === expectedCount
                ? Effect.void
                : Effect.fail(
                    new RlmCorpusError({
                      reason: "changed",
                      detailSafe: "projection scan ended before bounded coverage",
                    }),
                  ),
            ),
          ).pipe(Stream.drain);
          return Stream.concat(entries, completeness);
        }),
      ),
    validateSourceAddress: (address, sourcePlane) =>
      assertUnchanged().pipe(
        Effect.flatMap(() => input.projection.lookupAddress(address, sourcePlane)),
        Effect.flatMap((lookup) =>
          lookup._tag === "Duplicate"
            ? Effect.fail(
                new RlmCorpusError({
                  reason: "duplicate_source",
                  detailSafe: "projection address lookup is ambiguous",
                }),
              )
            : validateAddressPointer(lookup.pointer, address, sourcePlane),
        ),
      ),
    validateSourceLocator: (locator) => {
      const matching = children.filter(
        (child) =>
          child.handle.identity.corpusRef === locator.corpusRef &&
          child.handle.identity.contentDigest === locator.contentDigest,
      );
      if (matching.length !== 1) {
        return Effect.fail(
          new RlmCorpusError({
            reason: "invalid_address",
            detailSafe: "source locator child is absent or ambiguous",
          }),
        );
      }
      return assertUnchanged().pipe(
        Effect.flatMap(() => matching[0]!.handle.validateSourceLocator(locator)),
      );
    },
    materializeAll: () =>
      Effect.fail(
        new RlmCorpusError({
          reason: "unavailable",
          detailSafe: "composite corpora require bounded read or scan",
        }),
      ),
  } satisfies RlmCorpusHandle;
});
