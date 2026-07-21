# Recursive Language Model support

**Status:** normative design for the first-class RLM surface of the
OpenAgents AI SDK. The contracts in this folder are the implementation target;
[`CURRENT-SURFACE.md`](./CURRENT-SURFACE.md) records what `0.1.2-rc.1` already
ships and the compatibility work still required.

**Decision date:** 2026-07-21  
**SDK home:** `OpenAgentsInc/ai`  
**Canonical public entry point:** `@openagentsinc/ai/rlm`  
**Implementation package for v1:** `@openagentsinc/history-corpus`

## Product contract

The SDK's RLM support lets an application ask bounded, cited questions over a
durable corpus without putting the entire corpus into a model context window.
It consists of:

1. a deterministic, immutable, redaction-aware corpus;
2. zero-model-call deterministic traversal;
3. an Effect-native recursive semantic engine;
4. one typed service and one progress stream;
5. global budgets, exact-usage honesty, and citation validation;
6. an Effect `Tool` adapter for agent and harness consumption.

The corpus remains outside the root model's context. The model receives
constant-size corpus metadata and bounded observations produced by typed
operations. It may ask for a bounded recursive subcall over an explicit corpus
span. It cannot execute arbitrary code, dereference private refs, widen the
corpus policy, select credentials, or escape the global run budgets.

An RLM result is evidence, not authority. A completed result is still a cited
candidate. It cannot independently authorize a route, accept work, verify a
claim, release software, spend funds, or change settlement state.

## Reading order

1. [`SPEC.md`](./SPEC.md) — normative behavior, schemas, budgets, citations,
   privacy, and lifecycle.
2. [`EFFECT-ARCHITECTURE.md`](./EFFECT-ARCHITECTURE.md) — services, Layers,
   structured concurrency, model calls, tracing, and testability.
3. [`PUBLIC-API.md`](./PUBLIC-API.md) — package exports and TypeScript API
   target, with consumer examples.
4. [`OPENAGENTS-CONSUMPTION.md`](./OPENAGENTS-CONSUMPTION.md) — the exact
   adapter boundary and rollout for the `OpenAgentsInc/openagents` consumer.
5. [`CONFORMANCE.md`](./CONFORMANCE.md) — required contract, safety,
   interruption, and evaluation gates.
6. [`CURRENT-SURFACE.md`](./CURRENT-SURFACE.md) — shipped seed implementation,
   gaps, compatibility, and the ordered delivery plan.

## Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative. They describe the public SDK contract rather than a particular app's
internal implementation.

## Fixed decisions

- RLM is a first-class L6 SDK feature, not desktop-only wiring.
- The public discoverability path is `@openagentsinc/ai/rlm`.
- V1 remains implemented in `@openagentsinc/history-corpus`; a new package is
  not justified while history/evidence is the only proven corpus family.
- `@openagentsinc/ai/recall` remains as a compatibility alias through the
  pre-stable migration.
- The engine is Effect-native. There is no Python runtime, REPL, `eval`,
  arbitrary shell, or dependency on the upstream `rlms` package.
- Effect AI's `LanguageModel` is the model substrate. The SDK does not fork or
  duplicate `effect/unstable/ai`.
- The model emits operations through `LanguageModel.generateObject` and an
  Effect Schema. Free-form JSON parsing is compatibility code, not the target
  execution path.
- The recursive engine is not an `AgentHarness`. It is a typed query service
  that harnesses can expose as a host tool.
- Deterministic recall is always separable from semantic recursion and always
  makes zero model calls.
- Hidden automatic model spend is forbidden. Semantic execution must be
  explicitly selected by the caller until the conformance and evaluation gate
  admits an application-owned automatic policy.
- All budgets are global across the recursion tree.
- Missing provider usage is unknown, never zero.
- A semantic result cannot be `Completed` unless its citations validate
  against the exact immutable corpus used by the run.
- Interruption is Effect interruption. It is not laundered into a successful or
  partial domain result.
- Raw corpus text, questions, answers, and model observations never appear in
  default logs, spans, or metrics.
- OpenAgents authority—provider/account choice, leases, Full Auto caps,
  ledgers, verification, release, and settlement—stays in the consumer.

## Scope of v1

V1 is optimized for durable conversation, agent-run, receipt, and evidence
history. It supports:

- immutable cursor-addressed corpora;
- one thread, one run, or an explicitly authorized thread set;
- deterministic grep, cursor/time slices, key-turn extraction, and structural
  turn summaries;
- recursive semantic traversal with a single root model and an optional,
  separately supplied leaf model;
- depth 0 or 1 by default;
- sequential subcalls for deterministic behavior;
- streamed progress and one terminal result;
- exact token usage when the provider reports it;
- citation-safe host-tool integration.

V1 does not promise:

- arbitrary source-code execution;
- arbitrary document ingestion or a general vector database;
- an autonomous provider/account router;
- automatic semantic escalation;
- dollar-cost calculation without an application price catalog;
- distributed or cloud execution;
- training a specialized RLM root model;
- correctness merely because an answer has citations.

## Architecture at a glance

```text
authorized durable sources
        |
        v
RlmCorpusSource -----> immutable corpus + digest + coverage/exclusions
        |                                  |
        |                                  +--> deterministic traversal
        |                                           |
        |                                           v
        +---------------------------------------> Rlm service
                                                    |
                         caller-selected mode ------+
                                                    |
                           Effect AI LanguageModel -+
                                                    |
                                                    v
                                      Stream<RlmEvent, RlmError>
                                                    |
                                      exactly one terminal event
                                                    |
                                                    v
                                 completed / partial / refused
```

For OpenAgents, the result re-enters the existing agent stream as the bounded
result of a normal `history_recall` tool call. The SDK does not create a second
runtime-event vocabulary.

## Source basis

This specification reconciles:

- the RLM paper and reference implementation analysis retained in
  `OpenAgentsInc/openagents/docs/rlm/`;
- the shipped Effect-native engine in this repository;
- Effect `4.0.0-beta.94`, especially `effect/unstable/ai` `LanguageModel`,
  Schema, Context, Layer, Stream, Clock, Ref, and structured interruption;
- the Vercel AI SDK reference implementation at the source revision inspected
  on 2026-07-21, specifically its bounded tool loop, structured output,
  per-step preparation, stop conditions, telemetry, and sandbox contracts.

Vercel AI SDK code is reference material only. No code is vendored and no
runtime dependency on its agent loop is introduced by this specification.
