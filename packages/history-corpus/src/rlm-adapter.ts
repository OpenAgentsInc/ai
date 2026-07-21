/**
 * History adapter for first-class RLM.
 * Re-exports generic RLM and notes that HistoryCorpusScope maps to RlmCorpusInput
 * via authorized host construction (never model-supplied scope alone).
 */
export * from "@openagentsinc/rlm";
export { HistoryCorpusScope, HistoryCorpusEntry, HistoryCorpusManifest } from "./corpus.ts";
export { HistoryRecall } from "./recall-tier-d.ts";
export { runRecursiveRecall } from "./recursive-recall.ts";
