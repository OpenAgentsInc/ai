import { Context, Effect, Layer, Stream } from "effect";
import { Schema as S } from "effect";
import type { RlmCorpusSourceShape } from "../corpus/source.ts";
import { RlmCorpusSource } from "../corpus/source.ts";
import { validateCitations } from "../corpus/citations.ts";
import { makeRlmEnvironment } from "../environment/values.ts";
import { runDeterministicOperation } from "../interpreter/deterministic.ts";
import { executeProgram, type LeafModel } from "../program/execute.ts";
import type { RlmBudget } from "../schemas/budget.ts";
import type { RlmEvent } from "../schemas/events.ts";
import { RlmError } from "../schemas/errors.ts";
import { RlmProgram as RlmProgramSchema, type RlmProgram } from "../schemas/program.ts";
import type { RlmRequest } from "../schemas/request-result.ts";
import {
  emptyRlmTokenUsage,
  type RlmHonesty,
  type RlmTerminalResult,
} from "../schemas/request-result.ts";

export interface RlmShape {
  readonly stream: (request: RlmRequest) => Stream.Stream<RlmEvent, RlmError>;
  readonly run: (request: RlmRequest) => Effect.Effect<RlmTerminalResult, RlmError>;
}

export class Rlm extends Context.Service<Rlm, RlmShape>()("@openagentsinc/rlm/Rlm") {}

export interface RlmModelPlan {
  readonly completeRoot?: (
    prompt: string,
  ) => Effect.Effect<{ text: string; inputTokens?: number; outputTokens?: number }, RlmError>;
  readonly completeLeaf?: (
    prompt: string,
  ) => Effect.Effect<{ text: string; inputTokens?: number; outputTokens?: number }, RlmError>;
  readonly refuseSemantic?: boolean;
  readonly strategyRef?: string;
}

export interface MakeRlmOptions {
  readonly model?: RlmModelPlan | undefined;
  readonly admitSemantic?: boolean;
}

const decodeProgram = S.decodeUnknownSync(RlmProgramSchema);

type Emit = (
  partial: Record<string, unknown> & { readonly _tag: string; readonly runRef: string },
) => Effect.Effect<void>;

export const makeRlm = (
  options: MakeRlmOptions = {},
): Effect.Effect<RlmShape, never, RlmCorpusSource> =>
  Effect.gen(function* () {
    const corpusSource = yield* RlmCorpusSource;

    const stream = (request: RlmRequest): Stream.Stream<RlmEvent, RlmError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events: Array<RlmEvent> = [];
          let eventSequence = 0;
          let atMs = 0;
          const emit: Emit = (partial) =>
            Effect.sync(() => {
              eventSequence += 1;
              atMs += 1;
              events.push({ ...partial, eventSequence, atMs } as unknown as RlmEvent);
            });

          yield* runRequest(request, {
            corpusSource,
            ...(options.model !== undefined ? { model: options.model } : {}),
            admitSemantic: options.admitSemantic ?? true,
            emit,
          });
          return Stream.fromIterable(events);
        }),
      );

    const run = (request: RlmRequest): Effect.Effect<RlmTerminalResult, RlmError> =>
      stream(request).pipe(
        Stream.runCollect,
        Effect.flatMap((events) => {
          const terminal = [...events].reverse().find((e) => e._tag === "Terminal");
          if (terminal === undefined || terminal._tag !== "Terminal") {
            return Effect.fail(
              new RlmError({
                reason: "invariant_violation",
                retryable: false,
                detailSafe: "stream ended without terminal event",
              }),
            );
          }
          return Effect.succeed(terminal.result);
        }),
      );

    return { stream, run } satisfies RlmShape;
  });

interface RunCtx {
  readonly corpusSource: RlmCorpusSourceShape;
  readonly model?: RlmModelPlan | undefined;
  readonly admitSemantic: boolean;
  readonly emit: Emit;
}

const runRequest = (request: RlmRequest, ctx: RunCtx): Effect.Effect<void, RlmError> =>
  Effect.gen(function* () {
    const mode = request._tag === "Deterministic" ? "deterministic" : "semantic";
    yield* ctx.emit({ _tag: "RunStarted", runRef: request.runRef, mode });

    const handle = yield* ctx.corpusSource.resolve(request.corpus).pipe(
      Effect.mapError(
        (e) =>
          new RlmError({
            reason: e.reason === "changed" ? "corpus_changed" : "corpus_unavailable",
            retryable: false,
            ...(e.detailSafe !== undefined ? { detailSafe: e.detailSafe } : {}),
          }),
      ),
    );

    yield* ctx.emit({
      _tag: "CorpusResolved",
      runRef: request.runRef,
      corpusRef: handle.identity.corpusRef,
      contentDigest: handle.identity.contentDigest,
      entryCount: handle.manifest.coverage.entryCount,
    });

    if (request._tag === "Deterministic") {
      const obs = yield* runDeterministicOperation(handle, request.operation, request.limits);
      yield* ctx.emit({
        _tag: "ObservationCompleted",
        runRef: request.runRef,
        observationChars: obs.observationText.length,
        detailSafe: `scanned=${obs.entriesScanned}`,
      });
      const citations = obs.findings.map((f) => f.citation);
      const validation = yield* validateCitations(handle, citations);
      const honesty: RlmHonesty = {
        capsHit: obs.capsHit,
        usageCompleteness: "unavailable",
        citationValidated: validation.validated.length,
        citationInvalid: validation.invalid.length,
        programNodes: 0,
        valuesPublished: 0,
        modelMapCalls: 0,
        rlmMapCalls: 0,
      };
      const runSummary = {
        runRef: request.runRef,
        depth: 0,
        iterations: 1,
        corpusRef: handle.identity.corpusRef,
        contentDigest: handle.identity.contentDigest,
      };
      const result: RlmTerminalResult =
        obs.capsHit.length > 0
          ? {
              _tag: "Partial",
              run: runSummary,
              reason: "cap_truncated",
              bestOutput: { _tag: "DeterministicFindings", findings: obs.findings },
              citations: validation.validated,
              usage: emptyRlmTokenUsage(),
              honesty,
            }
          : {
              _tag: "Completed",
              run: runSummary,
              output: { _tag: "DeterministicFindings", findings: obs.findings },
              citations: validation.validated,
              usage: emptyRlmTokenUsage(),
              honesty,
            };
      yield* ctx.emit({ _tag: "Terminal", runRef: request.runRef, result });
      return;
    }

    if (!ctx.admitSemantic || ctx.model?.refuseSemantic) {
      yield* ctx.emit({
        _tag: "Terminal",
        runRef: request.runRef,
        result: {
          _tag: "Refused",
          run: {
            runRef: request.runRef,
            depth: 0,
            iterations: 0,
            corpusRef: handle.identity.corpusRef,
            contentDigest: handle.identity.contentDigest,
          },
          reason: "semantic_not_admitted",
          usage: emptyRlmTokenUsage(),
          honesty: baseHonesty(ctx.model?.strategyRef),
        },
      });
      return;
    }

    const budget: RlmBudget = request.budget;
    const evidence = request.evidence;
    const env = yield* makeRlmEnvironment(budget);

    yield* ctx.emit({
      _tag: "IterationStarted",
      runRef: request.runRef,
      depth: 0,
      iteration: 0,
    });

    const rootComplete = ctx.model?.completeRoot;
    if (rootComplete === undefined) {
      return yield* new RlmError({
        reason: "model_unavailable",
        retryable: false,
        detailSafe: "semantic mode requires completeRoot",
      });
    }

    const rootPrompt = [
      "Emit a single RlmProgram JSON object.",
      `Question: ${request.question}`,
      `Corpus entries: ${handle.manifest.coverage.entryCount}`,
    ].join("\n");

    const rootOut = yield* rootComplete(rootPrompt);
    let program: RlmProgram;
    try {
      program = decodeProgram(JSON.parse(rootOut.text));
    } catch {
      return yield* new RlmError({
        reason: "program_contract_violation",
        retryable: false,
        detailSafe: "root model did not emit a valid RlmProgram",
      });
    }

    const leafModel: LeafModel | undefined =
      ctx.model?.completeLeaf !== undefined
        ? { complete: ctx.model.completeLeaf }
        : ctx.model?.completeRoot !== undefined
          ? { complete: ctx.model.completeRoot }
          : undefined;

    const execution = yield* executeProgram(program, {
      handle,
      env,
      budget,
      ...(leafModel !== undefined ? { leafModel } : {}),
      depth: 0,
      runRef: request.runRef,
      emit: ctx.emit,
      clockMs: () => Effect.succeed(0),
      runChildRlm: (question) =>
        Effect.gen(function* () {
          if (leafModel === undefined) {
            return yield* new RlmError({
              reason: "model_unavailable",
              retryable: false,
              detailSafe: "RlmMap child needs leaf model",
            });
          }
          const out = yield* leafModel.complete(`Child RLM: ${question}`);
          return { text: out.text, citations: [] };
        }),
    });

    for (const v of yield* env.list()) {
      yield* ctx.emit({
        _tag: "ValuePublished",
        runRef: request.runRef,
        valueRef: v.valueRef,
        digest: v.digest,
        encodedBytes: v.encodedBytes,
      });
    }

    const runSummary = {
      runRef: request.runRef,
      depth: 0,
      iterations: 1,
      corpusRef: handle.identity.corpusRef,
      contentDigest: handle.identity.contentDigest,
    };
    const usage = emptyRlmTokenUsage({
      modelCalls: execution.modelCalls + 1,
      subcalls: execution.subcalls,
    });

    if (execution.committed === undefined) {
      yield* ctx.emit({
        _tag: "Terminal",
        runRef: request.runRef,
        result: {
          _tag: "Partial",
          run: runSummary,
          reason: "incomplete_evidence",
          citations: [],
          usage,
          honesty: {
            ...baseHonesty(ctx.model?.strategyRef),
            programNodes: program.nodes.length,
            valuesPublished: execution.valuesPublished,
            modelMapCalls: execution.modelMapCalls,
            rlmMapCalls: execution.rlmMapCalls,
          },
        },
      });
      return;
    }

    const validation = yield* validateCitations(handle, execution.committed.citations);
    const citations =
      evidence.invalidCitation === "fail" && validation.invalid.length > 0
        ? []
        : validation.validated;
    const oversized = execution.committed.text.length > budget.maxInlineOutputBytes;
    const honesty: RlmHonesty = {
      capsHit: oversized ? ["maxInlineOutputBytes"] : [],
      usageCompleteness: "unavailable",
      citationValidated: validation.validated.length,
      citationInvalid: validation.invalid.length,
      programNodes: program.nodes.length,
      valuesPublished: execution.valuesPublished,
      modelMapCalls: execution.modelMapCalls,
      rlmMapCalls: execution.rlmMapCalls,
      ...(ctx.model?.strategyRef !== undefined ? { strategyRef: ctx.model.strategyRef } : {}),
    };

    let result: RlmTerminalResult;
    if (oversized) {
      result = {
        _tag: "Partial",
        run: runSummary,
        reason: "oversized_inline_output",
        bestOutput: {
          _tag: "InlineValue",
          value: execution.committed.text.slice(0, budget.maxInlineOutputBytes),
          valueRef: execution.committed.valueRef,
          digest: execution.committed.digest,
        },
        citations,
        usage,
        honesty,
      };
    } else if (
      evidence.requireCitations &&
      citations.length < evidence.minimumCitations &&
      handle.manifest.coverage.entryCount > 0
    ) {
      result = {
        _tag: "Partial",
        run: runSummary,
        reason: "invalid_citations",
        bestOutput: {
          _tag: "InlineValue",
          value: execution.committed.text,
          valueRef: execution.committed.valueRef,
          digest: execution.committed.digest,
        },
        citations,
        usage,
        honesty,
      };
    } else {
      result = {
        _tag: "Completed",
        run: runSummary,
        output: {
          _tag: "InlineValue",
          value: execution.committed.text,
          valueRef: execution.committed.valueRef,
          digest: execution.committed.digest,
        },
        citations,
        usage,
        honesty,
      };
    }

    yield* ctx.emit({ _tag: "Terminal", runRef: request.runRef, result });
  });

const baseHonesty = (strategyRef?: string): RlmHonesty => ({
  capsHit: [],
  usageCompleteness: "unavailable",
  citationValidated: 0,
  citationInvalid: 0,
  programNodes: 0,
  valuesPublished: 0,
  modelMapCalls: 0,
  rlmMapCalls: 0,
  ...(strategyRef !== undefined ? { strategyRef } : {}),
});

export const rlmLayer = (options: MakeRlmOptions = {}): Layer.Layer<Rlm, never, RlmCorpusSource> =>
  Layer.effect(Rlm, makeRlm(options).pipe(Effect.map((shape) => Rlm.of(shape))));

export const rlmDeterministicLayer: Layer.Layer<Rlm, never, RlmCorpusSource> = rlmLayer({
  admitSemantic: false,
  model: { refuseSemantic: true },
});

export const runRlm = (request: RlmRequest): Effect.Effect<RlmTerminalResult, RlmError, Rlm> =>
  Effect.gen(function* () {
    const rlm = yield* Rlm;
    return yield* rlm.run(request);
  });

export const streamRlm = (request: RlmRequest): Stream.Stream<RlmEvent, RlmError, Rlm> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const rlm = yield* Rlm;
      return rlm.stream(request);
    }),
  );
