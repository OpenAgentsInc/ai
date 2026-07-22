import { Effect, Stream } from "effect";
import type {
  RlmCorpusEntry,
  RlmCorpusIdentity,
  RlmCorpusManifest,
  RlmCorpusPolicy,
  RlmSourceAddress,
  RlmSourceLocator,
  RlmSourcePlane,
} from "../schemas/corpus.ts";
import {
  RLM_COMPOSITION_SCHEMA_ID,
  RLM_CORPUS_SCHEMA_ID,
  type RlmCorpusComposition,
} from "../schemas/corpus.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import { computeCompositeContentDigest, computeManifestDigest } from "./digest.ts";
import {
  canonicalizeRlmCorpusPolicy,
  type RlmCorpusHandle,
  type RlmValidatedSourceAddress,
} from "./handle.ts";

export interface RlmCompositeChild {
  readonly expectedIdentity: RlmCorpusIdentity;
  readonly handle: RlmCorpusHandle;
}

export interface MakeCompositeCorpusHandleInput {
  readonly corpusRef: string;
  readonly scopeRef: string;
  readonly children: ReadonlyArray<RlmCompositeChild>;
  readonly policy: RlmCorpusPolicy;
  /** The trusted host must explicitly admit every extension registry. */
  readonly supportedExtensionSchemaIds?: ReadonlyArray<string>;
}

interface CompositeEntryIndex {
  readonly globalOrdinal: number;
  readonly compositeEntryRef: string;
  readonly childIndex: number;
  readonly childOrdinal: number;
  readonly childEntryRef: string;
  readonly sourcePlane: RlmSourcePlane;
  readonly sourceKind: string;
  readonly sourceAddress: RlmSourceAddress;
  readonly origin: RlmSourceLocator;
  readonly scopeRef: string;
}

const addressKey = (address: RlmSourceAddress): string =>
  `${address.addressSchemaId}\u0000${address.encodedAddress}`;

const sameIdentity = (left: RlmCorpusIdentity, right: RlmCorpusIdentity): boolean =>
  left.schemaId === right.schemaId &&
  left.corpusRef === right.corpusRef &&
  left.contentDigest === right.contentDigest &&
  left.manifestDigest === right.manifestDigest;

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

/**
 * Build an immutable composite handle from application-authorized child handles.
 * Policy is trusted constructor data. It does not enter an RLM request.
 */
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
  const children = input.children.map((child, childIndex) => ({ child, childIndex }));
  for (const { child } of children) {
    if (!sameIdentity(child.expectedIdentity, child.handle.identity)) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "child identity changed before composition",
      });
    }
    yield* child.handle.assertUnchanged();
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

  const exclusions: Array<RlmCorpusComposition["exclusions"][number]> = [];
  const index: Array<CompositeEntryIndex> = [];
  const addresses = new Set<string>();
  let encodedBytes = 0;

  for (const { child, childIndex } of children) {
    for (const exclusion of child.handle.manifest.coverage.exclusions) {
      exclusions.push({
        childCorpusRef: child.handle.identity.corpusRef,
        reason: exclusion.reason,
        count: exclusion.count,
      });
    }
    let policyExcluded = 0;
    yield* child.handle.scan({ maxEntries: child.handle.manifest.coverage.entryCount }).pipe(
      Stream.runForEach((entry) =>
        Effect.gen(function* () {
          if (!planeSupported(entry.sourcePlane, extensionIds)) {
            return yield* new RlmCorpusError({
              reason: "unsupported_plane",
              detailSafe: "composite child uses an unsupported source plane",
            });
          }
          if (!entryAllowed(entry, policy)) {
            policyExcluded += 1;
            return;
          }
          const key = addressKey(entry.sourceAddress);
          if (addresses.has(key)) {
            return yield* new RlmCorpusError({
              reason: "duplicate_source",
              detailSafe: "duplicate source address across composite children",
            });
          }
          addresses.add(key);
          const globalOrdinal = index.length;
          const compositeEntryRef = `composite.${childIndex}.${entry.entryRef}`;
          const origin = originFor(child.handle, entry);
          const projected = {
            ...entry,
            ordinal: globalOrdinal,
            entryRef: compositeEntryRef,
            sourceOrigin: origin,
          } satisfies RlmCorpusEntry;
          encodedBytes += new TextEncoder().encode(JSON.stringify(projected)).length;
          index.push({
            globalOrdinal,
            compositeEntryRef,
            childIndex,
            childOrdinal: entry.ordinal,
            childEntryRef: entry.entryRef,
            sourcePlane: entry.sourcePlane,
            sourceKind: entry.sourceKind,
            sourceAddress: entry.sourceAddress,
            origin,
            scopeRef: entry.scopeRef,
          });
        }),
      ),
    );
    if (policyExcluded > 0) {
      exclusions.push({
        childCorpusRef: child.handle.identity.corpusRef,
        reason: "composite_policy",
        count: policyExcluded,
      });
    }
  }

  const composition: RlmCorpusComposition = {
    schemaId: RLM_COMPOSITION_SCHEMA_ID,
    children: children.map(({ child, childIndex }) => ({
      childIndex,
      corpusRef: child.handle.identity.corpusRef,
      contentDigest: child.handle.identity.contentDigest,
      manifestDigest: child.handle.identity.manifestDigest,
    })),
    policy,
    orderingRule: "composite_child_then_ordinal",
    exclusions,
  };
  const ordering = {
    rule: "composite_child_then_ordinal" as const,
    note: "Child array order, then child ordinal.",
  };
  const contentDigest = computeCompositeContentDigest({ scopeRef: input.scopeRef, composition });
  const aggregatedExclusions = [...new Set(exclusions.map((item) => item.reason))]
    .sort()
    .map((reason) => ({
      reason,
      count: exclusions
        .filter((item) => item.reason === reason)
        .reduce((sum, item) => sum + item.count, 0),
    }));
  const coverage = {
    note: "Composite coverage preserves child exclusions and composite policy exclusions.",
    entryCount: index.length,
    encodedBytes,
    exclusions: aggregatedExclusions,
  };
  const manifestDigest = computeManifestDigest({
    contentDigest,
    coverage,
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
    coverage,
    policy,
    scopeRef: input.scopeRef,
    composition,
  };

  const assertUnchanged = Effect.fn("RlmCompositeCorpusHandle.assertUnchanged")(function* () {
    for (const { child } of children) {
      if (!sameIdentity(child.expectedIdentity, child.handle.identity)) {
        return yield* new RlmCorpusError({
          reason: "changed",
          detailSafe: "composite child identity changed",
        });
      }
      yield* child.handle.assertUnchanged();
    }
  });

  const load = Effect.fn("RlmCompositeCorpusHandle.load")(function* (
    indexed: CompositeEntryIndex,
    maxCharsPerEntry: number,
  ) {
    const child = children[indexed.childIndex]!.child.handle;
    const entries = yield* child.read(
      { start: indexed.childOrdinal, endInclusive: indexed.childOrdinal },
      { maxEntries: 1, maxCharsPerEntry },
    );
    const entry = entries[0];
    if (entry === undefined || entry.entryRef !== indexed.childEntryRef) {
      return yield* new RlmCorpusError({
        reason: "changed",
        detailSafe: "composite child entry changed",
      });
    }
    return {
      ...entry,
      ordinal: indexed.globalOrdinal,
      entryRef: indexed.compositeEntryRef,
      sourceOrigin: indexed.origin,
    } satisfies RlmCorpusEntry;
  });

  const byAddress = new Map(index.map((item) => [addressKey(item.sourceAddress), item]));
  const validateIndexed = (
    item: CompositeEntryIndex | undefined,
    address: RlmSourceAddress,
    sourcePlane?: RlmSourcePlane,
  ): Effect.Effect<RlmValidatedSourceAddress, RlmCorpusError> => {
    if (
      item === undefined ||
      (sourcePlane !== undefined &&
        JSON.stringify(sourcePlane) !== JSON.stringify(item.sourcePlane))
    ) {
      return Effect.fail(
        new RlmCorpusError({
          reason: "invalid_address",
          detailSafe: "source address not in composite",
        }),
      );
    }
    return Effect.succeed({
      address,
      sourcePlane: item.sourcePlane,
      entryRef: item.compositeEntryRef,
      ordinal: item.globalOrdinal,
      origin: item.origin,
    });
  };

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
      const selected = index.slice(range.start, range.endInclusive + 1).slice(0, limits.maxEntries);
      return yield* Effect.forEach(selected, (item) => load(item, limits.maxCharsPerEntry), {
        concurrency: 1,
      });
    }),
    scan: (request) =>
      Stream.unwrap(
        assertUnchanged().pipe(
          Effect.as(
            Stream.fromIterable(
              index.slice(
                request.fromOrdinal ?? 0,
                (request.fromOrdinal ?? 0) + request.maxEntries,
              ),
            ).pipe(Stream.mapEffect((item) => load(item, Number.MAX_SAFE_INTEGER))),
          ),
        ),
      ),
    validateSourceAddress: (address, sourcePlane) =>
      assertUnchanged().pipe(
        Effect.flatMap(() =>
          validateIndexed(byAddress.get(addressKey(address)), address, sourcePlane),
        ),
      ),
    validateSourceLocator: (locator) => {
      const child = children.find(
        ({ child }) =>
          child.handle.identity.corpusRef === locator.corpusRef &&
          child.handle.identity.contentDigest === locator.contentDigest,
      );
      if (child === undefined) {
        return Effect.fail(
          new RlmCorpusError({
            reason: "invalid_address",
            detailSafe: "source locator child not in composite",
          }),
        );
      }
      return assertUnchanged().pipe(
        Effect.flatMap(() => child.child.handle.validateSourceLocator(locator)),
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
