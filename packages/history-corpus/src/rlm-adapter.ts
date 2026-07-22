import type { RlmInlineCorpusInputV2, RlmRedactionClass } from "@openagentsinc/rlm";
import { buildInlineCorpusInput, canonicalJson } from "@openagentsinc/rlm";

import type {
  HistoryCorpusEntry,
  HistoryCorpusManifest,
  HistoryCorpusPolicy,
  HistoryCorpusScope,
} from "./corpus.ts";

export const HISTORY_EVENT_ADDRESS_SCHEMA_ID = "openagents.history.event_address.v1" as const;
export const HISTORY_NOTE_ADDRESS_SCHEMA_ID = "openagents.history.note_address.v1" as const;

const scopeRef = (scope: HistoryCorpusScope): string => {
  switch (scope._tag) {
    case "Thread":
      return scope.threadId;
    case "Run":
      return scope.runRef;
    case "ThreadSet":
      return `threadset.${[...scope.threadIds].sort().join(".")}`;
  }
};

const redactionClass = (value: HistoryCorpusEntry["redactionClass"]): RlmRedactionClass => {
  switch (value) {
    case "public_ref":
      return "none";
    case "operator_summary":
    case "redacted_summary":
      return "redacted";
    case "private_ref":
      return "private_ref";
  }
};

const policyRedactionClasses = (policy: HistoryCorpusPolicy): ReadonlyArray<RlmRedactionClass> =>
  [...new Set(policy.includeRedactionClasses.map(redactionClass))].sort();

/** Convert a built history corpus into the generic RLM v2 inline contract. */
export const historyCorpusToRlmInput = (input: {
  readonly manifest: HistoryCorpusManifest;
  readonly entries: ReadonlyArray<HistoryCorpusEntry>;
}): RlmInlineCorpusInputV2 =>
  buildInlineCorpusInput({
    corpusRef: input.manifest.corpusRef,
    scopeRef: scopeRef(input.manifest.scope),
    orderingRule: "chronological",
    orderingNote: "History order is scope ref, turn id, then source sequence.",
    coverageNote: input.manifest.coverage.note,
    exclusions: [
      {
        reason: "history_visibility_policy",
        count: input.manifest.exclusions.excludedByVisibility,
      },
      {
        reason: "history_redaction_policy",
        count: input.manifest.exclusions.excludedByRedaction,
      },
    ],
    policy: {
      includeVisibilities: input.manifest.exclusions.policy.includeVisibilities,
      includeRedactionClasses: policyRedactionClasses(input.manifest.exclusions.policy),
    },
    entries: input.entries.map((entry) => {
      const isNote = entry.kind === "thread.note";
      return {
        entryRef: `history.${entry.scopeRef}.${entry.turnId}.${entry.sequence}`,
        scopeRef: entry.scopeRef,
        sourcePlane: isNote ? ("thread_snapshot" as const) : ("event_log" as const),
        sourceKind: isNote ? "neutral_thread_note" : entry.kind,
        sourceAddress: {
          addressSchemaId: isNote
            ? HISTORY_NOTE_ADDRESS_SCHEMA_ID
            : HISTORY_EVENT_ADDRESS_SCHEMA_ID,
          encodedAddress: canonicalJson({
            scopeRef: entry.scopeRef,
            turnId: entry.turnId,
            sequence: entry.sequence,
          }),
        },
        ...(entry.text === undefined ? {} : { text: entry.text }),
        visibility: entry.visibility,
        redactionClass: redactionClass(entry.redactionClass),
        observedAt: entry.observedAt,
      };
    }),
  });

export * from "@openagentsinc/rlm";
export { HistoryCorpusScope, HistoryCorpusEntry, HistoryCorpusManifest } from "./corpus.ts";
export { HistoryRecall } from "./recall-tier-d.ts";
export { runRecursiveRecall } from "./recursive-recall.ts";
