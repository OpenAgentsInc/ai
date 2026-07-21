import { Effect } from "effect";
import type { RlmCitation } from "../schemas/corpus.ts";
import { RlmError } from "../schemas/errors.ts";
import { excerptDigest } from "./digest.ts";
import type { RlmCorpusHandle } from "./handle.ts";

export interface CitationValidation {
  readonly validated: ReadonlyArray<RlmCitation>;
  readonly invalid: ReadonlyArray<{ readonly citation: RlmCitation; readonly reason: string }>;
}

export const validateCitations = (
  handle: RlmCorpusHandle,
  citations: ReadonlyArray<RlmCitation>,
): Effect.Effect<CitationValidation, RlmError> =>
  Effect.gen(function* () {
    const validated: Array<RlmCitation> = [];
    const invalid: Array<{ citation: RlmCitation; reason: string }> = [];
    const entries = yield* handle.materializeAll().pipe(
      Effect.mapError(
        (e) =>
          new RlmError({
            reason: "corpus_unavailable",
            retryable: false,
            ...(e.detailSafe !== undefined ? { detailSafe: e.detailSafe } : {}),
          }),
      ),
    );
    const byEntry = new Map(entries.map((e) => [e.entryRef, e] as const));

    for (const citation of citations) {
      if (citation.corpusRef !== handle.identity.corpusRef) {
        invalid.push({ citation, reason: "cross_corpus" });
        continue;
      }
      if (citation.contentDigest !== handle.identity.contentDigest) {
        invalid.push({ citation, reason: "digest_mismatch" });
        continue;
      }
      const start = byEntry.get(citation.entryRefStart);
      if (start === undefined) {
        invalid.push({ citation, reason: "dangling_entry" });
        continue;
      }
      if (citation.entryRefEnd !== undefined && !byEntry.has(citation.entryRefEnd)) {
        invalid.push({ citation, reason: "dangling_entry_end" });
        continue;
      }
      if (citation.excerpt !== undefined && citation.excerptDigest !== undefined) {
        if (excerptDigest(citation.excerpt) !== citation.excerptDigest) {
          invalid.push({ citation, reason: "excerpt_mismatch" });
          continue;
        }
      }
      validated.push(citation);
    }
    return { validated, invalid };
  });

export const citationFromEntry = (
  handle: RlmCorpusHandle,
  entry: {
    readonly entryRef: string;
    readonly scopeRef: string;
    readonly sourceAddress: RlmCitation["sourceAddress"];
    readonly text?: string;
  },
): RlmCitation => ({
  corpusRef: handle.identity.corpusRef,
  contentDigest: handle.identity.contentDigest,
  scopeRef: entry.scopeRef,
  sourceAddress: entry.sourceAddress,
  entryRefStart: entry.entryRef,
  ...(entry.text !== undefined
    ? { excerpt: entry.text.slice(0, 512), excerptDigest: excerptDigest(entry.text.slice(0, 512)) }
    : {}),
});
