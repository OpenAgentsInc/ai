# Public API specification

This document specifies the intended first-class TypeScript surface. Code in
this file is a target API sketch: names may be adjusted once during the
pre-stable implementation pass, but the semantics in [`SPEC.md`](./SPEC.md)
are fixed.

## 1. Package and export layout

The canonical consumer import is:

```ts
import { Rlm } from "@openagentsinc/ai/rlm";
```

The generic implementation lives in the granular `@openagentsinc/rlm`
package:

```ts
import { Rlm } from "@openagentsinc/rlm";
```

Required umbrella exports:

| Path                                             | Contract                                               |
| ------------------------------------------------ | ------------------------------------------------------ |
| `@openagentsinc/ai/rlm`                          | canonical first-class RLM API                          |
| `@openagentsinc/rlm`                             | direct generic implementation package                  |
| `@openagentsinc/ai/recall`                       | compatibility alias during pre-stable migration        |
| `@openagentsinc/ai`                              | selected stable RLM symbols, not every internal helper |
| `@openagentsinc/history-corpus/rlm`              | history adapter and compatibility re-export            |
| `@openagentsinc/history-corpus/recall`           | current Tier D compatibility path                      |
| `@openagentsinc/history-corpus/recursive-recall` | current engine compatibility path                      |

The canonical subpath exports only deliberate public contracts. Internal prompt
builders, mutable budget implementation, observation renderers, and raw parsing
compatibility helpers are not exported from `./rlm`.

`@openagentsinc/rlm` MUST NOT import history-specific scope, event-log, turn,
or renderer types. `@openagentsinc/history-corpus` depends on the generic
package to provide the authorized history corpus adapter and migration
wrappers; the dependency never points back into the adapter.

## 2. Public schemas

All schemas below export both the Schema value and its decoded TypeScript type.
Wire-facing schemas include explicit schema identifiers.

### Corpus identity

```ts
const RlmCorpusIdentity = Schema.Struct({
  schemaId: Schema.Literal("openagents.ai.rlm_corpus.v1"),
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  manifestDigest: RlmManifestDigest,
});

const RlmCorpusInput = Schema.Union([
  Schema.TaggedStruct("Source", {
    sourceRef: RlmCorpusSourceRef,
  }),
  Schema.TaggedStruct("Inline", {
    manifest: RlmCorpusManifest,
    entries: Schema.Array(RlmCorpusEntry),
  }),
]);
```

`Source` resolution goes through `RlmCorpusSource` and returns an immutable
`RlmCorpusHandle` with bounded range/scan methods. Inline corpora are decoded,
canonicalized, digest-checked, and limited to a conservative byte ceiling.
`HistoryCorpusScope` is adapted to an application-authorized source ref by the
history helper; it is not embedded in the generic core request.

The in-process source service returns a capability, not a wire value:

```ts
interface RlmCorpusHandle {
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
}
```

Every method is bounded. The handle is immutable for the run identity and
fails `corpus_changed` if the source no longer matches its resolved digest.

### Deterministic request

```ts
const RlmDeterministicRequest = Schema.TaggedStruct("Deterministic", {
  schemaId: Schema.Literal("openagents.ai.rlm_request.v1"),
  runRef: RlmRunRef,
  corpus: RlmCorpusInput,
  operation: RlmDeterministicOperation,
  limits: RlmDeterministicLimits,
});
```

This path is zero-spend and does not require a `LanguageModel` Layer.
`@openagentsinc/history-corpus` exports the history operation extensions and
compatibility mapping from `HistoryRecallQuestion`.

### Semantic request

```ts
const RlmSemanticRequest = Schema.TaggedStruct("Semantic", {
  schemaId: Schema.Literal("openagents.ai.rlm_request.v1"),
  runRef: RlmRunRef,
  corpus: RlmCorpusInput,
  question: RlmQuestion,
  budget: RlmBudget,
  evidence: RlmEvidencePolicy,
});

const RlmRequest = Schema.Union([RlmDeterministicRequest, RlmSemanticRequest]);
```

`RlmQuestion` is a bounded non-empty string. It is application data and is not
placed in default traces.

### Budget

The encoded budget uses integer milliseconds and counts so it can cross IPC or
HTTP without relying on runtime-only `Duration` objects:

```ts
const RlmBudget = Schema.Struct({
  maxDepth: RlmDepth,
  maxIterationsPerLoop: RlmPositiveCount,
  maxModelCalls: RlmPositiveCount,
  timeoutMs: RlmPositiveMilliseconds,
  maxInputTokens: RlmPositiveCount,
  maxOutputTokens: RlmPositiveCount,
  maxTotalTokens: RlmPositiveCount,
  maxSubcalls: RlmNonNegativeCount,
  maxProgramNodesPerIteration: RlmPositiveCount,
  maxProgramNodes: RlmPositiveCount,
  maxFanOut: RlmPositiveCount,
  maxFanIn: RlmPositiveCount,
  maxConcurrentCalls: RlmPositiveCount,
  maxValues: RlmPositiveCount,
  maxCollectionItems: RlmPositiveCount,
  maxValueBytes: RlmPositiveCount,
  maxEnvironmentBytes: RlmPositiveCount,
  maxInlineOutputBytes: RlmPositiveCount,
  maxArtifactOutputBytes: RlmNonNegativeCount,
  maxPromptTokensPerCall: RlmPositiveCount,
  maxOutputTokensPerCall: RlmPositiveCount,
  maxObservationChars: RlmPositiveCount,
  maxTranscriptChars: RlmPositiveCount,
  maxEntriesScannedPerOperation: RlmPositiveCount,
  maxSpansPerOperation: RlmPositiveCount,
  maxCharsPerSpan: RlmPositiveCount,
  requireExactUsage: Schema.Boolean,
});
```

The implementation converts `timeoutMs` to `Duration.millis` at the boundary.
SDK hard ceilings apply after decoding. Semantic defaults are exported as a
frozen value and are intentionally conservative.

### Evidence policy

```ts
const RlmEvidencePolicy = Schema.Struct({
  requireCitations: Schema.Boolean,
  minimumCitations: RlmNonNegativeCount,
  invalidCitation: Schema.Literals(["partial", "fail"]),
  requireCompleteCorpusCoverage: Schema.Boolean,
});
```

OpenAgents uses required citations, at least one citation for a non-empty
answer, and `invalidCitation: "partial"`.

### Symbolic values and programs

```ts
const RlmValueDescriptor = Schema.Struct({
  valueRef: RlmValueRef,
  kind: RlmValueKind,
  schemaRef: Schema.optionalKey(RlmSchemaRef),
  digest: RlmDigest,
  encodedBytes: RlmNonNegativeCount,
  itemCount: Schema.optionalKey(RlmNonNegativeCount),
  parentRefs: Schema.Array(RlmValueRef),
  lineage: RlmValueLineage,
  preview: Schema.optionalKey(RlmBoundedText),
});

const RlmProgramNode = Schema.Union([
  RlmCorpusOpNode,
  RlmPartitionNode,
  RlmTransformNode,
  RlmModelMapNode,
  RlmMapNode,
  RlmModelReduceNode,
  RlmCommitNode,
]);

const RlmProgram = Schema.Struct({
  schemaId: Schema.Literal("openagents.ai.rlm_program.v1"),
  nodes: Schema.Array(RlmProgramNode),
});
```

Every node has a stable `nodeRef`, explicit input refs, and declared output
refs. The decoder plus graph validator rejects cycles, missing refs, duplicate
outputs, excessive graph size, and fan-out that cannot fit the remaining
budget before execution.

`RlmModelMapNode` runs one-shot leaf calls and does not increase RLM depth.
`RlmMapNode` runs child RLM loops and does increase depth. Both publish an
ordered collection value independent of fiber completion order.

`RlmCommitNode` references an existing value. It does not contain newly
generated free-form final prose.

### Usage

```ts
const RlmTokenUsage = Schema.Struct({
  inputTokens: Schema.optionalKey(RlmNonNegativeCount),
  outputTokens: Schema.optionalKey(RlmNonNegativeCount),
  totalTokens: Schema.optionalKey(RlmNonNegativeCount),
  completeness: Schema.Literals(["complete", "partial", "unavailable"]),
  modelCalls: RlmNonNegativeCount,
  subcalls: RlmNonNegativeCount,
});
```

Absent token counts are unknown. They are never encoded as zero unless the
provider explicitly reported zero.

### Citation

```ts
const RlmCitation = Schema.Struct({
  corpusRef: RlmCorpusRef,
  contentDigest: RlmCorpusDigest,
  scopeRef: RlmScopeRef,
  sourceAddress: RlmSourceAddress,
  entryRefStart: RlmEntryRef,
  entryRefEnd: Schema.optionalKey(RlmEntryRef),
  excerpt: Schema.optionalKey(RlmBoundedText),
  excerptDigest: Schema.optionalKey(RlmDigest),
});
```

`RlmSourceAddress` contains a bounded address-schema id and canonical encoded
address validated by the resolved corpus handle. The history adapter exports a
`HistoryRlmSourceAddress` Schema containing thread/turn and inclusive sequence
range fields. Generic core code does not import those history types.

Entry-ref ranges are validated against corpus order and source lineage. A
history sequence start greater than end fails in the adapter Schema before
citation validation.

## 3. Terminal result

The service preserves the distinction between deterministic findings and a
semantic answer:

```ts
const RlmOutput = Schema.Union([
  Schema.TaggedStruct("DeterministicFindings", {
    findings: Schema.Array(RlmFinding),
  }),
  Schema.TaggedStruct("InlineValue", {
    value: RlmBoundedOutput,
    valueRef: RlmValueRef,
    digest: RlmDigest,
  }),
  Schema.TaggedStruct("Artifact", {
    artifact: RlmArtifactDescriptor,
    valueRef: RlmValueRef,
  }),
]);
```

An `RlmFinding` is an exact Tier D span/excerpt with its citation. Tier D never
pretends to synthesize prose.

```ts
const RlmCompleted = Schema.TaggedStruct("Completed", {
  run: RlmRunSummary,
  output: RlmOutput,
  citations: Schema.Array(RlmCitation),
  usage: RlmTokenUsage,
  honesty: RlmHonesty,
});

const RlmPartial = Schema.TaggedStruct("Partial", {
  run: RlmRunSummary,
  reason: RlmPartialReason,
  bestOutput: Schema.optionalKey(RlmOutput),
  citations: Schema.Array(RlmCitation),
  usage: RlmTokenUsage,
  honesty: RlmHonesty,
});

const RlmRefused = Schema.TaggedStruct("Refused", {
  run: RlmRunSummary,
  reason: RlmRefusalReason,
  usage: RlmTokenUsage,
  honesty: RlmHonesty,
});

const RlmTerminalResult = Schema.Union([RlmCompleted, RlmPartial, RlmRefused]);
```

`RlmHonesty` includes corpus coverage/exclusion summaries, hit caps,
transcript and observation truncation, usage completeness, program nodes and
values produced, model/RLM map counts, environment/artifact bytes, the
strategy ref, and citation-validation counts.

## 4. Errors

Public errors are Schema-tagged and safe to serialize:

```ts
class RlmError extends Schema.TaggedErrorClass<RlmError>()("Rlm.Error", {
  reason: Schema.Literals([
    "invalid_request",
    "invalid_budget",
    "corpus_unavailable",
    "corpus_changed",
    "model_authentication",
    "model_quota_exhausted",
    "model_rate_limited",
    "model_unavailable",
    "program_contract_violation",
    "operation_contract_violation",
    "value_unavailable",
    "artifact_unavailable",
    "per_call_limit_exceeded",
    "usage_required_but_unavailable",
    "invariant_violation",
  ]),
  retryable: Schema.Boolean,
  detailSafe: Schema.optionalKey(RlmBoundedText),
}) {}
```

The in-process implementation may retain a private `cause` for tracing. The
encoded error omits raw provider bodies, prompts, corpus text, and credentials.

## 5. Progress events

`RlmEvent` is a Schema union with these stable categories:

```ts
type RlmEvent =
  | RlmRunStarted
  | RlmCorpusResolved
  | RlmIterationStarted
  | RlmProgramSelected
  | RlmProgramNodeStarted
  | RlmProgramNodeCompleted
  | RlmObservationCompleted
  | RlmValuePublished
  | RlmValueEvicted
  | RlmMapStarted
  | RlmMapCompleted
  | RlmSubcallStarted
  | RlmSubcallCompleted
  | RlmModelCallCompleted
  | RlmArtifactWriteStarted
  | RlmArtifactWriteCompleted
  | RlmBudgetChanged
  | RlmContractRetry
  | RlmTerminalEvent;
```

Every event includes `runRef`, a monotonic run-local `eventSequence`, and a
timestamp obtained from the Effect `Clock`. Recursive events also carry depth,
iteration, and parent call/subcall refs.

`RlmTerminalEvent` contains exactly one `RlmTerminalResult`. Errors remain in
the Stream error channel rather than being emitted as fake successful events.

## 6. Services and constructors

Target exports:

```ts
export class Rlm extends Context.Service<Rlm, RlmShape>()("@openagentsinc/ai/Rlm") {}

export class RlmCorpusSource extends Context.Service<RlmCorpusSource, RlmCorpusSourceShape>()(
  "@openagentsinc/ai/RlmCorpusSource",
) {}

export class RlmOperatorRegistry extends Context.Service<
  RlmOperatorRegistry,
  RlmOperatorRegistryShape
>()("@openagentsinc/ai/RlmOperatorRegistry") {}

export class RlmArtifactSink extends Context.Service<RlmArtifactSink, RlmArtifactSinkShape>()(
  "@openagentsinc/ai/RlmArtifactSink",
) {}

export interface RlmArtifactSinkShape {
  readonly write: (
    request: RlmArtifactWriteRequest,
  ) => Effect.Effect<RlmArtifactDescriptor, RlmArtifactError>;
}

export interface RlmShape {
  readonly stream: (request: RlmRequest) => Stream.Stream<RlmEvent, RlmError>;

  readonly run: (request: RlmRequest) => Effect.Effect<RlmTerminalResult, RlmError>;
}

export const makeRlm: (
  options: MakeRlmOptions,
) => Effect.Effect<RlmShape, never, RlmCorpusSource | RlmOperatorRegistry>;

export const rlmLayer: (
  options: RlmLayerOptions,
) => Layer.Layer<Rlm, never, RlmCorpusSource | RlmOperatorRegistry>;

export const rlmDeterministicLayer: Layer.Layer<Rlm, never, RlmCorpusSource>;
```

`RlmLayerOptions` contains trusted model Layers, safe model refs, a versioned
`strategyRef`/prompt profile, per-call root/leaf limits, the admitted operator
catalog, SDK policy, default budgets, and optionally an artifact sink Layer.
It does not contain source-store authorization, pricing, or application
authority.

Convenience accessors mirror Effect AI:

```ts
export const runRlm = (
  request: RlmRequest,
): Effect.Effect<RlmTerminalResult, RlmError, Rlm>

export const streamRlm = (
  request: RlmRequest,
): Stream.Stream<RlmEvent, RlmError, Rlm>
```

## 7. Corpus construction

Current public corpus APIs remain available:

```ts
buildHistoryCorpus(input);
corpusEntriesToJsonl(entries);
HistoryCorpus;
HistoryCorpusEntry;
HistoryCorpusManifest;
HistoryCorpusPolicy;
```

The first-class pass adds:

```ts
canonicalizeRlmCorpus(corpus);
digestRlmCorpus(corpus);
digestRlmManifest(manifest);
validateRlmCorpus(corpus);
validateRlmCitation(corpus, citation);
validateRlmCitations(corpus, citations);
makeInlineRlmCorpusHandle(corpus);
RlmCorpusHandle;
RlmCorpusSourceRef;
```

The builder will add stable ordinals, entry refs, schema identity, and content
digest without removing existing fields during the pre-stable compatibility
window.

The generic handle supports bounded metadata, range reads, and streaming scan
operations. History-specific builders adapt their authorized scope to this
handle; callers do not receive an unrestricted store reader.

## 8. Deterministic use

```ts
import { Effect } from "effect";
import { Rlm, rlmDeterministicLayer } from "@openagentsinc/ai/rlm";

const program = Effect.gen(function* () {
  const rlm = yield* Rlm;

  return yield* rlm.run({
    _tag: "Deterministic",
    schemaId: "openagents.ai.rlm_request.v1",
    runRef: "rlm.run.deploy-search",
    corpus: {
      _tag: "Source",
      sourceRef: "openagents.current-thread",
    },
    operation: {
      _tag: "Grep",
      pattern: "deploy",
    },
    limits: {
      maxSpans: 20,
      maxEntriesScanned: 10_000,
      maxCharsPerSpan: 400,
    },
  });
}).pipe(Effect.provide(rlmDeterministicLayer), Effect.provide(myAuthorizedCorpusSourceLayer));
```

No model Layer is needed and `usage.modelCalls` must be zero.

## 9. Semantic use

```ts
import { Effect } from "effect";
import { Rlm, rlmLayer } from "@openagentsinc/ai/rlm";

const program = Effect.gen(function* () {
  const rlm = yield* Rlm;

  return yield* rlm.run({
    _tag: "Semantic",
    schemaId: "openagents.ai.rlm_request.v1",
    runRef: "rlm.run.architecture-decision",
    corpus: {
      _tag: "Source",
      sourceRef: "openagents.current-thread",
    },
    question: "What did we decide about the deployment boundary, and why?",
    budget: conservativeRlmBudget,
    evidence: {
      requireCitations: true,
      minimumCitations: 1,
      invalidCitation: "partial",
      requireCompleteCorpusCoverage: false,
    },
  });
}).pipe(
  Effect.provide(
    rlmLayer({
      rootModel: myRootLanguageModelLayer,
      leafModel: myCheaperLeafLanguageModelLayer,
      rootModelRef: "provider/root-policy-v1",
      leafModelRef: "provider/leaf-policy-v1",
      strategyRef: "openagents.history-rlm.v1",
      promptProfile: openAgentsHistoryPromptProfile,
      rootLimits: rootPerCallLimits,
      leafLimits: leafPerCallLimits,
    }),
  ),
  Effect.provide(myAuthorizedCorpusSourceLayer),
);
```

Provider choice and credentials are embedded in the supplied model Layers,
never the request.

## 10. Streaming progress

```ts
import { Stream } from "effect";
import { streamRlm } from "@openagentsinc/ai/rlm";

const consume = streamRlm(request).pipe(
  Stream.runForEach((event) => {
    switch (event._tag) {
      case "RlmModelCallCompleted":
        return recordExactUsage(event);
      case "RlmBudgetChanged":
        return renderProgress(event);
      case "RlmTerminal":
        return renderTerminal(event.result);
      default:
        return Effect.void;
    }
  }),
);
```

Consumer code should handle events exhaustively. The SDK provides safe event
schemas for IPC/SSE encoding but does not prescribe a UI framework.

## 11. Effect Tool adapter

The canonical helper is:

```ts
makeRlmTool({
  name?: string, // defaults to "history_recall"
  description?: string,
  admittedModes: ReadonlySet<"deterministic" | "semantic">,
  clampBudget: (requested) => RlmBudget,
  resolveScope: (toolInput) => Effect<RlmCorpusInput, RlmToolError>,
})
```

It returns an Effect AI `Tool` whose handler requires `Rlm`. The application
owns `resolveScope`; a model cannot provide an unchecked thread/run id. The
handler uses preliminary results for safe progress when supported.

OpenAgents projects the Tool through
`harnessHostToolSpecFromTool`/`resolveHostToolCall`; the SDK does not add a
parallel harness-tool protocol.

## 12. Compatibility exports

These current exports remain temporarily:

- `HistoryRecall`;
- `historyRecallTierDLayer`;
- `recallTierD`;
- `runRecursiveRecall`;
- `RecursiveRecallCaps`;
- `RecursiveRecallOp`;
- `RecursiveRecallResult`.

`runRecursiveRecall` becomes a wrapper over the semantic engine for an inline
corpus. Its current `Effect<RecursiveRecallResult, never, LanguageModel>` shape
cannot express the full target error separation; it is therefore compatibility
surface, not the canonical API.

The wrapper preserves old tags while correcting unsafe behavior additively
where possible. Deprecation begins only after OpenAgents consumes the new
service through npm and a migration release has shipped.
