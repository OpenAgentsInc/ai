import { Effect, Stream } from "effect";
import type { RlmCorpusEntry } from "../schemas/corpus.ts";
import type {
  RlmDeterministicLimits,
  RlmDeterministicOperation,
  RlmFinding,
} from "../schemas/request-result.ts";
import { RlmError } from "../schemas/errors.ts";
import { citationFromEntry } from "../corpus/citations.ts";
import type { RlmCorpusHandle } from "../corpus/handle.ts";

export interface DeterministicObservation {
  readonly findings: ReadonlyArray<RlmFinding>;
  readonly entriesScanned: number;
  readonly capsHit: ReadonlyArray<string>;
  readonly observationText: string;
}

const corpusError = (detailSafe?: string): RlmError =>
  new RlmError({
    reason: "corpus_unavailable",
    retryable: false,
    ...(detailSafe === undefined ? {} : { detailSafe }),
  });

/** Collect at most maxEntries from a bounded corpus scan. */
export const collectBoundedScan = (
  handle: RlmCorpusHandle,
  maxEntries: number,
): Effect.Effect<ReadonlyArray<RlmCorpusEntry>, RlmError> =>
  handle.scan({ maxEntries }).pipe(
    Stream.runCollect,
    Effect.map((entries) => [...entries]),
    Effect.mapError((error) => corpusError(error.detailSafe)),
  );

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const runDeterministicOperation = (
  handle: RlmCorpusHandle,
  operation: RlmDeterministicOperation,
  limits: RlmDeterministicLimits,
): Effect.Effect<DeterministicObservation, RlmError> =>
  Effect.gen(function* () {
    const capsHit: Array<string> = [];
    let scanned = 0;
    const findings: Array<RlmFinding> = [];

    const takeScan = (list: ReadonlyArray<RlmCorpusEntry>) => {
      const out: Array<RlmCorpusEntry> = [];
      for (const e of list) {
        if (scanned >= limits.maxEntriesScanned) {
          capsHit.push("maxEntriesScanned");
          break;
        }
        scanned += 1;
        out.push(e);
      }
      return out;
    };

    switch (operation._tag) {
      case "Grep": {
        const entries = yield* collectBoundedScan(handle, limits.maxEntriesScanned);
        if (handle.manifest.coverage.entryCount > limits.maxEntriesScanned) {
          capsHit.push("maxEntriesScanned");
        }
        let re: RegExp;
        try {
          re = new RegExp(operation.pattern, operation.caseSensitive === false ? "i" : "");
        } catch {
          return yield* new RlmError({
            reason: "operation_contract_violation",
            retryable: false,
            detailSafe: "invalid regex pattern",
          });
        }
        for (const entry of takeScan(entries)) {
          if (findings.length >= limits.maxSpans) {
            capsHit.push("maxSpans");
            break;
          }
          const text = entry.text ?? "";
          if (!re.test(text)) continue;
          const excerpt = text.slice(0, limits.maxCharsPerSpan);
          findings.push({
            entryRef: entry.entryRef,
            ordinal: entry.ordinal,
            excerpt,
            citation: citationFromEntry(handle, { ...entry, text: excerpt }),
          });
        }
        break;
      }
      case "OrdinalSlice": {
        if (operation.start > operation.endInclusive) {
          return yield* new RlmError({
            reason: "operation_contract_violation",
            retryable: false,
            detailSafe: "OrdinalSlice start > endInclusive",
          });
        }
        const requestedCount = operation.endInclusive - operation.start + 1;
        const allowedCount = Math.min(requestedCount, limits.maxEntriesScanned);
        const entries = yield* handle
          .read(
            { start: operation.start, endInclusive: operation.endInclusive },
            { maxEntries: allowedCount, maxCharsPerEntry: limits.maxCharsPerSpan },
          )
          .pipe(Effect.mapError((error) => corpusError(error.detailSafe)));
        if (requestedCount > allowedCount) capsHit.push("maxEntriesScanned");
        for (const entry of takeScan(entries)) {
          if (findings.length >= limits.maxSpans) {
            capsHit.push("maxSpans");
            break;
          }
          const excerpt = (entry.text ?? "").slice(0, limits.maxCharsPerSpan);
          findings.push({
            entryRef: entry.entryRef,
            ordinal: entry.ordinal,
            excerpt,
            citation: citationFromEntry(handle, { ...entry, text: excerpt }),
          });
        }
        break;
      }
      case "InspectMetadata": {
        const observationText = JSON.stringify({
          corpusRef: handle.identity.corpusRef,
          contentDigest: handle.identity.contentDigest,
          entryCount: handle.manifest.coverage.entryCount,
          encodedBytes: handle.manifest.coverage.encodedBytes,
          ordering: handle.manifest.ordering.rule,
          exclusions: handle.manifest.coverage.exclusions,
        });
        return {
          findings: [],
          entriesScanned: 0,
          capsHit: [],
          observationText: observationText.slice(0, limits.maxObservationChars),
        };
      }
    }

    const observationText = findings
      .map((f) => `[${f.ordinal}] ${f.excerpt}`)
      .join("\n")
      .slice(0, limits.maxObservationChars);
    if (findings.map((f) => f.excerpt).join("\n").length > limits.maxObservationChars) {
      capsHit.push("maxObservationChars");
    }

    return {
      findings,
      entriesScanned: scanned,
      capsHit: [...new Set(capsHit)],
      observationText,
    };
  });

/** Pure string match helper for operator registry (no Effect). */
export const grepEntries = (
  entries: ReadonlyArray<RlmCorpusEntry>,
  pattern: string,
  caseSensitive: boolean,
  limits: { maxScan: number; maxHits: number },
): { hits: ReadonlyArray<RlmCorpusEntry>; scanned: number } => {
  const re = new RegExp(escapeRegExp(pattern).replace(/\\\*/g, ".*"), caseSensitive ? "" : "i");
  const hits: Array<RlmCorpusEntry> = [];
  let scanned = 0;
  for (const e of entries) {
    if (scanned >= limits.maxScan) break;
    scanned += 1;
    if (re.test(e.text ?? "")) {
      hits.push(e);
      if (hits.length >= limits.maxHits) break;
    }
  }
  return { hits, scanned };
};
