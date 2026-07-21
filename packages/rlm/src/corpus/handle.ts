import { Effect, Stream } from "effect";
import type {
  RlmCorpusEntry,
  RlmCorpusIdentity,
  RlmCorpusInput,
  RlmCorpusManifest,
  RlmOrdinalRange,
  RlmReadLimits,
  RlmScanRequest,
  RlmSourceAddress,
} from "../schemas/corpus.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import { computeContentDigest, computeManifestDigest } from "./digest.ts";

/** Hard encoded-byte ceiling for inline corpora (4 MiB). */
export const INLINE_CORPUS_BYTE_CEILING = 4 * 1024 * 1024;

export interface RlmValidatedSourceAddress {
  readonly address: RlmSourceAddress;
  readonly entryRef: string;
  readonly ordinal: number;
}

export interface RlmCorpusHandle {
  readonly identity: RlmCorpusIdentity;
  readonly manifest: RlmCorpusManifest;
  readonly read: (
    range: RlmOrdinalRange,
    limits: RlmReadLimits,
  ) => Effect.Effect<ReadonlyArray<RlmCorpusEntry>, RlmCorpusError>;
  readonly scan: (request: RlmScanRequest) => Stream.Stream<RlmCorpusEntry, RlmCorpusError>;
  readonly validateSourceAddress: (
    address: RlmSourceAddress,
  ) => Effect.Effect<RlmValidatedSourceAddress, RlmCorpusError>;
  /** All entries for hermetic small corpora only — never for out-of-core. */
  readonly materializeAll: () => Effect.Effect<ReadonlyArray<RlmCorpusEntry>, RlmCorpusError>;
}

const encodedBytesOf = (entries: ReadonlyArray<RlmCorpusEntry>): number =>
  entries.reduce((sum, e) => sum + (e.text?.length ?? 0) + e.entryRef.length + 64, 0);

export const makeInlineCorpusHandle = (
  input: Extract<RlmCorpusInput, { readonly _tag: "Inline" }>,
): Effect.Effect<RlmCorpusHandle, RlmCorpusError> =>
  Effect.gen(function* () {
    const { manifest, entries } = input;
    const bytes = encodedBytesOf(entries);
    if (bytes > INLINE_CORPUS_BYTE_CEILING) {
      return yield* new RlmCorpusError({
        reason: "byte_ceiling",
        detailSafe: `inline corpus exceeds ${INLINE_CORPUS_BYTE_CEILING} encoded bytes`,
      });
    }
    // Contiguous ordinals from 0
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.ordinal !== i) {
        return yield* new RlmCorpusError({
          reason: "invalid_inline",
          detailSafe: `non-contiguous ordinal at index ${i}`,
        });
      }
    }
    const contentDigest = computeContentDigest({
      scopeRef: manifest.scopeRef,
      ordering: manifest.ordering,
      entries,
    });
    const manifestDigest = computeManifestDigest({
      contentDigest,
      coverage: {
        ...manifest.coverage,
        entryCount: entries.length,
        encodedBytes: bytes,
      },
      scopeRef: manifest.scopeRef,
      ordering: manifest.ordering,
    });
    if (manifest.contentDigest !== contentDigest) {
      return yield* new RlmCorpusError({
        reason: "invalid_inline",
        detailSafe: "contentDigest mismatch",
      });
    }
    if (manifest.manifestDigest !== manifestDigest) {
      return yield* new RlmCorpusError({
        reason: "invalid_inline",
        detailSafe: "manifestDigest mismatch",
      });
    }

    const byEntryRef = new Map(entries.map((e) => [e.entryRef, e] as const));
    const byAddress = new Map<string, (typeof entries)[number]>(
      entries.map((e) => [
        `${e.sourceAddress.addressSchemaId}|${e.sourceAddress.encodedAddress}`,
        e,
      ]),
    );

    const identity: RlmCorpusIdentity = {
      schemaId: "openagents.ai.rlm_corpus.v1",
      corpusRef: manifest.corpusRef,
      contentDigest,
      manifestDigest,
    };

    const fixedManifest: RlmCorpusManifest = {
      ...manifest,
      contentDigest,
      manifestDigest,
      coverage: {
        ...manifest.coverage,
        entryCount: entries.length,
        encodedBytes: bytes,
      },
    };

    const handle: RlmCorpusHandle = {
      identity,
      manifest: fixedManifest,
      read: (range, limits) =>
        Effect.gen(function* () {
          if (range.start > range.endInclusive) {
            return yield* new RlmCorpusError({
              reason: "invalid_range",
              detailSafe: "start > endInclusive",
            });
          }
          const slice = entries
            .filter((e) => e.ordinal >= range.start && e.ordinal <= range.endInclusive)
            .slice(0, limits.maxEntries)
            .map((e) => ({
              ...e,
              ...(e.text !== undefined && e.text.length > limits.maxCharsPerEntry
                ? { text: e.text.slice(0, limits.maxCharsPerEntry) }
                : {}),
            }));
          return slice;
        }),
      scan: (request) =>
        Stream.fromIterable(
          entries
            .filter((e) => e.ordinal >= (request.fromOrdinal ?? 0))
            .slice(0, request.maxEntries),
        ),
      validateSourceAddress: (address) =>
        Effect.gen(function* () {
          const key = `${address.addressSchemaId}|${address.encodedAddress}`;
          const entry = byAddress.get(key);
          if (entry === undefined) {
            return yield* new RlmCorpusError({
              reason: "invalid_address",
              detailSafe: "source address not in corpus",
            });
          }
          return {
            address,
            entryRef: entry.entryRef,
            ordinal: entry.ordinal,
          };
        }),
      materializeAll: () => Effect.succeed(entries),
    };
    return handle;
  });

/** Build a canonical inline corpus from entries (computes digests). */
export const buildInlineCorpusInput = (input: {
  readonly corpusRef: string;
  readonly scopeRef: string;
  readonly entries: ReadonlyArray<
    Omit<RlmCorpusEntry, "ordinal" | "entryRef"> & {
      readonly entryRef?: string;
    }
  >;
  readonly orderingNote?: string;
}): Extract<RlmCorpusInput, { readonly _tag: "Inline" }> => {
  const entries: Array<RlmCorpusEntry> = input.entries.map((e, ordinal) => ({
    ordinal,
    entryRef: e.entryRef ?? `entry.${ordinal}`,
    scopeRef: e.scopeRef,
    sourceKind: e.sourceKind,
    sourceAddress: e.sourceAddress,
    ...(e.text !== undefined ? { text: e.text } : {}),
    visibility: e.visibility,
    redactionClass: e.redactionClass,
    ...(e.observedAt !== undefined ? { observedAt: e.observedAt } : {}),
  }));
  const ordering = {
    rule: "explicit_array" as const,
    ...(input.orderingNote !== undefined ? { note: input.orderingNote } : {}),
  };
  const contentDigest = computeContentDigest({
    scopeRef: input.scopeRef,
    ordering,
    entries,
  });
  const coverage = {
    note: "inline hermetic corpus",
    entryCount: entries.length,
    encodedBytes: encodedBytesOf(entries),
    exclusions: [] as const,
  };
  const manifestDigest = computeManifestDigest({
    contentDigest,
    coverage,
    scopeRef: input.scopeRef,
    ordering,
  });
  return {
    _tag: "Inline",
    manifest: {
      schemaId: "openagents.ai.rlm_corpus.v1",
      corpusRef: input.corpusRef,
      contentDigest,
      manifestDigest,
      ordering,
      coverage,
      scopeRef: input.scopeRef,
    },
    entries,
  };
};
