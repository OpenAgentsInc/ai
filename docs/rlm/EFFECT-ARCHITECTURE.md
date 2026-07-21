# Effect architecture

This document defines how the RLM specification maps onto Effect. It is
normative for implementation structure and resource behavior; exact symbol
names are collected in [`PUBLIC-API.md`](./PUBLIC-API.md).

## 1. Design rules

The implementation follows these Effect rules:

1. External data is described and decoded with Effect Schema.
2. Capabilities are services; implementations are Layers.
3. Expected incomplete outcomes are values; operational failures use the typed
   error channel; interruption remains interruption.
4. Progress is a `Stream`, not an unscoped callback or event emitter.
5. Time comes from `Clock`; tests use `TestClock`.
6. Shared recursive budgets use Effect concurrency primitives, not mutable
   process-global state.
7. All fibers are scoped under the run. No detached background work survives
   cancellation.
8. The injected `effect/unstable/ai` `LanguageModel` remains the model
   abstraction. The SDK does not define a competing provider interface.
9. Model programs are generated with `LanguageModel.generateObject` and an
   Effect Schema.
10. Retry/fallback is supplied by the model Layer or `ExecutionPlan`; the RLM
    engine does not hide provider retries.
11. Symbolic values are immutable, digest-addressed, run-scoped, and accessed
    through refs rather than copied into model history.
12. Programmatic fan-out uses scoped Effect fibers, atomic reservations, and a
    global semaphore. No detached promise/fiber owns RLM work.
13. Deterministic extension operators are pure capabilities with explicit
    Schemas and cost declarations; arbitrary model-authored code is forbidden.

## 2. Service graph

```text
RlmCorpusSource ───────────────┐
                              │
RlmOperatorRegistry ──────────┤
                              │
LanguageModel root Layer ─────┼──> RlmLive Layer ──> Rlm service
                              │                        run
LanguageModel leaf Layer? ────┤                        stream
                              │
RlmPolicy / strategy profile ─┤
                              │
RlmArtifactSink? ─────────────┤
                              │
Clock / Tracer / Logger ──────┘

Per-run internals allocated inside RlmLive:
  RlmEnvironment, value store, budget Ref, Semaphore, queues, Scope

Optional consumer-side services, deliberately outside RlmLive:
  price catalog, exact-usage ledger, app authorization, durable event writer,
  Full Auto authority, verification and settlement
```

### `RlmCorpusSource`

`RlmCorpusSource` resolves an authorized logical source ref or small inline
input into an immutable corpus handle. Its Layer captures store access and
caller authority. The request does not carry a visibility allowlist that can
widen access.

```ts
interface RlmCorpusSourceShape {
  readonly resolve: (input: RlmCorpusInput) => Effect.Effect<RlmCorpusHandle, RlmCorpusError>;
}
```

Inline corpora remain supported for hermetic tests and already-authorized
small callers. They are decoded and their digest is verified before execution.
Large inputs use handles with bounded ordinal/range reads and streaming scans;
the engine does not require a second full materialization.

### `RlmEnvironment`

`RlmEnvironment` is a private per-run capability. It publishes immutable
values, ordered collections, lineage, digests, and bounded previews. Public
programs can name refs but cannot obtain an ambient mutable store. The
environment is finalized with the run and is non-durable unless an admitted
artifact sink receives the committed output.

### `RlmOperatorRegistry`

The registry is trusted construction-time configuration. It contains the core
deterministic corpus/value operators and MAY contain application-supplied pure
operators. Each entry supplies a parameter Schema, an implementation over a
narrow value-reader/writer capability, and declared cost dimensions. It cannot
access provider credentials, arbitrary Layers, application Tools, or the
filesystem.

### `RlmArtifactSink`

The optional sink accepts only the committed value stream and returns a safe
artifact descriptor. It owns storage authorization, retention, and fetch
policy. The default SDK Layer has no durable sink; an oversized inline result
therefore becomes an honest partial outcome.

### `Rlm`

`Rlm` is a `Context.Service` with two methods:

```ts
interface RlmShape {
  readonly stream: (request: RlmRequest) => Stream.Stream<RlmEvent, RlmError>;

  readonly run: (request: RlmRequest) => Effect.Effect<RlmTerminalResult, RlmError>;
}
```

`stream` is canonical. `run` drains `stream`, verifies that exactly one
terminal event was produced, and returns its result. The two methods MUST share
the same engine and conformance tests.

### Deterministic service

The existing `HistoryRecall` service remains the narrow zero-model-call
contract. `RlmLive` delegates deterministic requests to it. Semantic requests
use the recursive engine. This keeps Tier D independently usable in runtimes
that cannot or must not provide a `LanguageModel`.

## 3. Layer construction

The public constructors distinguish pure values, service implementations, and
Layer wiring:

- `makeRlm(...)` constructs an `RlmShape` from already-resolved dependencies.
- `Rlm.layer(...)` or `rlmLayer(...)` captures policies and model plans and
  provides the `Rlm` service.
- `RlmCorpusSource.layer(...)` is supplied by the application/store adapter.
- `RlmOperatorRegistry.layer(...)` provides the core pure operator catalog and
  any admitted application extensions.
- `RlmArtifactSink.layer(...)` is optional and host-owned.
- `Rlm.layerDeterministic(...)` provides a zero-model-call implementation and
  must not require `LanguageModel`.
- `Rlm.layerSemantic(...)` requires a root model plan and optionally a leaf
  model plan.

Layer creation SHOULD capture long-lived clients and model services once.
Per-run Refs, queues, scopes, deadlines, and trace state MUST be allocated per
invocation, never shared between unrelated runs.

The model plan is trusted construction-time configuration, not request data:

```ts
interface RlmModelPlan {
  readonly root: Layer.Layer<LanguageModel.LanguageModel>;
  readonly leaf?: Layer.Layer<LanguageModel.LanguageModel>;
  readonly rootModelRef: RlmModelRef;
  readonly leafModelRef?: RlmModelRef;
  readonly strategyRef: RlmStrategyRef;
  readonly promptProfile: RlmPromptProfile;
  readonly rootLimits: RlmPerCallLimits;
  readonly leafLimits: RlmPerCallLimits;
}
```

If no leaf Layer is provided, subcalls use the root Layer. An application may
provide a cheaper leaf model, matching the RLM paper's heterogeneous root/leaf
shape. Model identity is recorded as a safe caller-supplied ref; credentials
and provider options never enter results or progress events.

OpenAgents chooses these Layers through its existing provider/account policy
before calling the SDK. The RLM request cannot rotate accounts or bypass
account health.

The strategy/profile is versioned because the paper shows that one fixed RLM
prompt can produce materially different decomposition and runaway-subcall
behavior across models. Per-call limits reserve provider context and output
headroom before invocation; the global run budget is not a substitute for
model-specific fit checks.

## 4. Schema design

All public request, result, event, citation, manifest, and error payloads MUST
have Effect Schemas and encoded twins where Effect requires them. Tagged unions
use `_tag` and `Schema.TaggedStruct` or `Schema.TaggedErrorClass`.

Numeric contracts use refined schemas rather than bare `Schema.Number`:

- counts are finite non-negative integers;
- positive limits exclude zero when zero would create ambiguous behavior;
- maximum depth and concurrency have SDK hard ceilings;
- timestamps use one declared ISO representation;
- digests are branded/validated strings;
- refs are bounded non-empty strings.

Decoding happens at every untrusted boundary:

- network or IPC requests;
- inline corpus inputs;
- persisted manifests;
- model-produced operations;
- consumer-provided durable state.

Internal functions MAY accept decoded values and avoid redundant decoding, but
public helpers MUST make the boundary explicit.

## 5. Structured program output

The current seed engine calls `generateText`, strips fences, parses JSON, and
decodes the result. The target engine replaces that sequence with:

```ts
const response =
  yield *
  LanguageModel.generateObject({
    prompt,
    objectName: "rlm_program",
    schema: RlmProgram,
    toolChoice: "none",
  });

const program = response.value;
```

This uses Effect AI's provider-compatible codec transformation and typed error
channel. Provider structured-output failures are still bounded contract
failures and may consume the configured contract-retry allowance.

The engine validates the complete graph, resolves refs, derives worst-case
fan-out, and reserves budgets before executing its first node. Programs are
finite DAGs rather than arbitrary code or one explicit subcall action.

The engine MUST NOT model corpus/value operations as externally executable
provider tools. Nodes are pure local commands interpreted by the RLM engine.
This prevents a provider from turning RLM traversal into side effects and
avoids confusing Effect AI's intra-call tool-resolution loop with RLM
recursion.

## 6. Budget state

### Per-run state

A per-run `Ref` or `SynchronizedRef` holds the global budget state:

```ts
interface RlmBudgetState {
  readonly modelCallsReserved: number;
  readonly modelCallsCompleted: number;
  readonly subcallsReserved: number;
  readonly programNodesReserved: number;
  readonly valuesPublished: number;
  readonly liveValueBytes: number;
  readonly artifactBytes: number;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly usageCompleteness: "complete" | "partial" | "unavailable";
  readonly maxDepthUsed: number;
  readonly observationsChars: number;
  readonly transcriptChars: number;
}
```

State transitions are centralized. Root and child loops MUST NOT directly
mutate a shared JavaScript object.

### Structured map concurrency

Programmatic map nodes support bounded concurrency:

- whole-node fan-out, call/subcall, per-call estimate, value-byte, and artifact
  capacity is reserved atomically;
- a `Semaphore` enforces global concurrency;
- child work is forked with scoped/structured combinators;
- first failure interrupts only the policy-defined siblings;
- final observations are ordered by the source operation's declared order,
  not fiber completion time;
- token and call caps remain global.

No use of `Promise.all`, detached `Effect.runFork`, or unscoped queues is
permitted inside the engine.

The implementation MUST pass the same ordering and accounting suite at
concurrency `1` and greater than `1`. Applications may clamp concurrency to
`1`, but the first-class engine cannot require one new root-model iteration per
mapped child.

## 7. Time and interruption

Run deadlines use `Effect.timeout`/`Effect.timeoutOption` with `Duration` and
the current `Clock`. The deadline wraps the entire recursive tree. Child loops
must not create independent full-length timeouts.

Cancellation behavior:

- interrupting `Rlm.run` interrupts the active model call and all descendants;
- closing the scope of `Rlm.stream` interrupts its producer;
- finalizers close queues/subscriptions and release Layer-scoped resources;
- interruption does not emit `Partial(timeout)`;
- an actual clock deadline yields the domain `Partial(timeout)` terminal value;
- the SDK starts no work after a terminal result or interruption.

Tests MUST distinguish timeout from external interruption.

## 8. Progress stream implementation

The engine SHOULD implement progress with a scoped queue or direct stream
composition. Whichever implementation is used:

- producer fibers are scoped;
- queue shutdown is a finalizer;
- backpressure is bounded;
- the terminal event is enqueued once;
- program-node, value-publication, map-batch, and artifact events expose refs
  and sizes only;
- raw model or corpus content is not placed in progress events;
- `run` and `stream` observe identical terminal semantics.

A slow progress consumer MUST NOT create unbounded memory. The implementation
MAY conflate replaceable budget/progress snapshots, but MUST NOT drop terminal
events, model-call usage events, or error causality.

## 9. Errors and domain values

The Effect channel separation is:

| Situation                               | Representation                            |
| --------------------------------------- | ----------------------------------------- |
| Budget exhausted                        | `Partial` value                           |
| Timeout deadline reached                | `Partial` value                           |
| Policy disallows semantic mode          | `Refused` value                           |
| Required citation does not validate     | `Partial` value                           |
| External fiber interruption             | interruption cause                        |
| Corpus store unavailable                | `RlmError`                                |
| Model auth/quota/rate limit/unavailable | `RlmError` with safe reason               |
| Repeated invalid structured program     | `RlmError`                                |
| SDK invariant violation                 | `RlmError` plus defect capture internally |

The engine SHOULD avoid `Effect.catchDefect` around the entire run as a way to
turn arbitrary defects into normal business values. Known boundary exceptions
are caught at their source and mapped to typed errors. True defects remain
visible to Effect supervision/tracing, with only an outer transport boundary
performing safe serialization if required.

## 10. Usage and retry

Each model call receives a deterministic run-local `callRef`. A completed call
emits:

- role (`root` or `leaf`);
- depth and iteration;
- safe model ref supplied by the Layer;
- finish reason;
- optional exact input/output/total token fields;
- usage completeness;
- duration.

The RLM SDK aggregates usage but does not own an application ledger. OpenAgents
persists each call with an idempotency key derived from `(rlmRunRef, callRef)`.

Retries supplied by a model `ExecutionPlan` are model-layer behavior. The
caller must ensure its Layer exposes correct per-attempt usage if retry spend
must be ledgered. RLM contract retries caused by invalid programs are visible
separate calls and always count against RLM budgets.

## 11. Tracing, logs, and metrics

The live implementation wraps work in spans:

- `openagents.rlm.run`;
- `openagents.rlm.corpus.resolve`;
- `openagents.rlm.iteration`;
- `openagents.rlm.program`;
- `openagents.rlm.program_node`;
- `openagents.rlm.value`;
- `openagents.rlm.model_call`;
- `openagents.rlm.subcall`;
- `openagents.rlm.artifact`.

Safe span attributes include run ref, corpus digest prefix, mode, operation
kind, strategy ref, depth, iteration, counts, encoded byte sizes, cap names,
duration, and usage completeness.

Forbidden default attributes and log fields include corpus text, question
text, answer text, model raw output, reasoning, credentials, account refs that
the consumer classifies private, and provider error bodies.

The SDK emits semantic progress/usage events and Effect spans. It SHOULD NOT
install a global logger, tracer, or metric exporter. Applications provide
observability Layers.

## 12. Tool integration

The SDK exposes an Effect AI `Tool` constructor rather than a bespoke callback
interface. The handler depends on `Rlm` and returns the public terminal result
schema.

The tool input contains an authorized logical scope selector, question or
deterministic operation, admitted mode, and caller-reducible caps. It does not
contain visibility/redaction policy, provider credentials, model names, or an
arbitrary filesystem path.

Effect AI `HandlerContext.preliminary` may carry bounded progress summaries.
The existing harness toolkit bridge then projects the tool into
`HarnessHostToolSpec` and routes approvals through the canonical runtime
interaction model. RLM itself performs no side effect requiring approval, but
applications may require approval for semantic spend.

## 13. Vercel AI SDK relationship

The reference AI SDK demonstrates several useful shapes:

- an explicit bounded loop (`stopWhen`);
- per-step preparation and state (`prepareStep`);
- schema-constrained output;
- separated tool execution and result messages;
- telemetry around steps and model calls;
- an explicit sandbox contract rather than assuming isolation.

The OpenAgents RLM engine re-derives those lessons in Effect but does not use
`ToolLoopAgent` as its runtime. RLM needs global recursive budgets, immutable
corpus identity, citation validation, Effect interruption, and a typed progress
stream. Those requirements are clearer as an Effect service specialized for
corpus traversal.
