import { Effect } from "effect";
import type { RlmBudget } from "../schemas/budget.ts";
import type { RlmProgram, RlmProgramNode } from "../schemas/program.ts";
import type { RlmEvent } from "../schemas/events.ts";
import { RlmError } from "../schemas/errors.ts";
import type { RlmCorpusHandle } from "../corpus/handle.ts";
import type { RlmEnvironment } from "../environment/values.ts";
import {
  collectBoundedScan,
  compileRlmGrepRegex,
  grepEntries,
  mapRlmCorpusError,
} from "../interpreter/deterministic.ts";
import { topologicalNodes, validateProgram } from "./validate.ts";
import type { RlmCitation } from "../schemas/corpus.ts";
import { citationFromEntry } from "../corpus/citations.ts";

export interface ProgramExecutionResult {
  readonly committed?: {
    readonly valueRef: string;
    readonly text: string;
    readonly digest: string;
    readonly citations: ReadonlyArray<RlmCitation>;
  };
  readonly modelMapCalls: number;
  readonly rlmMapCalls: number;
  readonly modelCalls: number;
  readonly subcalls: number;
  readonly valuesPublished: number;
}

export interface ModelCallOptions {
  /** Refs of the program operation(s) that triggered this leaf model call. */
  readonly causalityRefs?: ReadonlyArray<string>;
}

export interface LeafModel {
  readonly complete: (
    prompt: string,
    options?: ModelCallOptions,
  ) => Effect.Effect<
    {
      readonly text: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    },
    RlmError
  >;
}

export interface ProgramRunnerDeps {
  readonly handle: RlmCorpusHandle;
  readonly env: RlmEnvironment;
  readonly budget: RlmBudget;
  readonly leafModel?: LeafModel | undefined;
  readonly depth: number;
  readonly runRef: string;
  readonly emit: (
    event: Record<string, unknown> & { readonly _tag: string; readonly runRef: string },
  ) => Effect.Effect<void>;
  readonly clockMs: () => Effect.Effect<number>;
  /** Recursive RLM for RlmMap children. */
  readonly runChildRlm?:
    | ((
        question: string,
        slicePayload: unknown,
        options?: ModelCallOptions,
      ) => Effect.Effect<
        {
          readonly text: string;
          readonly citations: ReadonlyArray<RlmCitation>;
        },
        RlmError
      >)
    | undefined;
}

export const executeProgram = (
  program: RlmProgram,
  deps: ProgramRunnerDeps,
): Effect.Effect<ProgramExecutionResult, RlmError> =>
  Effect.gen(function* () {
    yield* validateProgram(program, deps.budget);
    yield* deps.emit({
      _tag: "ProgramSelected",
      runRef: deps.runRef,
      programRef: program.programRef,
      nodeCount: program.nodes.length,
    });

    const order = topologicalNodes(program);
    let modelMapCalls = 0;
    let rlmMapCalls = 0;
    let modelCalls = 0;
    let subcalls = 0;
    let valuesPublished = 0;
    let committed: ProgramExecutionResult["committed"];

    for (const node of order) {
      yield* deps.emit({
        _tag: "ProgramNodeStarted",
        runRef: deps.runRef,
        nodeRef: node.nodeRef,
        kind: node._tag,
      });

      switch (node._tag) {
        case "CorpusOp": {
          if (node.operator === "Grep") {
            const pattern = String(node.params["pattern"] ?? "");
            // Tier S `CorpusOp` Grep matches Tier D semantics exactly: a full
            // regular expression, case-sensitive unless the node opts out with
            // `caseSensitive: false`. An invalid regex is a typed operation
            // contract violation, never a silent zero-hit result that would
            // later surface as `invalid_citations`.
            const caseSensitive = node.params["caseSensitive"] !== false;
            if (compileRlmGrepRegex(pattern, caseSensitive) === null) {
              return yield* new RlmError({
                reason: "operation_contract_violation",
                retryable: false,
                detailSafe: "invalid regex pattern in CorpusOp Grep",
              });
            }
            const entries = yield* collectBoundedScan(
              deps.handle,
              deps.budget.maxEntriesScannedPerOperation,
            );
            const { hits } = grepEntries(entries, pattern, caseSensitive, {
              maxScan: deps.budget.maxEntriesScannedPerOperation,
              maxHits: deps.budget.maxSpansPerOperation,
            });
            const citations = hits.map((h) => citationFromEntry(deps.handle, h));
            const payload = hits.map((h) => ({
              entryRef: h.entryRef,
              ordinal: h.ordinal,
              text: (h.text ?? "").slice(0, deps.budget.maxCharsPerSpan),
            }));
            yield* deps.env.publish({
              valueRef: node.outputValueRef,
              kind: "collection",
              payload,
              producingNodeRef: node.nodeRef,
              citations,
              preview: `grep hits=${hits.length}`,
            });
            valuesPublished += 1;
          } else if (node.operator === "OrdinalSlice") {
            const start = Number(node.params["start"] ?? 0);
            const endInclusive = Number(node.params["endInclusive"] ?? start);
            const slice = yield* deps.handle
              .read(
                { start, endInclusive },
                {
                  maxEntries: deps.budget.maxEntriesScannedPerOperation,
                  maxCharsPerEntry: deps.budget.maxCharsPerSpan,
                },
              )
              .pipe(Effect.mapError(mapRlmCorpusError));
            const citations = slice.map((h) => citationFromEntry(deps.handle, h));
            yield* deps.env.publish({
              valueRef: node.outputValueRef,
              kind: "collection",
              payload: slice.map((h) => ({
                entryRef: h.entryRef,
                ordinal: h.ordinal,
                text: h.text ?? "",
              })),
              producingNodeRef: node.nodeRef,
              citations,
            });
            valuesPublished += 1;
          } else if (node.operator === "InspectMetadata") {
            yield* deps.env.publish({
              valueRef: node.outputValueRef,
              kind: "json",
              payload: {
                corpusRef: deps.handle.identity.corpusRef,
                contentDigest: deps.handle.identity.contentDigest,
                entryCount: deps.handle.manifest.coverage.entryCount,
              },
              producingNodeRef: node.nodeRef,
            });
            valuesPublished += 1;
          } else {
            return yield* new RlmError({
              reason: "program_contract_violation",
              retryable: false,
              detailSafe: `unsupported CorpusOp ${node.operator}`,
            });
          }
          break;
        }
        case "Partition": {
          const input = yield* deps.env.get(node.inputValueRef);
          const items = Array.isArray(input.payload) ? input.payload : [input.payload];
          if (node.partCount > deps.budget.maxFanOut) {
            return yield* new RlmError({
              reason: "program_contract_violation",
              retryable: false,
              detailSafe: "unreservable fan-out",
            });
          }
          const parts: Array<unknown> = [];
          const n = Math.max(1, node.partCount);
          const size = Math.ceil(items.length / n) || 1;
          for (let i = 0; i < n; i++) {
            parts.push(items.slice(i * size, (i + 1) * size));
          }
          yield* deps.env.publish({
            valueRef: node.outputValueRef,
            kind: "collection",
            payload: parts,
            parentRefs: [node.inputValueRef],
            producingNodeRef: node.nodeRef,
            citations: input.citations,
          });
          valuesPublished += 1;
          break;
        }
        case "Transform": {
          if (node.operator === "TransformJoinText") {
            const texts: Array<string> = [];
            const citations: Array<RlmCitation> = [];
            for (const ref of node.inputValueRefs) {
              const v = yield* deps.env.get(ref);
              citations.push(...v.citations);
              if (typeof v.payload === "string") texts.push(v.payload);
              else if (Array.isArray(v.payload)) {
                for (const item of v.payload) {
                  if (typeof item === "string") texts.push(item);
                  else if (item && typeof item === "object" && "text" in item) {
                    texts.push(String((item as { text: unknown }).text));
                  } else texts.push(JSON.stringify(item));
                }
              } else texts.push(JSON.stringify(v.payload));
            }
            const joined = texts.join("\n");
            yield* deps.env.publish({
              valueRef: node.outputValueRef,
              kind: "text",
              payload: joined,
              parentRefs: node.inputValueRefs,
              producingNodeRef: node.nodeRef,
              citations,
              preview: joined.slice(0, 256),
            });
            valuesPublished += 1;
          } else if (node.operator === "TransformIdentity") {
            const v = yield* deps.env.get(node.inputValueRefs[0]!);
            yield* deps.env.publish({
              valueRef: node.outputValueRef,
              kind: v.kind,
              payload: v.payload,
              parentRefs: [v.valueRef],
              producingNodeRef: node.nodeRef,
              citations: v.citations,
            });
            valuesPublished += 1;
          } else {
            return yield* new RlmError({
              reason: "program_contract_violation",
              retryable: false,
              detailSafe: `unsupported Transform ${node.operator}`,
            });
          }
          break;
        }
        case "ModelMap": {
          const collection = yield* deps.env.get(node.inputCollectionRef);
          const items = flattenCollection(collection.payload);
          if (items.length > deps.budget.maxFanOut) {
            return yield* new RlmError({
              reason: "program_contract_violation",
              retryable: false,
              detailSafe: "unreservable ModelMap fan-out",
            });
          }
          if (deps.leafModel === undefined) {
            return yield* new RlmError({
              reason: "model_unavailable",
              retryable: false,
              detailSafe: "ModelMap requires a leaf model",
            });
          }
          yield* deps.emit({
            _tag: "MapStarted",
            runRef: deps.runRef,
            nodeRef: node.nodeRef,
            kind: "ModelMap",
            itemCount: items.length,
          });
          const concurrency = Math.min(
            node.maxConcurrency ?? deps.budget.maxConcurrentCalls,
            deps.budget.maxConcurrentCalls,
            Math.max(1, items.length),
          );
          const results = yield* mapConcurrent(items, concurrency, (item, index) =>
            Effect.gen(function* () {
              const prompt = node.promptTemplate
                .replaceAll("{{index}}", String(index))
                .replaceAll("{{item}}", stringifyItem(item));
              const out = yield* deps.leafModel!.complete(prompt, {
                causalityRefs: [node.nodeRef],
              });
              return { index, text: out.text };
            }),
          );
          // Deterministic order by index
          results.sort((a, b) => a.index - b.index);
          modelMapCalls += items.length;
          modelCalls += items.length;
          yield* deps.env.publish({
            valueRef: node.outputValueRef,
            kind: "collection",
            payload: results.map((r) => r.text),
            parentRefs: [node.inputCollectionRef],
            producingNodeRef: node.nodeRef,
            citations: collection.citations,
          });
          valuesPublished += 1;
          yield* deps.emit({
            _tag: "MapCompleted",
            runRef: deps.runRef,
            nodeRef: node.nodeRef,
            kind: "ModelMap",
            itemCount: items.length,
          });
          break;
        }
        case "RlmMap": {
          const collection = yield* deps.env.get(node.inputCollectionRef);
          const items = flattenCollection(collection.payload);
          if (items.length > deps.budget.maxFanOut) {
            return yield* new RlmError({
              reason: "program_contract_violation",
              retryable: false,
              detailSafe: "unreservable RlmMap fan-out",
            });
          }
          if (deps.runChildRlm === undefined) {
            return yield* new RlmError({
              reason: "invariant_violation",
              retryable: false,
              detailSafe: "RlmMap requires child runner",
            });
          }
          if (deps.depth + 1 > deps.budget.maxDepth) {
            return yield* new RlmError({
              reason: "program_contract_violation",
              retryable: false,
              detailSafe: "maxDepth would be exceeded by RlmMap",
            });
          }
          yield* deps.emit({
            _tag: "MapStarted",
            runRef: deps.runRef,
            nodeRef: node.nodeRef,
            kind: "RlmMap",
            itemCount: items.length,
          });
          const concurrency = Math.min(
            node.maxConcurrency ?? deps.budget.maxConcurrentCalls,
            deps.budget.maxConcurrentCalls,
            Math.max(1, items.length),
          );
          const results = yield* mapConcurrent(items, concurrency, (item, index) =>
            Effect.gen(function* () {
              const question = node.questionTemplate
                .replaceAll("{{index}}", String(index))
                .replaceAll("{{item}}", stringifyItem(item));
              const out = yield* deps.runChildRlm!(question, item, {
                causalityRefs: [node.nodeRef],
              });
              return { index, text: out.text, citations: out.citations };
            }),
          );
          results.sort((a, b) => a.index - b.index);
          rlmMapCalls += items.length;
          subcalls += items.length;
          const citations = results.flatMap((r) => r.citations);
          yield* deps.env.publish({
            valueRef: node.outputValueRef,
            kind: "collection",
            payload: results.map((r) => r.text),
            parentRefs: [node.inputCollectionRef],
            producingNodeRef: node.nodeRef,
            citations,
          });
          valuesPublished += 1;
          yield* deps.emit({
            _tag: "MapCompleted",
            runRef: deps.runRef,
            nodeRef: node.nodeRef,
            kind: "RlmMap",
            itemCount: items.length,
          });
          break;
        }
        case "ModelReduce": {
          const collection = yield* deps.env.get(node.inputCollectionRef);
          const items = flattenCollection(collection.payload);
          if (deps.leafModel === undefined) {
            return yield* new RlmError({
              reason: "model_unavailable",
              retryable: false,
              detailSafe: "ModelReduce requires a leaf model",
            });
          }
          const prompt = `${node.reducePrompt}\n\n${items.map(stringifyItem).join("\n")}`;
          const out = yield* deps.leafModel.complete(prompt, {
            causalityRefs: [node.nodeRef],
          });
          modelCalls += 1;
          yield* deps.env.publish({
            valueRef: node.outputValueRef,
            kind: "text",
            payload: out.text,
            parentRefs: [node.inputCollectionRef],
            producingNodeRef: node.nodeRef,
            citations: collection.citations,
            preview: out.text.slice(0, 256),
          });
          valuesPublished += 1;
          break;
        }
        case "Commit": {
          const value = yield* deps.env.get(node.valueRef);
          const citations: Array<RlmCitation> = [...value.citations];
          for (const ref of node.citationValueRefs) {
            const c = yield* deps.env.get(ref);
            citations.push(...c.citations);
          }
          const text =
            typeof value.payload === "string"
              ? value.payload
              : Array.isArray(value.payload)
                ? value.payload.map(stringifyItem).join("\n")
                : JSON.stringify(value.payload);
          committed = {
            valueRef: value.valueRef,
            text,
            digest: value.digest,
            citations,
          };
          break;
        }
      }

      yield* deps.emit({
        _tag: "ProgramNodeCompleted",
        runRef: deps.runRef,
        nodeRef: node.nodeRef,
        kind: node._tag,
      });
      if (valuesPublished > 0) {
        // value publish events already tracked
      }
    }

    return {
      ...(committed !== undefined ? { committed } : {}),
      modelMapCalls,
      rlmMapCalls,
      modelCalls,
      subcalls,
      valuesPublished,
    };
  });

const flattenCollection = (payload: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(payload)) return [payload];
  // If partition produced array-of-arrays, flatten one level for map over parts
  if (payload.every((p) => Array.isArray(p))) {
    return payload as ReadonlyArray<unknown>;
  }
  return payload;
};

const stringifyItem = (item: unknown): string => {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && "text" in item) {
    return String((item as { text: unknown }).text);
  }
  return JSON.stringify(item);
};

/** Bounded concurrent map preserving completion-order independence via index. */
const mapConcurrent = <A, B, E>(
  items: ReadonlyArray<A>,
  concurrency: number,
  f: (item: A, index: number) => Effect.Effect<B, E>,
): Effect.Effect<Array<B>, E> =>
  Effect.gen(function* () {
    if (items.length === 0) return [];
    const results = new Array<B>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () =>
      Effect.gen(function* () {
        while (true) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = yield* f(items[i]!, i);
        }
      }),
    );
    // Sequential for concurrency 1 to keep determinism simple under interruption
    if (concurrency <= 1) {
      for (let i = 0; i < items.length; i++) {
        results[i] = yield* f(items[i]!, i);
      }
      return results;
    }
    yield* Effect.all(workers, { concurrency: "unbounded", discard: true });
    return results;
  });
