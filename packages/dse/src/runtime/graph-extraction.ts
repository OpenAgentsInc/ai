import { Effect, Result, Schema as S } from "effect";
import {
  buildGraphCorpus,
  makeCanonicalEntity,
  makeGraphMention,
  makeGraphRelation,
  makeMergeEvidence,
  GraphDerivation as GraphDerivationSchema,
  type BuiltGraphCorpus,
  type GraphCorpusPolicy,
  type GraphDerivation,
} from "@openagentsinc/graph-corpus";

import {
  GRAPH_EXTRACTION_RECEIPT_SCHEMA_ID,
  GRAPH_EXTRACTION_SIGNATURE_ID,
  GraphExtractionCandidates,
  GraphExtractionLimits,
  GraphExtractionRunReceipt,
  compiledProgramDigest,
  graphExtractionSignature,
  type CompiledProgram,
  type DseTimestamp,
  type GraphExtractionAttemptReceipt,
  type GraphExtractionParserAttemptReceipt,
  type GraphExtractionCorpus,
  type GraphExtractionCorpusEntry,
  type GraphExtractionReason,
  type GraphExtractionRunStatus,
  type GraphExtractionUsage,
} from "../contract/index.js";
import { canonicalDigest, canonicalStringify } from "../internal/canonical.js";

const decodeCandidates = S.decodeUnknownResult(GraphExtractionCandidates);
const decodeLimits = S.decodeUnknownSync(GraphExtractionLimits);
const decodeReceipt = S.decodeUnknownSync(GraphExtractionRunReceipt);
const decodeDerivation = S.decodeUnknownSync(GraphDerivationSchema);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const uniqueSorted = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  [...new Set(values)].sort(compareText);
const safeRef = (prefix: string, value: unknown): string => `${prefix}.${canonicalDigest(value)}`;

export class GraphExtractionError extends S.TaggedErrorClass<GraphExtractionError>()(
  "dse/GraphExtractionError",
  {
    reason: S.Literals(["invalid_corpus", "invalid_candidate", "model_failed", "time_cap"]),
    detailSafe: S.String.check(S.isMaxLength(512)),
  },
) {}

export class GraphExtractionModelError extends S.TaggedErrorClass<GraphExtractionModelError>()(
  "dse/GraphExtractionModelError",
  { reason: S.String.check(S.isMaxLength(512)) },
) {}

export interface GraphExtractionModelCompletion {
  readonly text: string;
  readonly modelIdentity: string;
  readonly usage: GraphExtractionUsage;
}

export interface GraphExtractionMessageEnvelope {
  readonly trusted: {
    readonly system: string;
    readonly instruction: string;
    readonly toolPolicy: string;
    readonly outputFormat: string;
    readonly fewShotExampleIds: ReadonlyArray<string>;
  };
  readonly untrustedContext: string;
  readonly repairInstruction: string;
}

/** Host-injected model. This port selects no provider, credential, or spend. */
export interface GraphExtractionModel {
  readonly complete: (input: {
    readonly message: {
      readonly envelope: GraphExtractionMessageEnvelope;
      readonly canonicalBytes: string;
      readonly digest: string;
      readonly tokenCount: number;
    };
    readonly remainingInputTokens: number;
    readonly maxOutputCharacters: number;
    readonly maxOutputTokens: number;
  }) => Effect.Effect<GraphExtractionModelCompletion, GraphExtractionModelError>;
}

export interface GraphExtractionRuntimeDeps {
  readonly countTokens: (text: string) => number;
  readonly monotonicMs: () => number;
  readonly now: () => DseTimestamp;
  readonly assertCorpusUnchanged: (
    corpus: GraphExtractionCorpus,
  ) => Effect.Effect<string, GraphExtractionError>;
}

export interface GraphExtractionBatch {
  readonly batchRef: string;
  readonly entries: ReadonlyArray<GraphExtractionCorpusEntry>;
  readonly characters: number;
  readonly inputTokens: number;
}

export interface GraphExtractionBatchPlan {
  readonly batches: ReadonlyArray<GraphExtractionBatch>;
  readonly admittedEntries: number;
  readonly excludedEntries: number;
  readonly characters: number;
  readonly inputTokens: number;
  readonly reasons: ReadonlyArray<GraphExtractionReason>;
}

/** Deterministic, source-order batch planning. Excluded input is always named. */
export const planGraphExtractionBatches = (args: {
  readonly corpus: GraphExtractionCorpus;
  readonly limits: GraphExtractionLimits;
  readonly countTokens: (text: string) => number;
}): GraphExtractionBatchPlan => {
  const limits = decodeLimits(args.limits);
  const reasons: GraphExtractionReason[] = [];
  const admitted: Array<{ entry: GraphExtractionCorpusEntry; characters: number; tokens: number }> =
    [];
  let characters = 0;
  let inputTokens = 0;
  for (const entry of args.corpus.entries) {
    const entryCharacters = entry.text.length;
    const entryTokens = args.countTokens(entry.text);
    if (!Number.isInteger(entryTokens) || entryTokens < 0) {
      reasons.push("invalid_corpus");
      continue;
    }
    if (admitted.length >= limits.maxEntries) {
      reasons.push("entry_cap");
      continue;
    }
    if (
      entryCharacters > limits.maxCharactersPerBatch ||
      characters + entryCharacters > limits.maxCharacters
    ) {
      reasons.push("character_cap");
      continue;
    }
    if (
      entryTokens > limits.maxInputTokensPerBatch ||
      inputTokens + entryTokens > limits.maxInputTokens
    ) {
      reasons.push("input_token_cap");
      continue;
    }
    admitted.push({ entry, characters: entryCharacters, tokens: entryTokens });
    characters += entryCharacters;
    inputTokens += entryTokens;
  }

  const batches: GraphExtractionBatch[] = [];
  let current: typeof admitted = [];
  let batchCharacters = 0;
  let batchTokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const entries = current.map((item) => item.entry);
    batches.push({
      batchRef: safeRef(
        "graph-extraction-batch",
        entries.map((item) => item.entryKey),
      ),
      entries,
      characters: batchCharacters,
      inputTokens: batchTokens,
    });
    current = [];
    batchCharacters = 0;
    batchTokens = 0;
  };
  for (const item of admitted) {
    if (
      current.length >= limits.maxEntriesPerBatch ||
      batchCharacters + item.characters > limits.maxCharactersPerBatch ||
      batchTokens + item.tokens > limits.maxInputTokensPerBatch
    ) {
      flush();
    }
    current.push(item);
    batchCharacters += item.characters;
    batchTokens += item.tokens;
  }
  flush();
  return {
    batches,
    admittedEntries: admitted.length,
    excludedEntries: args.corpus.entries.length - admitted.length,
    characters,
    inputTokens,
    reasons: uniqueSorted(reasons),
  };
};

export interface GraphExtractionSuccessfulBatch {
  readonly batch: GraphExtractionBatch;
  readonly candidates: GraphExtractionCandidates;
  readonly derivation: GraphDerivation;
}

export interface GraphExtractionRunResult {
  readonly status: GraphExtractionRunStatus;
  readonly batches: ReadonlyArray<GraphExtractionSuccessfulBatch>;
  readonly receipt: GraphExtractionRunReceipt;
}

const makeReceipt = (
  args: Omit<GraphExtractionRunReceipt, "schemaId" | "receiptRef" | "receiptDigest">,
): GraphExtractionRunReceipt => {
  const content = {
    schemaId: GRAPH_EXTRACTION_RECEIPT_SCHEMA_ID,
    ...args,
    freshnessEvidenceRefs: uniqueSorted(args.freshnessEvidenceRefs),
  };
  const receiptDigest = canonicalDigest(content);
  return decodeReceipt({
    ...content,
    receiptDigest,
    receiptRef: `graph-extraction-receipt.${receiptDigest}`,
  });
};

const attemptReceipt = (
  value: Omit<GraphExtractionAttemptReceipt, "attemptRef">,
): GraphExtractionAttemptReceipt => ({
  ...value,
  attemptRef: safeRef("graph-extraction-attempt", value),
});

const promptInput = (batch: GraphExtractionBatch) => ({
  entries: batch.entries.map((entry) => ({ entryKey: entry.entryKey, text: entry.text })),
});

const validateCorpus = (corpus: GraphExtractionCorpus): GraphExtractionReason | undefined => {
  if (corpus.entries.length === 0) return "invalid_corpus";
  const keys = corpus.entries.map((entry) => entry.entryKey);
  if (new Set(keys).size !== keys.length) return "invalid_corpus";
  return undefined;
};

const candidatesUseOnlyBatchKeys = (
  candidates: GraphExtractionCandidates,
  batch: GraphExtractionBatch,
): boolean => {
  const entryKeys = new Set(batch.entries.map((entry) => entry.entryKey));
  const mentionKeys = new Set(candidates.mentions.map((item) => item.candidateKey));
  const entityKeys = new Set(candidates.entities.map((item) => item.candidateKey));
  const entityByKey = new Map(candidates.entities.map((item) => [item.candidateKey, item]));
  const allKeys = [
    ...candidates.mentions.map((item) => item.candidateKey),
    ...candidates.entities.map((item) => item.candidateKey),
    ...candidates.relations.map((item) => item.candidateKey),
    ...candidates.merges.map((item) => item.candidateKey),
  ];
  return (
    new Set(allKeys).size === allKeys.length &&
    candidates.mentions.every((item) => entryKeys.has(item.supportEntryKey)) &&
    candidates.entities.every(
      (item) =>
        new Set(item.mentionCandidateKeys).size === item.mentionCandidateKeys.length &&
        item.mentionCandidateKeys.every((key) => mentionKeys.has(key)),
    ) &&
    candidates.relations.every(
      (item) =>
        entityKeys.has(item.fromEntityCandidateKey) &&
        entityKeys.has(item.toEntityCandidateKey) &&
        new Set(item.supportEntryKeys).size === item.supportEntryKeys.length &&
        item.supportEntryKeys.every((key) => entryKeys.has(key)),
    ) &&
    candidates.merges.every(
      (item) =>
        entityKeys.has(item.entityCandidateKey) &&
        new Set(item.mentionCandidateKeys).size === item.mentionCandidateKeys.length &&
        item.mentionCandidateKeys.every(
          (key) =>
            mentionKeys.has(key) &&
            entityByKey.get(item.entityCandidateKey)?.mentionCandidateKeys.includes(key) === true,
        ),
    )
  );
};

const statusFor = (args: {
  readonly successes: number;
  readonly admitted: number;
  readonly excluded: number;
  readonly reasons: ReadonlyArray<GraphExtractionReason>;
}): GraphExtractionRunStatus => {
  if (args.successes === args.admitted && args.excluded === 0 && args.reasons.length === 0)
    return "Complete";
  if (args.successes > 0) return "Partial";
  return args.reasons.some(
    (reason) =>
      reason === "model_failed" ||
      reason === "model_identity_drift" ||
      reason === "parser_failed" ||
      reason === "decode_failed" ||
      reason === "candidate_rejected",
  )
    ? "Failed"
    : "Refused";
};

const REPAIR_SUFFIX =
  "\n\nThe prior output did not decode. Return only strict JSON matching the fixed output schema.";

/** Run the fixed extraction program. Model output remains advisory batch-local data. */
export const runGraphExtraction = Effect.fn("Dse.runGraphExtraction")(function* (args: {
  readonly corpus: GraphExtractionCorpus;
  readonly program: CompiledProgram;
  readonly model: GraphExtractionModel;
  readonly limits: GraphExtractionLimits;
  readonly deps: GraphExtractionRuntimeDeps;
}) {
  const started = args.deps.monotonicMs();
  const programDigest = compiledProgramDigest(args.program);
  const extractionInputDigest = canonicalDigest(args.corpus);
  const plan = planGraphExtractionBatches({
    corpus: args.corpus,
    limits: args.limits,
    countTokens: args.deps.countTokens,
  });
  const reasons: GraphExtractionReason[] = [...plan.reasons];
  const attempts: GraphExtractionAttemptReceipt[] = [];
  const batches: GraphExtractionSuccessfulBatch[] = [];
  const freshnessEvidenceRefs: string[] = [];
  let modelCalls = 0;
  let outputCharacters = 0;
  let exactOutputTokens = 0;
  let candidateOutputTokens = 0;
  let exactObservedInputTokens = 0;
  let plannedPromptTokens = 0;
  let usageUnavailable = false;
  let modelIdentity: string | undefined;
  let processedEntries = 0;

  const corpusFailure = validateCorpus(args.corpus);
  if (corpusFailure !== undefined) reasons.push(corpusFailure);
  const corpusAssertion = yield* args.deps.assertCorpusUnchanged(args.corpus).pipe(Effect.result);
  if (Result.isFailure(corpusAssertion)) reasons.push("invalid_corpus");
  else freshnessEvidenceRefs.push(corpusAssertion.success);
  if (
    args.program.signatureId !== graphExtractionSignature.signatureId ||
    args.program.signatureId !== GRAPH_EXTRACTION_SIGNATURE_ID
  )
    reasons.push("invalid_program");

  if (reasons.includes("invalid_program") || reasons.includes("invalid_corpus")) {
    const receipt = makeReceipt({
      status: "Refused",
      reasons: uniqueSorted(reasons),
      corpusRef: args.corpus.corpusRef,
      contentDigest: args.corpus.contentDigest,
      manifestDigest: args.corpus.manifestDigest,
      freshnessEvidenceRefs,
      sourceLocators: args.corpus.entries.map((entry) => entry.source),
      signatureRef: GRAPH_EXTRACTION_SIGNATURE_ID,
      compiledProgramDigest: programDigest,
      extractionInputDigest,
      limits: args.limits,
      admittedEntries: plan.admittedEntries,
      processedEntries: 0,
      excludedEntries: args.corpus.entries.length,
      inputCharacters: plan.characters,
      plannedInputTokens: plan.inputTokens,
      observedInputTokens: 0,
      outputCharacters: 0,
      outputTokens: 0,
      usageTruth: "exact",
      modelCalls: 0,
      concurrencyHighWaterMark: 0,
      elapsedMs: Math.max(0, args.deps.monotonicMs() - started),
      observedAt: args.deps.now(),
      attempts: [],
      parserAttempts: [],
    });
    return { status: "Refused" as const, batches, receipt };
  }

  let stop = false;
  for (const batch of plan.batches) {
    if (stop) break;
    const boundaryAssertion = yield* args.deps
      .assertCorpusUnchanged(args.corpus)
      .pipe(Effect.result);
    if (Result.isFailure(boundaryAssertion)) {
      reasons.push("invalid_corpus");
      batches.length = 0;
      processedEntries = 0;
      break;
    }
    freshnessEvidenceRefs.push(boundaryAssertion.success);
    if (args.deps.monotonicMs() - started >= args.limits.maxWallClockMs) {
      reasons.push("time_cap");
      break;
    }
    const input = promptInput(batch);
    const untrustedContext = canonicalStringify(input);
    let accepted = false;
    let candidateBytesRejected = false;
    for (let attempt = 0; attempt <= args.program.decodePolicy.maxRepairs; attempt += 1) {
      if (modelCalls >= args.limits.maxModelCalls) {
        reasons.push("model_call_cap");
        stop = true;
        break;
      }
      if (args.deps.monotonicMs() - started >= args.limits.maxWallClockMs) {
        reasons.push("time_cap");
        stop = true;
        break;
      }
      const envelope: GraphExtractionMessageEnvelope = {
        trusted: {
          system: args.program.promptIr.system,
          instruction: args.program.promptIr.instruction,
          toolPolicy: args.program.promptIr.toolPolicy,
          outputFormat: args.program.promptIr.outputFormat,
          fewShotExampleIds: args.program.promptIr.fewShotExampleIds,
        },
        untrustedContext,
        repairInstruction: attempt > 0 ? REPAIR_SUFFIX : "",
      };
      const rendered = canonicalStringify(envelope);
      const renderedTokens = args.deps.countTokens(rendered);
      if (
        !Number.isInteger(renderedTokens) ||
        renderedTokens < 0 ||
        renderedTokens > args.limits.maxInputTokensPerBatch ||
        plannedPromptTokens + renderedTokens > args.limits.maxInputTokens
      ) {
        reasons.push("input_token_cap");
        stop = true;
        break;
      }
      plannedPromptTokens += renderedTokens;
      modelCalls += 1;
      const completion = yield* args.model
        .complete({
          message: {
            envelope,
            canonicalBytes: rendered,
            digest: canonicalDigest(rendered),
            tokenCount: renderedTokens,
          },
          remainingInputTokens: args.limits.maxInputTokens - (plannedPromptTokens - renderedTokens),
          maxOutputCharacters: Math.min(
            args.program.decodePolicy.maxOutputChars,
            args.limits.maxOutputCharacters - outputCharacters,
          ),
          maxOutputTokens: Math.min(
            args.limits.maxOutputTokens - exactOutputTokens,
            args.limits.maxOutputTokens - candidateOutputTokens,
          ),
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: Math.max(1, args.limits.maxWallClockMs - (args.deps.monotonicMs() - started)),
            orElse: () => Effect.fail(new GraphExtractionModelError({ reason: "time_cap" })),
          }),
          Effect.result,
        );
      if (Result.isFailure(completion)) {
        const timedOut = completion.failure.reason === "time_cap";
        reasons.push(timedOut ? "time_cap" : "model_failed");
        attempts.push(
          attemptReceipt({
            batchRef: batch.batchRef,
            attempt,
            modelIdentity: modelIdentity ?? "model.unavailable",
            promptDigest: canonicalDigest(rendered),
            plannedInputTokens: renderedTokens,
            decodeOutcome: "model_failed",
            usage: { _tag: "Unavailable" },
            outputCharacters: 0,
            candidateOutputTokens: 0,
            failureRef: timedOut ? "model.time-cap" : "model.failed",
          }),
        );
        usageUnavailable = true;
        const afterCallAssertion = yield* args.deps
          .assertCorpusUnchanged(args.corpus)
          .pipe(Effect.result);
        if (Result.isFailure(afterCallAssertion)) {
          reasons.push("invalid_corpus");
          batches.length = 0;
          processedEntries = 0;
          stop = true;
          break;
        }
        freshnessEvidenceRefs.push(afterCallAssertion.success);
        stop = true;
        break;
      }
      const completed = completion.success;
      const modelIdentityDrift =
        modelIdentity !== undefined && modelIdentity !== completed.modelIdentity;
      if (modelIdentity === undefined) modelIdentity = completed.modelIdentity;
      const text = completed.text;
      const chars = text.length;
      const countedOutputTokens = args.deps.countTokens(text);
      outputCharacters += chars;
      if (!Number.isInteger(countedOutputTokens) || countedOutputTokens < 0) {
        reasons.push("output_token_cap");
        stop = true;
      } else candidateOutputTokens += countedOutputTokens;
      if (completed.usage._tag === "Exact") exactOutputTokens += completed.usage.outputTokens;
      else usageUnavailable = true;
      if (completed.usage._tag === "Exact") exactObservedInputTokens += completed.usage.inputTokens;
      const overObservedInput = exactObservedInputTokens > args.limits.maxInputTokens;
      const overChars = outputCharacters > args.limits.maxOutputCharacters;
      const overTokens =
        candidateOutputTokens > args.limits.maxOutputTokens ||
        exactOutputTokens > args.limits.maxOutputTokens;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const decoded = parsed === undefined ? undefined : decodeCandidates(parsed);
      const structurallyDecoded =
        decoded !== undefined && Result.isSuccess(decoded) ? decoded.success : undefined;
      const success =
        structurallyDecoded !== undefined && candidatesUseOnlyBatchKeys(structurallyDecoded, batch)
          ? structurallyDecoded
          : undefined;
      if (structurallyDecoded !== undefined && success === undefined) candidateBytesRejected = true;
      const outcome =
        success === undefined
          ? attempt === 0
            ? "rejected"
            : "rejected"
          : attempt === 0
            ? "decoded"
            : "repaired";
      const record = attemptReceipt({
        batchRef: batch.batchRef,
        attempt,
        modelIdentity: completed.modelIdentity,
        promptDigest: canonicalDigest(rendered),
        plannedInputTokens: renderedTokens,
        outputDigest: canonicalDigest(text),
        ...(success === undefined ? {} : { candidateDigest: canonicalDigest(success) }),
        decodeOutcome: outcome,
        usage: completed.usage,
        outputCharacters: chars,
        candidateOutputTokens:
          Number.isInteger(countedOutputTokens) && countedOutputTokens >= 0
            ? countedOutputTokens
            : 0,
        ...(success === undefined ? { failureRef: "decode.rejected" } : {}),
      });
      attempts.push(record);
      const afterCallAssertion = yield* args.deps
        .assertCorpusUnchanged(args.corpus)
        .pipe(Effect.result);
      if (Result.isFailure(afterCallAssertion)) {
        reasons.push("invalid_corpus");
        batches.length = 0;
        processedEntries = 0;
        stop = true;
        break;
      }
      freshnessEvidenceRefs.push(afterCallAssertion.success);
      if (modelIdentityDrift) {
        reasons.push("model_identity_drift");
        stop = true;
        break;
      }
      if (args.deps.monotonicMs() - started > args.limits.maxWallClockMs) {
        reasons.push("time_cap");
        stop = true;
        break;
      }
      if (completed.usage._tag === "Unavailable") {
        if (success === undefined) reasons.push("output_token_cap");
        stop = true;
      }
      if (overChars || overTokens) {
        if (overChars) reasons.push("output_character_cap");
        if (overTokens) reasons.push("output_token_cap");
        stop = true;
        break;
      }
      if (overObservedInput) {
        reasons.push("input_token_cap");
        stop = true;
        break;
      }
      if (success !== undefined) {
        const derivation: GraphDerivation = decodeDerivation({
          _tag: "Model",
          extractorKind: "dse.graph-extraction.v1",
          dseSignatureRef: GRAPH_EXTRACTION_SIGNATURE_ID,
          compiledProgramDigest: programDigest,
          extractionInputDigest: canonicalDigest({ corpus: args.corpus, batch: input }),
          decodeOutcome: attempt === 0 ? "decoded" : "repaired",
          usageReceiptRef: record.attemptRef,
        });
        batches.push({ batch, candidates: success, derivation });
        processedEntries += batch.entries.length;
        accepted = true;
        break;
      }
    }
    if (!accepted && !stop)
      reasons.push(candidateBytesRejected ? "candidate_rejected" : "decode_failed");
  }
  if (processedEntries < plan.admittedEntries && reasons.length === 0)
    reasons.push("decode_failed");
  const finalAssertion = yield* args.deps.assertCorpusUnchanged(args.corpus).pipe(Effect.result);
  if (Result.isFailure(finalAssertion)) {
    reasons.push("invalid_corpus");
    batches.length = 0;
    processedEntries = 0;
  } else freshnessEvidenceRefs.push(finalAssertion.success);
  const status = statusFor({
    successes: processedEntries,
    admitted: plan.admittedEntries,
    excluded: plan.excludedEntries,
    reasons,
  });
  const receipt = makeReceipt({
    status,
    reasons: uniqueSorted(reasons),
    corpusRef: args.corpus.corpusRef,
    contentDigest: args.corpus.contentDigest,
    manifestDigest: args.corpus.manifestDigest,
    freshnessEvidenceRefs,
    sourceLocators: args.corpus.entries.map((entry) => entry.source),
    signatureRef: GRAPH_EXTRACTION_SIGNATURE_ID,
    compiledProgramDigest: programDigest,
    extractionInputDigest,
    ...(modelIdentity === undefined ? {} : { modelIdentity }),
    limits: args.limits,
    admittedEntries: plan.admittedEntries,
    processedEntries,
    excludedEntries: args.corpus.entries.length - processedEntries,
    inputCharacters: plan.characters,
    plannedInputTokens: plannedPromptTokens,
    ...(usageUnavailable ? {} : { observedInputTokens: exactObservedInputTokens }),
    outputCharacters,
    candidateOutputTokens,
    ...(usageUnavailable ? {} : { outputTokens: exactOutputTokens }),
    usageTruth: usageUnavailable ? "unavailable" : "exact",
    modelCalls,
    concurrencyHighWaterMark: modelCalls === 0 ? 0 : 1,
    elapsedMs: Math.max(0, args.deps.monotonicMs() - started),
    observedAt: args.deps.now(),
    attempts,
    parserAttempts: [],
  });
  return { status, batches, receipt };
});

export interface DeterministicGraphExtractor {
  readonly parserRef: string;
  readonly parserVersion: string;
  readonly extract: (input: {
    readonly entries: ReadonlyArray<{ readonly entryKey: string; readonly text: string }>;
  }) => Effect.Effect<GraphExtractionCandidates, GraphExtractionError>;
}

/** Run a bounded exact parser through the same candidate contract with zero model calls. */
export const runDeterministicGraphExtraction = Effect.fn("Dse.runDeterministicGraphExtraction")(
  function* (args: {
    readonly corpus: GraphExtractionCorpus;
    readonly extractor: DeterministicGraphExtractor;
    readonly limits: GraphExtractionLimits;
    readonly deps: GraphExtractionRuntimeDeps;
  }) {
    const started = args.deps.monotonicMs();
    const plan = planGraphExtractionBatches({
      corpus: args.corpus,
      limits: args.limits,
      countTokens: args.deps.countTokens,
    });
    const reasons: GraphExtractionReason[] = [...plan.reasons];
    const batches: GraphExtractionSuccessfulBatch[] = [];
    const parserAttempts: GraphExtractionParserAttemptReceipt[] = [];
    const freshnessEvidenceRefs: string[] = [];
    let processedEntries = 0;
    let outputCharacters = 0;
    let outputTokens = 0;
    const corpusAssertion = yield* args.deps.assertCorpusUnchanged(args.corpus).pipe(Effect.result);
    if (Result.isFailure(corpusAssertion) || validateCorpus(args.corpus) !== undefined)
      reasons.push("invalid_corpus");
    else freshnessEvidenceRefs.push(corpusAssertion.success);
    const derivationResult = S.decodeUnknownResult(GraphDerivationSchema)({
      _tag: "Deterministic",
      parserRef: args.extractor.parserRef,
      parserVersion: args.extractor.parserVersion,
    });
    if (Result.isFailure(derivationResult)) reasons.push("invalid_program");
    for (const batch of plan.batches) {
      if (reasons.includes("invalid_corpus")) break;
      if (Result.isFailure(derivationResult)) break;
      const boundaryAssertion = yield* args.deps
        .assertCorpusUnchanged(args.corpus)
        .pipe(Effect.result);
      if (Result.isFailure(boundaryAssertion)) {
        reasons.push("invalid_corpus");
        batches.length = 0;
        processedEntries = 0;
        break;
      }
      freshnessEvidenceRefs.push(boundaryAssertion.success);
      if (args.deps.monotonicMs() - started >= args.limits.maxWallClockMs) {
        reasons.push("time_cap");
        break;
      }
      const extracted = yield* args.extractor.extract(promptInput(batch)).pipe(
        Effect.timeoutOrElse({
          duration: Math.max(1, args.limits.maxWallClockMs - (args.deps.monotonicMs() - started)),
          orElse: () =>
            Effect.fail(
              new GraphExtractionError({
                reason: "time_cap",
                detailSafe: "The deterministic parser exceeded its time limit.",
              }),
            ),
        }),
        Effect.result,
      );
      if (Result.isFailure(extracted)) {
        const value = {
          batchRef: batch.batchRef,
          parserRef: args.extractor.parserRef,
          parserVersion: args.extractor.parserVersion,
          inputDigest: canonicalDigest(promptInput(batch)),
          outcome: "failed" as const,
          outputCharacters: 0,
          outputTokens: 0,
          failureRef: extracted.failure.reason === "time_cap" ? "parser.time-cap" : "parser.failed",
        };
        parserAttempts.push({
          ...value,
          attemptRef: safeRef("graph-extraction-parser-attempt", value),
        });
        const afterCallAssertion = yield* args.deps
          .assertCorpusUnchanged(args.corpus)
          .pipe(Effect.result);
        if (Result.isFailure(afterCallAssertion)) {
          reasons.push("invalid_corpus");
          batches.length = 0;
          processedEntries = 0;
          break;
        }
        freshnessEvidenceRefs.push(afterCallAssertion.success);
        reasons.push(extracted.failure.reason === "time_cap" ? "time_cap" : "parser_failed");
        break;
      }
      const decoded = decodeCandidates(extracted.success);
      if (Result.isFailure(decoded) || !candidatesUseOnlyBatchKeys(decoded.success, batch)) {
        const bytes = canonicalStringify(extracted.success);
        const rejectedTokens = args.deps.countTokens(bytes);
        outputCharacters += bytes.length;
        if (Number.isInteger(rejectedTokens) && rejectedTokens >= 0) outputTokens += rejectedTokens;
        const value = {
          batchRef: batch.batchRef,
          parserRef: args.extractor.parserRef,
          parserVersion: args.extractor.parserVersion,
          inputDigest: canonicalDigest(promptInput(batch)),
          outputDigest: canonicalDigest(bytes),
          outcome: "rejected" as const,
          outputCharacters: bytes.length,
          outputTokens:
            Number.isInteger(rejectedTokens) && rejectedTokens >= 0 ? rejectedTokens : 0,
          failureRef: "parser.output-rejected",
        };
        parserAttempts.push({
          ...value,
          attemptRef: safeRef("graph-extraction-parser-attempt", value),
        });
        const afterCallAssertion = yield* args.deps
          .assertCorpusUnchanged(args.corpus)
          .pipe(Effect.result);
        if (Result.isFailure(afterCallAssertion)) {
          reasons.push("invalid_corpus");
          batches.length = 0;
          processedEntries = 0;
          break;
        }
        freshnessEvidenceRefs.push(afterCallAssertion.success);
        if (outputCharacters > args.limits.maxOutputCharacters)
          reasons.push("output_character_cap");
        if (
          !Number.isInteger(rejectedTokens) ||
          rejectedTokens < 0 ||
          outputTokens > args.limits.maxOutputTokens
        )
          reasons.push("output_token_cap");
        reasons.push("candidate_rejected");
        break;
      }
      const candidateBytes = canonicalStringify(decoded.success);
      const candidateTokens = args.deps.countTokens(candidateBytes);
      const outputCharacterCap =
        outputCharacters + candidateBytes.length > args.limits.maxOutputCharacters;
      const outputTokenCap =
        !Number.isInteger(candidateTokens) ||
        candidateTokens < 0 ||
        outputTokens + candidateTokens > args.limits.maxOutputTokens;
      if (outputCharacterCap || outputTokenCap) {
        const countedTokens =
          Number.isInteger(candidateTokens) && candidateTokens >= 0 ? candidateTokens : 0;
        outputCharacters += candidateBytes.length;
        outputTokens += countedTokens;
        const value = {
          batchRef: batch.batchRef,
          parserRef: args.extractor.parserRef,
          parserVersion: args.extractor.parserVersion,
          inputDigest: canonicalDigest(promptInput(batch)),
          outputDigest: canonicalDigest(candidateBytes),
          outcome: "rejected" as const,
          outputCharacters: candidateBytes.length,
          outputTokens: countedTokens,
          failureRef: outputCharacterCap
            ? "parser.output-character-cap"
            : "parser.output-token-cap",
        };
        parserAttempts.push({
          ...value,
          attemptRef: safeRef("graph-extraction-parser-attempt", value),
        });
        const afterCallAssertion = yield* args.deps
          .assertCorpusUnchanged(args.corpus)
          .pipe(Effect.result);
        if (Result.isFailure(afterCallAssertion)) {
          reasons.push("invalid_corpus");
          batches.length = 0;
          processedEntries = 0;
          break;
        }
        freshnessEvidenceRefs.push(afterCallAssertion.success);
        if (outputCharacterCap) reasons.push("output_character_cap");
        if (outputTokenCap) reasons.push("output_token_cap");
        break;
      }
      outputCharacters += candidateBytes.length;
      outputTokens += candidateTokens;
      const parserValue = {
        batchRef: batch.batchRef,
        parserRef: args.extractor.parserRef,
        parserVersion: args.extractor.parserVersion,
        inputDigest: canonicalDigest(promptInput(batch)),
        outputDigest: canonicalDigest(decoded.success),
        outcome: "decoded" as const,
        outputCharacters: candidateBytes.length,
        outputTokens: candidateTokens,
      };
      parserAttempts.push({
        ...parserValue,
        attemptRef: safeRef("graph-extraction-parser-attempt", parserValue),
      });
      const afterCallAssertion = yield* args.deps
        .assertCorpusUnchanged(args.corpus)
        .pipe(Effect.result);
      if (Result.isFailure(afterCallAssertion)) {
        reasons.push("invalid_corpus");
        batches.length = 0;
        processedEntries = 0;
        break;
      }
      freshnessEvidenceRefs.push(afterCallAssertion.success);
      batches.push({
        batch,
        candidates: decoded.success,
        derivation: derivationResult.success,
      });
      processedEntries += batch.entries.length;
      if (args.deps.monotonicMs() - started > args.limits.maxWallClockMs) {
        reasons.push("time_cap");
        break;
      }
    }
    const finalAssertion = yield* args.deps.assertCorpusUnchanged(args.corpus).pipe(Effect.result);
    if (Result.isFailure(finalAssertion)) {
      reasons.push("invalid_corpus");
      batches.length = 0;
      processedEntries = 0;
    } else freshnessEvidenceRefs.push(finalAssertion.success);
    const status = statusFor({
      successes: processedEntries,
      admitted: plan.admittedEntries,
      excluded: plan.excludedEntries,
      reasons,
    });
    const receipt = makeReceipt({
      status,
      reasons: uniqueSorted(reasons),
      corpusRef: args.corpus.corpusRef,
      contentDigest: args.corpus.contentDigest,
      manifestDigest: args.corpus.manifestDigest,
      freshnessEvidenceRefs,
      sourceLocators: args.corpus.entries.map((entry) => entry.source),
      signatureRef: GRAPH_EXTRACTION_SIGNATURE_ID,
      compiledProgramDigest: canonicalDigest({
        parserRef: args.extractor.parserRef,
        parserVersion: args.extractor.parserVersion,
      }),
      extractionInputDigest: canonicalDigest(args.corpus),
      limits: args.limits,
      admittedEntries: plan.admittedEntries,
      processedEntries,
      excludedEntries: args.corpus.entries.length - processedEntries,
      inputCharacters: plan.characters,
      plannedInputTokens: plan.inputTokens,
      observedInputTokens: 0,
      outputCharacters,
      candidateOutputTokens: outputTokens,
      outputTokens: 0,
      usageTruth: "exact",
      modelCalls: 0,
      concurrencyHighWaterMark: 0,
      elapsedMs: Math.max(0, args.deps.monotonicMs() - started),
      observedAt: args.deps.now(),
      attempts: [],
      parserAttempts,
    });
    return { status, batches, receipt };
  },
);

/** Verify receipt identity and cross-field accounting. */
export interface GraphExtractionReceiptValidationContext {
  readonly corpus: GraphExtractionCorpus;
  readonly program?: CompiledProgram;
  readonly limits: GraphExtractionLimits;
  readonly countTokens: (text: string) => number;
  readonly assertCorpusUnchanged: (
    corpus: GraphExtractionCorpus,
  ) => Effect.Effect<string, GraphExtractionError>;
  readonly result: GraphExtractionRunResult;
}

export const validateGraphExtractionRunReceipt = Effect.fn("Dse.validateGraphExtractionRunReceipt")(
  function* (receipt: GraphExtractionRunReceipt, context: GraphExtractionReceiptValidationContext) {
    const currentFreshnessEvidenceRef = yield* context.assertCorpusUnchanged(context.corpus);
    let decoded: GraphExtractionRunReceipt;
    try {
      decoded = decodeReceipt(receipt);
    } catch {
      return yield* new GraphExtractionError({
        reason: "invalid_corpus",
        detailSafe: "The extraction receipt does not match its schema.",
      });
    }
    const { receiptRef, receiptDigest, ...content } = decoded;
    const expectedDigest = canonicalDigest(content);
    const attemptOutputCharacters = decoded.attempts.reduce(
      (sum, item) => sum + item.outputCharacters,
      0,
    );
    const exactOutputTokens = decoded.attempts.reduce(
      (sum, item) => sum + (item.usage._tag === "Exact" ? item.usage.outputTokens : 0),
      0,
    );
    const hasUnavailable = decoded.attempts.some((item) => item.usage._tag === "Unavailable");
    const exactObservedInputTokens = decoded.attempts.reduce(
      (sum, item) => sum + (item.usage._tag === "Exact" ? item.usage.inputTokens : 0),
      0,
    );
    const attemptsByRef = new Map(decoded.attempts.map((item) => [item.attemptRef, item]));
    const planned = planGraphExtractionBatches({
      corpus: context.corpus,
      limits: context.limits,
      countTokens: context.countTokens,
    });
    const plannedByRef = new Map(planned.batches.map((item) => [item.batchRef, item]));
    const batchesValid = context.result.batches.every((item) => {
      if (
        canonicalStringify(plannedByRef.get(item.batch.batchRef)) !==
          canonicalStringify(item.batch) ||
        !candidatesUseOnlyBatchKeys(item.candidates, item.batch)
      )
        return false;
      if (item.derivation._tag === "Deterministic")
        return (
          decoded.modelCalls === 0 &&
          decoded.compiledProgramDigest ===
            canonicalDigest({
              parserRef: item.derivation.parserRef,
              parserVersion: item.derivation.parserVersion,
            })
        );
      const attempt = attemptsByRef.get(item.derivation.usageReceiptRef);
      return (
        context.program !== undefined &&
        item.derivation.compiledProgramDigest === compiledProgramDigest(context.program) &&
        item.derivation.dseSignatureRef === GRAPH_EXTRACTION_SIGNATURE_ID &&
        item.derivation.extractionInputDigest ===
          canonicalDigest({ corpus: context.corpus, batch: promptInput(item.batch) }) &&
        attempt?.batchRef === item.batch.batchRef &&
        attempt.decodeOutcome === item.derivation.decodeOutcome &&
        attempt.candidateDigest === canonicalDigest(item.candidates)
      );
    });
    const attemptOrdinals = new Map<string, number>();
    const attemptsValid = decoded.attempts.every((item) => {
      const batch = plannedByRef.get(item.batchRef);
      if (batch === undefined) return false;
      const expectedAttempt = attemptOrdinals.get(item.batchRef) ?? 0;
      attemptOrdinals.set(item.batchRef, expectedAttempt + 1);
      const envelope = {
        trusted: {
          system: context.program?.promptIr.system,
          instruction: context.program?.promptIr.instruction,
          toolPolicy: context.program?.promptIr.toolPolicy,
          outputFormat: context.program?.promptIr.outputFormat,
          fewShotExampleIds: context.program?.promptIr.fewShotExampleIds,
        },
        untrustedContext: canonicalStringify(promptInput(batch)),
        repairInstruction: item.attempt > 0 ? REPAIR_SUFFIX : "",
      };
      const rendered = canonicalStringify(envelope);
      const isSuccess = item.decodeOutcome === "decoded" || item.decodeOutcome === "repaired";
      const { attemptRef: _attemptRef, ...attemptContent } = item;
      return (
        context.program !== undefined &&
        item.attempt === expectedAttempt &&
        item.promptDigest === canonicalDigest(rendered) &&
        item.plannedInputTokens === context.countTokens(rendered) &&
        item.attemptRef === safeRef("graph-extraction-attempt", attemptContent) &&
        (isSuccess
          ? item.candidateDigest !== undefined &&
            ((item.decodeOutcome === "decoded" && item.attempt === 0) ||
              (item.decodeOutcome === "repaired" && item.attempt > 0))
          : item.candidateDigest === undefined) &&
        (item.decodeOutcome === "model_failed"
          ? item.outputDigest === undefined &&
            item.outputCharacters === 0 &&
            item.candidateOutputTokens === 0 &&
            item.failureRef !== undefined
          : item.outputDigest !== undefined) &&
        (isSuccess ? item.failureRef === undefined : item.failureRef !== undefined)
      );
    });
    const modelAttemptsByBatch = new Map<string, GraphExtractionAttemptReceipt[]>();
    for (const attempt of decoded.attempts) {
      const group = modelAttemptsByBatch.get(attempt.batchRef) ?? [];
      group.push(attempt);
      modelAttemptsByBatch.set(attempt.batchRef, group);
    }
    const attemptBatchIndexes = decoded.attempts.map((item) =>
      planned.batches.findIndex((batch) => batch.batchRef === item.batchRef),
    );
    const attemptModelIdentities = [...new Set(decoded.attempts.map((item) => item.modelIdentity))];
    const modelIdentityAlgebraValid = decoded.reasons.includes("model_identity_drift")
      ? attemptModelIdentities.length > 1 &&
        decoded.modelIdentity === decoded.attempts[0]?.modelIdentity
      : attemptModelIdentities.length <= 1 &&
        (decoded.attempts.length === 0 ||
          decoded.modelIdentity === attemptModelIdentities[0] ||
          (decoded.modelIdentity === undefined &&
            attemptModelIdentities[0] === "model.unavailable" &&
            decoded.attempts.every((item) => item.decodeOutcome === "model_failed")));
    const modelAttemptHistoryValid =
      (context.program !== undefined || decoded.attempts.length === 0) &&
      [...modelAttemptsByBatch.values()].every((group) => {
        if (
          context.program === undefined ||
          group.length > context.program.decodePolicy.maxRepairs + 1
        )
          return false;
        const successIndexes = group.flatMap((item, index) =>
          item.decodeOutcome === "decoded" || item.decodeOutcome === "repaired" ? [index] : [],
        );
        if (successIndexes.length > 1) return false;
        if (successIndexes.length === 1)
          return (
            successIndexes[0] === group.length - 1 &&
            group.slice(0, -1).every((item) => item.decodeOutcome === "rejected")
          );
        const terminal = group.at(-1)!;
        const isExactTerminalAttempt = terminal.attemptRef === decoded.attempts.at(-1)?.attemptRef;
        const batch = plannedByRef.get(terminal.batchRef);
        const nextAttempt = terminal.attempt + 1;
        const nextEnvelope =
          batch === undefined || context.program === undefined
            ? undefined
            : canonicalStringify({
                trusted: {
                  system: context.program.promptIr.system,
                  instruction: context.program.promptIr.instruction,
                  toolPolicy: context.program.promptIr.toolPolicy,
                  outputFormat: context.program.promptIr.outputFormat,
                  fewShotExampleIds: context.program.promptIr.fewShotExampleIds,
                },
                untrustedContext: canonicalStringify(promptInput(batch)),
                repairInstruction: nextAttempt > 0 ? REPAIR_SUFFIX : "",
              });
        const nextInputTokens = nextEnvelope === undefined ? 0 : context.countTokens(nextEnvelope);
        const executionCapTermination =
          isExactTerminalAttempt &&
          ((decoded.reasons.includes("model_call_cap") &&
            decoded.modelCalls >= decoded.limits.maxModelCalls) ||
            (decoded.reasons.includes("input_token_cap") &&
              (decoded.plannedInputTokens + nextInputTokens > decoded.limits.maxInputTokens ||
                nextInputTokens > decoded.limits.maxInputTokensPerBatch ||
                (decoded.observedInputTokens ?? 0) > decoded.limits.maxInputTokens)) ||
            (decoded.reasons.includes("output_token_cap") &&
              ((decoded.candidateOutputTokens ?? 0) > decoded.limits.maxOutputTokens ||
                (decoded.outputTokens ?? 0) > decoded.limits.maxOutputTokens ||
                terminal.usage._tag === "Unavailable")) ||
            (decoded.reasons.includes("output_character_cap") &&
              decoded.outputCharacters > decoded.limits.maxOutputCharacters) ||
            (decoded.reasons.includes("time_cap") &&
              decoded.elapsedMs >= decoded.limits.maxWallClockMs));
        return (
          group.slice(0, -1).every((item) => item.decodeOutcome === "rejected") &&
          (terminal.decodeOutcome === "model_failed" ||
            (terminal.decodeOutcome === "rejected" &&
              (group.length === context.program.decodePolicy.maxRepairs + 1 ||
                executionCapTermination)))
        );
      }) &&
      attemptBatchIndexes.every(
        (index, position) =>
          index >= 0 && (position === 0 || index >= attemptBatchIndexes[position - 1]!),
      );
    const parserAttemptsByBatch = new Map(
      decoded.parserAttempts.map((item) => [item.batchRef, item]),
    );
    const parserAttemptsValid = decoded.parserAttempts.every((item) => {
      const batch = plannedByRef.get(item.batchRef);
      const successful = context.result.batches.find(
        (resultBatch) => resultBatch.batch.batchRef === item.batchRef,
      );
      const { attemptRef: _attemptRef, ...attemptContent } = item;
      return (
        batch !== undefined &&
        item.inputDigest === canonicalDigest(promptInput(batch)) &&
        item.attemptRef === safeRef("graph-extraction-parser-attempt", attemptContent) &&
        (item.outcome === "decoded"
          ? successful === undefined
            ? decoded.reasons.includes("invalid_corpus") && item.failureRef === undefined
            : successful.derivation._tag === "Deterministic" &&
              successful.derivation.parserRef === item.parserRef &&
              successful.derivation.parserVersion === item.parserVersion &&
              item.outputDigest === canonicalDigest(successful.candidates) &&
              item.outputCharacters === canonicalStringify(successful.candidates).length &&
              item.outputTokens ===
                context.countTokens(canonicalStringify(successful.candidates)) &&
              item.failureRef === undefined
          : successful === undefined && item.failureRef !== undefined)
      );
    });
    const deterministicBatches = context.result.batches.filter(
      (item) => item.derivation._tag === "Deterministic",
    );
    const decodedParserAttempts = decoded.parserAttempts.filter(
      (item) => item.outcome === "decoded",
    );
    const deterministicParserCoverageValid =
      decoded.modelCalls === 0
        ? deterministicBatches.every(
            (item) => parserAttemptsByBatch.get(item.batch.batchRef)?.outcome === "decoded",
          ) &&
          (decoded.status !== "Complete" ||
            decodedParserAttempts.length === deterministicBatches.length)
        : decoded.parserAttempts.length === 0 && deterministicBatches.length === 0;
    const successfulBatchRefs = context.result.batches.map((item) => item.batch.batchRef);
    const plannedBatchRefs = planned.batches.map((item) => item.batchRef);
    const successfulIndexes = successfulBatchRefs.map((ref) => plannedBatchRefs.indexOf(ref));
    const processedFromBatches = context.result.batches.reduce(
      (sum, item) => sum + item.batch.entries.length,
      0,
    );
    const capAlgebraValid =
      decoded.modelCalls <= decoded.limits.maxModelCalls &&
      decoded.admittedEntries <= decoded.limits.maxEntries &&
      decoded.inputCharacters <= decoded.limits.maxCharacters &&
      decoded.plannedInputTokens <= decoded.limits.maxInputTokens &&
      decoded.concurrencyHighWaterMark <= 1 &&
      context.result.batches.every(
        (item) =>
          item.batch.entries.length <= decoded.limits.maxEntriesPerBatch &&
          item.batch.characters <= decoded.limits.maxCharactersPerBatch &&
          item.batch.inputTokens <= decoded.limits.maxInputTokensPerBatch,
      ) &&
      (decoded.observedInputTokens === undefined ||
        decoded.observedInputTokens <= decoded.limits.maxInputTokens ||
        decoded.reasons.includes("input_token_cap")) &&
      (decoded.candidateOutputTokens === undefined ||
        decoded.candidateOutputTokens <= decoded.limits.maxOutputTokens ||
        decoded.reasons.includes("output_token_cap")) &&
      (decoded.outputTokens === undefined ||
        decoded.outputTokens <= decoded.limits.maxOutputTokens ||
        decoded.reasons.includes("output_token_cap")) &&
      (decoded.outputCharacters <= decoded.limits.maxOutputCharacters ||
        decoded.reasons.includes("output_character_cap")) &&
      (decoded.elapsedMs <= decoded.limits.maxWallClockMs || decoded.reasons.includes("time_cap"));
    if (
      receiptDigest !== expectedDigest ||
      receiptRef !== `graph-extraction-receipt.${expectedDigest}` ||
      canonicalStringify(decoded) !== canonicalStringify(context.result.receipt) ||
      decoded.status !== context.result.status ||
      decoded.corpusRef !== context.corpus.corpusRef ||
      decoded.contentDigest !== context.corpus.contentDigest ||
      decoded.manifestDigest !== context.corpus.manifestDigest ||
      !decoded.freshnessEvidenceRefs.includes(currentFreshnessEvidenceRef) ||
      decoded.extractionInputDigest !== canonicalDigest(context.corpus) ||
      canonicalStringify(decoded.sourceLocators) !==
        canonicalStringify(context.corpus.entries.map((item) => item.source)) ||
      canonicalStringify(decoded.limits) !== canonicalStringify(context.limits) ||
      (context.program !== undefined &&
        decoded.compiledProgramDigest !== compiledProgramDigest(context.program)) ||
      !batchesValid ||
      !attemptsValid ||
      !modelIdentityAlgebraValid ||
      !modelAttemptHistoryValid ||
      !parserAttemptsValid ||
      !deterministicParserCoverageValid ||
      !capAlgebraValid ||
      parserAttemptsByBatch.size !== decoded.parserAttempts.length ||
      decoded.admittedEntries !== planned.admittedEntries ||
      decoded.inputCharacters !== planned.characters ||
      !planned.reasons.every((reason) => decoded.reasons.includes(reason)) ||
      decoded.processedEntries !== processedFromBatches ||
      new Set(successfulBatchRefs).size !== successfulBatchRefs.length ||
      successfulIndexes.some(
        (index, position) =>
          index < 0 || (position > 0 && index <= successfulIndexes[position - 1]!),
      ) ||
      decoded.modelCalls !== decoded.attempts.length ||
      decoded.plannedInputTokens !==
        (decoded.modelCalls > 0
          ? decoded.attempts.reduce((sum, item) => sum + item.plannedInputTokens, 0)
          : planned.inputTokens) ||
      (decoded.modelCalls > 0 && decoded.outputCharacters !== attemptOutputCharacters) ||
      (decoded.modelCalls > 0 &&
        decoded.candidateOutputTokens !==
          decoded.attempts.reduce((sum, item) => sum + item.candidateOutputTokens, 0)) ||
      (decoded.modelCalls === 0 &&
        decoded.outputCharacters !==
          decoded.parserAttempts.reduce((sum, item) => sum + item.outputCharacters, 0)) ||
      (decoded.modelCalls === 0 &&
        decoded.candidateOutputTokens !==
          decoded.parserAttempts.reduce((sum, item) => sum + item.outputTokens, 0)) ||
      decoded.processedEntries + decoded.excludedEntries !== decoded.sourceLocators.length ||
      decoded.admittedEntries < decoded.processedEntries ||
      decoded.concurrencyHighWaterMark > decoded.limits.maxConcurrency ||
      canonicalStringify(decoded.reasons) !== canonicalStringify(uniqueSorted(decoded.reasons)) ||
      new Set(decoded.attempts.map((item) => item.attemptRef)).size !== decoded.attempts.length ||
      new Set(decoded.parserAttempts.map((item) => item.attemptRef)).size !==
        decoded.parserAttempts.length ||
      (decoded.status === "Complete" &&
        (decoded.reasons.length > 0 ||
          decoded.excludedEntries > 0 ||
          decoded.processedEntries === 0 ||
          canonicalStringify(successfulBatchRefs) !== canonicalStringify(plannedBatchRefs))) ||
      (decoded.status === "Partial" && decoded.reasons.length === 0) ||
      (decoded.usageTruth === "unavailable" && decoded.outputTokens !== undefined) ||
      (decoded.usageTruth === "exact" &&
        (hasUnavailable ||
          decoded.outputTokens !== exactOutputTokens ||
          decoded.observedInputTokens !== exactObservedInputTokens)) ||
      (decoded.modelCalls === 0 && decoded.modelIdentity !== undefined)
    ) {
      return yield* new GraphExtractionError({
        reason: "invalid_corpus",
        detailSafe: "The extraction receipt identity or accounting is inconsistent.",
      });
    }
  },
);

/** Trusted locator join and pure graph build. Candidate bytes cannot supply graph refs or locators. */
export const applyGraphExtractionCandidates = Effect.fn("Dse.applyGraphExtractionCandidates")(
  function* (args: {
    readonly run: GraphExtractionRunResult;
    readonly execution: Omit<GraphExtractionReceiptValidationContext, "result">;
    readonly graphRef: string;
    readonly scopeRef: string;
    readonly identityScopeRef?: string;
    readonly policy: GraphCorpusPolicy;
  }): Effect.fn.Return<
    BuiltGraphCorpus,
    GraphExtractionError | import("@openagentsinc/graph-corpus").GraphCorpusError
  > {
    if (args.run.status !== "Complete") {
      return yield* new GraphExtractionError({
        reason: "invalid_candidate",
        detailSafe: "Only a complete extraction can enter graph application.",
      });
    }
    yield* validateGraphExtractionRunReceipt(args.run.receipt, {
      ...args.execution,
      result: args.run,
    });
    const applicationFreshnessEvidenceRef = yield* args.execution.assertCorpusUnchanged(
      args.execution.corpus,
    );
    if (!args.run.receipt.freshnessEvidenceRefs.includes(applicationFreshnessEvidenceRef))
      return yield* new GraphExtractionError({
        reason: "invalid_corpus",
        detailSafe: "The graph application freshness evidence does not match the extraction run.",
      });
    const mentions: Array<ReturnType<typeof makeGraphMention>> = [];
    const entities: Array<ReturnType<typeof makeCanonicalEntity>> = [];
    const relations: Array<ReturnType<typeof makeGraphRelation>> = [];
    const merges: Array<ReturnType<typeof makeMergeEvidence>> = [];
    for (const success of args.run.batches) {
      const entryByKey = new Map(success.batch.entries.map((entry) => [entry.entryKey, entry]));
      const mentionByKey = new Map<string, ReturnType<typeof makeGraphMention>>();
      const entityByKey = new Map<string, ReturnType<typeof makeCanonicalEntity>>();
      const keys = [
        ...success.candidates.mentions.map((item) => item.candidateKey),
        ...success.candidates.entities.map((item) => item.candidateKey),
        ...success.candidates.relations.map((item) => item.candidateKey),
        ...success.candidates.merges.map((item) => item.candidateKey),
      ];
      if (new Set(keys).size !== keys.length)
        return yield* new GraphExtractionError({
          reason: "invalid_candidate",
          detailSafe: "Candidate keys must be unique in one batch.",
        });
      for (const candidate of success.candidates.mentions) {
        const entry = entryByKey.get(candidate.supportEntryKey);
        if (entry === undefined)
          return yield* new GraphExtractionError({
            reason: "invalid_candidate",
            detailSafe: "A mention names an unknown batch entry.",
          });
        const mention = makeGraphMention({
          identityNamespace: candidate.identityNamespace,
          canonicalKey: candidate.canonicalKey,
          ...(args.identityScopeRef === undefined
            ? {}
            : { identityScopeRef: args.identityScopeRef }),
          source: entry.source,
          derivation: success.derivation,
        });
        mentionByKey.set(candidate.candidateKey, mention);
        mentions.push(mention);
      }
      for (const candidate of success.candidates.entities) {
        const refs = uniqueSorted(candidate.mentionCandidateKeys);
        const children = refs.map((key) => mentionByKey.get(key));
        if (
          children.some((item) => item === undefined) ||
          refs.length !== candidate.mentionCandidateKeys.length
        )
          return yield* new GraphExtractionError({
            reason: "invalid_candidate",
            detailSafe: "An entity has an unknown or duplicate mention key.",
          });
        const entity = makeCanonicalEntity({
          identityNamespace: candidate.identityNamespace,
          canonicalKey: candidate.canonicalKey,
          ...(args.identityScopeRef === undefined
            ? {}
            : { identityScopeRef: args.identityScopeRef }),
          mentions: children.filter((item): item is NonNullable<typeof item> => item !== undefined),
          derivation: success.derivation,
        });
        entityByKey.set(candidate.candidateKey, entity);
        entities.push(entity);
      }
      for (const candidate of success.candidates.relations) {
        const from = entityByKey.get(candidate.fromEntityCandidateKey);
        const to = entityByKey.get(candidate.toEntityCandidateKey);
        const supportKeys = uniqueSorted(candidate.supportEntryKeys);
        const support = supportKeys.map((key) => entryByKey.get(key));
        if (
          from === undefined ||
          to === undefined ||
          support.some((item) => item === undefined) ||
          supportKeys.length !== candidate.supportEntryKeys.length
        )
          return yield* new GraphExtractionError({
            reason: "invalid_candidate",
            detailSafe: "A relation has an unknown endpoint or source key.",
          });
        relations.push(
          makeGraphRelation({
            identityNamespace: candidate.identityNamespace,
            canonicalKey: candidate.canonicalKey,
            ...(args.identityScopeRef === undefined
              ? {}
              : { identityScopeRef: args.identityScopeRef }),
            relationKind: candidate.relationKind,
            from,
            to,
            memberships: support
              .filter((item): item is NonNullable<typeof item> => item !== undefined)
              .map((entry) => ({ source: entry.source })),
            derivation: success.derivation,
          }),
        );
      }
      for (const candidate of success.candidates.merges) {
        const entity = entityByKey.get(candidate.entityCandidateKey);
        const keys = uniqueSorted(candidate.mentionCandidateKeys);
        const children = keys.map((key) => mentionByKey.get(key));
        if (
          entity === undefined ||
          children.some((item) => item === undefined) ||
          keys.length !== candidate.mentionCandidateKeys.length
        )
          return yield* new GraphExtractionError({
            reason: "invalid_candidate",
            detailSafe: "Merge evidence has an unknown or duplicate candidate key.",
          });
        merges.push(
          makeMergeEvidence({
            entity,
            mentions: children.filter(
              (item): item is NonNullable<typeof item> => item !== undefined,
            ),
            evidenceRef: safeRef("graph-extraction-evidence", {
              receiptRef: args.run.receipt.receiptRef,
              batchRef: success.batch.batchRef,
              candidateKey: candidate.candidateKey,
              mentionKeys: keys,
            }),
          }),
        );
      }
    }
    return yield* buildGraphCorpus({
      graphRef: args.graphRef,
      scopeRef: args.scopeRef,
      policy: args.policy,
      mentions,
      entities,
      relations,
      merges,
    });
  },
);
