import { Effect } from "effect";
import type { RlmCitation, RlmCorpusEntry, RlmSourceLocator } from "../schemas/corpus.ts";
import { RlmError } from "../schemas/errors.ts";
import { excerptDigest } from "./digest.ts";
import type { RlmCorpusHandle } from "./handle.ts";

export interface CitationValidation {
  readonly validated: ReadonlyArray<RlmCitation>;
  readonly invalid: ReadonlyArray<{ readonly citation: RlmCitation; readonly reason: string }>;
}

const sameLocator = (left: RlmSourceLocator, right: RlmSourceLocator): boolean =>
  left.corpusRef === right.corpusRef &&
  left.contentDigest === right.contentDigest &&
  left.entryRef === right.entryRef &&
  JSON.stringify(left.sourcePlane) === JSON.stringify(right.sourcePlane) &&
  left.sourceKind === right.sourceKind &&
  left.sourceAddress.addressSchemaId === right.sourceAddress.addressSchemaId &&
  left.sourceAddress.encodedAddress === right.sourceAddress.encodedAddress;

/** Validate citations by bounded source lookup. This function never materializes a corpus. */
export const validateCitations = (
  handle: RlmCorpusHandle,
  citations: ReadonlyArray<RlmCitation>,
): Effect.Effect<CitationValidation, RlmError> =>
  Effect.gen(function* () {
    const validated: Array<RlmCitation> = [];
    const invalid: Array<{ citation: RlmCitation; reason: string }> = [];
    yield* handle.assertUnchanged().pipe(
      Effect.mapError(
        (error) =>
          new RlmError({
            reason: error.reason === "changed" ? "corpus_changed" : "corpus_unavailable",
            retryable: false,
            ...(error.detailSafe === undefined ? {} : { detailSafe: error.detailSafe }),
          }),
      ),
    );

    for (const citation of citations) {
      if (citation.corpusRef !== handle.identity.corpusRef) {
        invalid.push({ citation, reason: "cross_corpus" });
        continue;
      }
      if (citation.contentDigest !== handle.identity.contentDigest) {
        invalid.push({ citation, reason: "digest_mismatch" });
        continue;
      }
      const lookup = yield* handle
        .validateSourceAddress(citation.sourceAddress, citation.sourcePlane)
        .pipe(Effect.option);
      if (lookup._tag === "None") {
        invalid.push({ citation, reason: "invalid_address" });
        continue;
      }
      if (
        lookup.value.entryRef !== citation.entryRefStart ||
        !sameLocator(lookup.value.origin, citation.sourceOrigin)
      ) {
        invalid.push({ citation, reason: "source_mismatch" });
        continue;
      }
      if (citation.entryRefEnd !== undefined && citation.entryRefEnd !== citation.entryRefStart) {
        invalid.push({ citation, reason: "unsupported_entry_range" });
        continue;
      }
      let supportingValid = true;
      for (const source of citation.supportingSources) {
        const result = yield* handle.validateSourceLocator(source).pipe(Effect.option);
        if (result._tag === "None") {
          supportingValid = false;
          break;
        }
      }
      if (!supportingValid) {
        invalid.push({ citation, reason: "invalid_supporting_source" });
        continue;
      }
      if (
        citation.excerpt !== undefined &&
        citation.excerptDigest !== undefined &&
        excerptDigest(citation.excerpt) !== citation.excerptDigest
      ) {
        invalid.push({ citation, reason: "excerpt_mismatch" });
        continue;
      }
      validated.push(citation);
    }
    return { validated, invalid };
  });

export const citationFromEntry = (
  handle: RlmCorpusHandle,
  entry: Pick<
    RlmCorpusEntry,
    | "entryRef"
    | "scopeRef"
    | "sourcePlane"
    | "sourceKind"
    | "sourceAddress"
    | "sourceOrigin"
    | "supportingSources"
    | "text"
  >,
): RlmCitation => {
  const sourceOrigin: RlmSourceLocator = entry.sourceOrigin ?? {
    sourcePlane: entry.sourcePlane,
    sourceKind: entry.sourceKind,
    sourceAddress: entry.sourceAddress,
    corpusRef: handle.identity.corpusRef,
    contentDigest: handle.identity.contentDigest,
    entryRef: entry.entryRef,
  };
  const excerpt = entry.text?.slice(0, 512);
  return {
    corpusRef: handle.identity.corpusRef,
    contentDigest: handle.identity.contentDigest,
    scopeRef: entry.scopeRef,
    sourcePlane: entry.sourcePlane,
    sourceAddress: entry.sourceAddress,
    sourceOrigin,
    supportingSources: entry.supportingSources ?? [],
    entryRefStart: entry.entryRef,
    ...(excerpt === undefined ? {} : { excerpt, excerptDigest: excerptDigest(excerpt) }),
  };
};
