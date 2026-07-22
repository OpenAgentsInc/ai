import { Effect, Stream } from "effect";
import type {
  RlmCorpusEntry,
  RlmCorpusIdentity,
  RlmCorpusInput,
  RlmCorpusInputV1,
  RlmCorpusManifest,
  RlmCorpusPolicy,
  RlmOrdinalRange,
  RlmReadLimits,
  RlmScanRequest,
  RlmSourceAddress,
  RlmSourceLocator,
  RlmSourcePlane,
} from "../schemas/corpus.ts";
import { RLM_CORPUS_SCHEMA_ID } from "../schemas/corpus.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import { computeContentDigest, computeManifestDigest } from "./digest.ts";

/** Hard encoded-byte ceiling for inline corpora (4 MiB). */
export const INLINE_CORPUS_BYTE_CEILING = 4 * 1024 * 1024;

export const RLM_ALL_VISIBILITIES = ["public", "operator", "private"] as const;
export const RLM_ALL_REDACTION_CLASSES = ["none", "private_ref", "redacted", "secret"] as const;

const uniqueSorted = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  [...new Set(values)].sort();

/** Return the canonical set encoding used by corpus and composition digests. */
export const canonicalizeRlmCorpusPolicy = (policy: RlmCorpusPolicy): RlmCorpusPolicy => ({
  includeVisibilities: uniqueSorted(policy.includeVisibilities),
  includeRedactionClasses: uniqueSorted(policy.includeRedactionClasses),
});

export interface RlmValidatedSourceAddress {
  readonly address: RlmSourceAddress;
  readonly sourcePlane: RlmSourcePlane;
  readonly entryRef: string;
  readonly ordinal: number;
  readonly origin: RlmSourceLocator;
}

export interface RlmCorpusHandle {
  readonly identity: RlmCorpusIdentity;
  readonly manifest: RlmCorpusManifest;
  readonly assertUnchanged: () => Effect.Effect<void, RlmCorpusError>;
  readonly read: (
    range: RlmOrdinalRange,
    limits: RlmReadLimits,
  ) => Effect.Effect<ReadonlyArray<RlmCorpusEntry>, RlmCorpusError>;
  readonly scan: (request: RlmScanRequest) => Stream.Stream<RlmCorpusEntry, RlmCorpusError>;
  readonly validateSourceAddress: (
    address: RlmSourceAddress,
    sourcePlane?: RlmSourcePlane,
  ) => Effect.Effect<RlmValidatedSourceAddress, RlmCorpusError>;
  readonly validateSourceLocator: (
    locator: RlmSourceLocator,
  ) => Effect.Effect<RlmValidatedSourceAddress, RlmCorpusError>;
  /** Compatibility helper for small corpora. Engine paths do not require it. */
  readonly materializeAll: () => Effect.Effect<ReadonlyArray<RlmCorpusEntry>, RlmCorpusError>;
}

export interface RlmInlineCorpusInputV2 {
  readonly _tag: "Inline";
  readonly manifest: RlmCorpusManifest;
  readonly entries: ReadonlyArray<RlmCorpusEntry>;
}

const encodedBytesOf = (entries: ReadonlyArray<RlmCorpusEntry>): number =>
  new TextEncoder().encode(entries.map((entry) => JSON.stringify(entry)).join("\n")).length;

const addressKey = (address: RlmSourceAddress): string =>
  `${address.addressSchemaId}\u0000${address.encodedAddress}`;

const planeKey = (plane: RlmSourcePlane): string =>
  typeof plane === "string" ? plane : `${plane.registrySchemaId}:${plane.plane}`;

const locatorFor = (identity: RlmCorpusIdentity, entry: RlmCorpusEntry): RlmSourceLocator =>
  entry.sourceOrigin ?? {
    sourcePlane: entry.sourcePlane,
    sourceKind: entry.sourceKind,
    sourceAddress: entry.sourceAddress,
    corpusRef: identity.corpusRef,
    contentDigest: identity.contentDigest,
    entryRef: entry.entryRef,
  };

const isV2Inline = (input: Extract<RlmCorpusInput, { readonly _tag: "Inline" }>): boolean =>
  input.manifest.schemaId === RLM_CORPUS_SCHEMA_ID;

export const makeInlineCorpusHandle = (
  input: Extract<RlmCorpusInput, { readonly _tag: "Inline" }>,
): Effect.Effect<RlmCorpusHandle, RlmCorpusError> =>
  Effect.gen(function* () {
    if (!isV2Inline(input)) {
      return yield* new RlmCorpusError({
        reason: "legacy_requires_migration",
        detailSafe: "RLM corpus v1 requires migrateRlmCorpusV1 before resolution",
      });
    }
    const { manifest, entries } = input as RlmInlineCorpusInputV2;
    const bytes = encodedBytesOf(entries);
    if (bytes > INLINE_CORPUS_BYTE_CEILING) {
      return yield* new RlmCorpusError({
        reason: "byte_ceiling",
        detailSafe: `inline corpus exceeds ${INLINE_CORPUS_BYTE_CEILING} encoded bytes`,
      });
    }

    const entryRefs = new Set<string>();
    const addressKeys = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.ordinal !== index) {
        return yield* new RlmCorpusError({
          reason: "invalid_inline",
          detailSafe: `non-contiguous ordinal at index ${index}`,
        });
      }
      if (entryRefs.has(entry.entryRef)) {
        return yield* new RlmCorpusError({
          reason: "duplicate_source",
          detailSafe: "duplicate entry ref in inline corpus",
        });
      }
      entryRefs.add(entry.entryRef);
      const key = addressKey(entry.sourceAddress);
      if (addressKeys.has(key)) {
        return yield* new RlmCorpusError({
          reason: "duplicate_source",
          detailSafe: "duplicate source address in inline corpus",
        });
      }
      addressKeys.add(key);
    }

    const contentDigest = computeContentDigest({
      scopeRef: manifest.scopeRef,
      ordering: manifest.ordering,
      entries,
    });
    const coverage = { ...manifest.coverage, entryCount: entries.length, encodedBytes: bytes };
    const manifestDigest = computeManifestDigest({
      contentDigest,
      coverage,
      policy: manifest.policy,
      scopeRef: manifest.scopeRef,
      ordering: manifest.ordering,
      ...(manifest.composition === undefined ? {} : { composition: manifest.composition }),
    });
    if (manifest.contentDigest !== contentDigest || manifest.manifestDigest !== manifestDigest) {
      return yield* new RlmCorpusError({
        reason: "invalid_inline",
        detailSafe: "inline corpus digest mismatch",
      });
    }

    const identity: RlmCorpusIdentity = {
      schemaId: RLM_CORPUS_SCHEMA_ID,
      corpusRef: manifest.corpusRef,
      contentDigest,
      manifestDigest,
    };
    const fixedManifest: RlmCorpusManifest = { ...manifest, coverage };
    const byAddress = new Map(entries.map((entry) => [addressKey(entry.sourceAddress), entry]));

    const validateEntry = (
      entry: RlmCorpusEntry | undefined,
      address: RlmSourceAddress,
      sourcePlane?: RlmSourcePlane,
    ): Effect.Effect<RlmValidatedSourceAddress, RlmCorpusError> => {
      if (
        entry === undefined ||
        (sourcePlane !== undefined && planeKey(entry.sourcePlane) !== planeKey(sourcePlane))
      ) {
        return Effect.fail(
          new RlmCorpusError({
            reason: "invalid_address",
            detailSafe: "source address not in corpus",
          }),
        );
      }
      return Effect.succeed({
        address,
        sourcePlane: entry.sourcePlane,
        entryRef: entry.entryRef,
        ordinal: entry.ordinal,
        origin: locatorFor(identity, entry),
      });
    };

    return {
      identity,
      manifest: fixedManifest,
      assertUnchanged: () => Effect.void,
      read: Effect.fn("RlmCorpusHandle.read")(function* (range, limits) {
        if (range.start > range.endInclusive) {
          return yield* new RlmCorpusError({
            reason: "invalid_range",
            detailSafe: "start > endInclusive",
          });
        }
        return entries
          .slice(range.start, range.endInclusive + 1)
          .slice(0, limits.maxEntries)
          .map((entry) => ({
            ...entry,
            ...(entry.text !== undefined && entry.text.length > limits.maxCharsPerEntry
              ? { text: entry.text.slice(0, limits.maxCharsPerEntry) }
              : {}),
          }));
      }),
      scan: (request) =>
        Stream.fromIterable(
          entries.slice(request.fromOrdinal ?? 0, (request.fromOrdinal ?? 0) + request.maxEntries),
        ),
      validateSourceAddress: (address, sourcePlane) =>
        validateEntry(byAddress.get(addressKey(address)), address, sourcePlane),
      validateSourceLocator: (locator) => {
        if (
          locator.corpusRef !== identity.corpusRef ||
          locator.contentDigest !== identity.contentDigest
        ) {
          return Effect.fail(
            new RlmCorpusError({
              reason: "invalid_address",
              detailSafe: "source locator digest mismatch",
            }),
          );
        }
        return validateEntry(
          byAddress.get(addressKey(locator.sourceAddress)),
          locator.sourceAddress,
          locator.sourcePlane,
        ).pipe(
          Effect.flatMap((validated) =>
            validated.origin.entryRef === locator.entryRef
              ? Effect.succeed(validated)
              : Effect.fail(
                  new RlmCorpusError({
                    reason: "invalid_address",
                    detailSafe: "source locator entry mismatch",
                  }),
                ),
          ),
        );
      },
      materializeAll: () => Effect.succeed(entries),
    } satisfies RlmCorpusHandle;
  });

export interface BuildInlineCorpusInput {
  readonly corpusRef: string;
  readonly scopeRef: string;
  readonly entries: ReadonlyArray<
    Omit<RlmCorpusEntry, "ordinal" | "entryRef" | "sourcePlane"> & {
      readonly entryRef?: string;
      readonly sourcePlane?: RlmSourcePlane;
    }
  >;
  readonly policy?: RlmCorpusPolicy;
  readonly orderingRule?: "chronological" | "source_declared" | "explicit_array";
  readonly orderingNote?: string;
  readonly coverageNote?: string;
  readonly exclusions?: RlmCorpusManifest["coverage"]["exclusions"];
}

/** Build a canonical v2 inline corpus. The optional plane default preserves source compatibility. */
export const buildInlineCorpusInput = (input: BuildInlineCorpusInput): RlmInlineCorpusInputV2 => {
  const entries: Array<RlmCorpusEntry> = input.entries.map((entry, ordinal) => ({
    ordinal,
    entryRef: entry.entryRef ?? `entry.${ordinal}`,
    scopeRef: entry.scopeRef,
    sourcePlane: entry.sourcePlane ?? "evidence_pack",
    sourceKind: entry.sourceKind,
    sourceAddress: entry.sourceAddress,
    ...(entry.sourceOrigin === undefined ? {} : { sourceOrigin: entry.sourceOrigin }),
    ...(entry.supportingSources === undefined
      ? {}
      : { supportingSources: entry.supportingSources }),
    ...(entry.text === undefined ? {} : { text: entry.text }),
    visibility: entry.visibility,
    redactionClass: entry.redactionClass,
    ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
  }));
  const ordering = {
    rule: input.orderingRule ?? ("explicit_array" as const),
    ...(input.orderingNote === undefined ? {} : { note: input.orderingNote }),
  };
  const policy = canonicalizeRlmCorpusPolicy(
    input.policy ?? {
      includeVisibilities: [...RLM_ALL_VISIBILITIES],
      includeRedactionClasses: [...RLM_ALL_REDACTION_CLASSES],
    },
  );
  const contentDigest = computeContentDigest({ scopeRef: input.scopeRef, ordering, entries });
  const coverage = {
    note: input.coverageNote ?? "inline authorized corpus",
    entryCount: entries.length,
    encodedBytes: encodedBytesOf(entries),
    exclusions: input.exclusions ?? [],
  };
  const manifestDigest = computeManifestDigest({
    contentDigest,
    coverage,
    policy,
    scopeRef: input.scopeRef,
    ordering,
  });
  return {
    _tag: "Inline",
    manifest: {
      schemaId: RLM_CORPUS_SCHEMA_ID,
      corpusRef: input.corpusRef,
      contentDigest,
      manifestDigest,
      ordering,
      coverage,
      policy,
      scopeRef: input.scopeRef,
    },
    entries,
  };
};

/** Explicitly migrate v1 bytes. The caller must classify the source and authorize policy. */
export const migrateRlmCorpusV1 = (
  input: Extract<RlmCorpusInputV1, { readonly _tag: "Inline" }>,
  options: { readonly sourcePlane: RlmSourcePlane; readonly policy: RlmCorpusPolicy },
): RlmInlineCorpusInputV2 =>
  buildInlineCorpusInput({
    corpusRef: input.manifest.corpusRef,
    scopeRef: input.manifest.scopeRef,
    entries: input.entries.map((entry) => ({
      entryRef: entry.entryRef,
      scopeRef: entry.scopeRef,
      sourcePlane: options.sourcePlane,
      sourceKind: entry.sourceKind,
      sourceAddress: entry.sourceAddress,
      ...(entry.text === undefined ? {} : { text: entry.text }),
      visibility: entry.visibility,
      redactionClass: entry.redactionClass,
      ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
    })),
    policy: options.policy,
    orderingRule:
      input.manifest.ordering.rule === "composite_child_then_ordinal"
        ? "explicit_array"
        : input.manifest.ordering.rule,
    ...(input.manifest.ordering.note === undefined
      ? {}
      : { orderingNote: input.manifest.ordering.note }),
    coverageNote: input.manifest.coverage.note,
    exclusions: input.manifest.coverage.exclusions,
  });
