# @openagentsinc/ai — the OpenAgents AI SDK

> **All layers (L0–L6) — umbrella** · part of the [OpenAgents AI SDK](../../docs/README.md)

The OpenAgents AI SDK is an Effect-native toolkit for durable agent
applications. It gives you durable, redaction-aware, cursor-exact agent
streams with coding-agent harnesses and recall — on Effect.

This package is the SDK front door. It holds no logic. It re-exports the
entry points of the SDK layer packages, so one install gives the full
surface. You can also install each layer package directly.

## Install

```sh
npm install @openagentsinc/ai@rc
# or pin the exact train (pre-stable never takes `latest`):
npm install @openagentsinc/ai@0.2.1-rc.2
```

The packages publish TypeScript source directly — use a TypeScript-aware loader
(`tsx`, Vite, or Vite Plus). They depend on `effect@4.0.0-beta.94`; keep one
`effect` version in your application.

## The layers

Each layer speaks the neutral `KhalaRuntimeEvent` vocabulary upward. There
is one event union and one durable cursor.

```
L6  RECALL        @openagentsinc/history-corpus
                  corpus export, cursor-addressed entries, HistoryRecall
                  contract, deterministic Tier D recall
------------------------------------------------------------------
L5  UI STREAM     agent-harness-contract/ui-message-chunk + ui-message-reducer
                  + smooth-stream + partial-object-stream
------------------------------------------------------------------
L4  HARNESS       agent-harness-contract — AgentHarness adapter, session
                  verbs (promptTurn / suspendTurn / continueTurn / compact /
                  detach / stop / destroy), capability-by-method-presence,
                  slice runner, readiness projection, skills, host tools,
                  toolkit bridge, ACP + opencode adapters
------------------------------------------------------------------
L3  SANDBOX       harness sandbox-provider contract + local-process provider
------------------------------------------------------------------
L2  DURABLE LOG   agent-harness-contract/event-log + event-log-store —
                  seq-cursor append, replay, live attach, rerun boundaries
------------------------------------------------------------------
L1  VOCABULARY    @openagentsinc/agent-runtime-schema — KhalaRuntimeEvent
                  (the single neutral event union, sequence = durable
                  cursor, visibility + redactionClass + causalityRefs)
------------------------------------------------------------------
L0  MODEL CALL    effect/unstable/ai (upstream, consumed, never forked)
                  + @openagentsinc/ai-model — the LanguageModel
                  Layer over the existing transport, bidirectional
                  StreamPart maps
------------------------------------------------------------------
P   PROGRAMS      @openagentsinc/dse — typed signatures, immutable
                  artifacts, portable runtime, explicit optimizer
G   GRAPH         @openagentsinc/graph-corpus — derived RLM/DSE projection
X   CONFORMANCE   optional reusable test laws
```

## The roster

| Package                                 | Layer          | What it gives you                                                                                  |
| --------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `@openagentsinc/ai-model`               | L0 model call  | The Effect AI `LanguageModel` Layer, `Response.StreamPart` maps, `ExecutionPlan` provider fallback |
| `@openagentsinc/agent-runtime-schema`   | L1 vocabulary  | `KhalaRuntimeEvent`, `RuntimeInteraction`, route schemas, AI SDK ingestion parts                   |
| `@openagentsinc/agent-harness-contract` | L2 durable log | Seq-cursor event log with append, replay, live attach, rerun boundaries                            |
| `@openagentsinc/agent-harness-contract` | L3 sandbox     | Sandbox-provider contract, local and local-process providers                                       |
| `@openagentsinc/agent-harness-contract` | L4 harness     | `AgentHarness` adapters, session verbs, readiness projection, skills, host tools                   |
| `@openagentsinc/agent-harness-contract` | L5 UI stream   | UI message chunks, progressive reducer, smooth stream, partial-object stream                       |
| `@openagentsinc/history-corpus`         | L6 recall      | Corpus export, `HistoryRecall` contract, deterministic Tier D recall                               |
| `@openagentsinc/dse`                    | programs       | Effect Schema signatures, immutable artifacts, prediction receipts, bounded offline optimizer      |
| `@openagentsinc/graph-corpus`           | graph          | Derived graph identity, RLM projection, ranking, deletion, and archive contracts                   |
| `@openagentsinc/conformance-kit`        | test           | Reusable SDK and graph-memory law runners                                                          |

## The subpaths

The umbrella exports curated per-layer subpaths that mirror the diagram:

- `@openagentsinc/ai` — the full surface
- `@openagentsinc/ai/model` — L0
- `@openagentsinc/ai/schema` — L1
- `@openagentsinc/ai/event-log` — L2
- `@openagentsinc/ai/sandbox` — L3
- `@openagentsinc/ai/harness` — L4
- `@openagentsinc/ai/ui-stream` — L5
- `@openagentsinc/ai/recall` — L6
- `@openagentsinc/ai/rlm` — recursive corpus engine
- `@openagentsinc/ai/graph` — stable graph projection
- `@openagentsinc/ai/graph/ranking` — ranking and used-element evidence
- `@openagentsinc/ai/graph/archive` — portable graph archive v1
- `@openagentsinc/ai/conformance` — optional reusable laws
- `@openagentsinc/ai/program` — DSE contract plus portable runtime
- `@openagentsinc/ai/program/contract` — DSE schemas and pure contracts
- `@openagentsinc/ai/program/runtime` — prediction, resolution, and event projection
- `@openagentsinc/ai/program/optimizer` — explicit offline compiler
- `@openagentsinc/ai/program/test` — deterministic fixtures

The conformance subpath has an optional peer on
`@openagentsinc/conformance-kit`. Install the exact-train kit and
`vite-plus@0.2.4` as development dependencies when you use this test-only
surface. Normal umbrella imports do not load the test runner.

## Usage

Build a corpus from thread notes and run deterministic Tier D recall over it —
pure traversal, zero model calls, cited spans. The end-to-end flows (harness
turn suspend/continue, event → UI chunks, corpus → recall) are in
[Getting started](../../docs/getting-started.md).

```ts
import { Effect } from "effect";
import { buildHistoryCorpus, recallTierD } from "@openagentsinc/ai";

const program = Effect.gen(function* () {
  const corpus = yield* buildHistoryCorpus({
    scope: { _tag: "Thread", threadId: "thread-1" },
    threads: [
      {
        id: "thread-1",
        title: "Deploy review",
        updatedAt: "2026-07-21T00:00:00Z",
        notes: [
          {
            key: "note-1",
            role: "assistant",
            text: "The tests passed. The deploy is complete.",
            timestamp: "2026-07-21T00:05:00Z",
          },
        ],
      },
    ],
    policy: {
      includeVisibilities: ["private"],
      includeRedactionClasses: ["private_ref"],
    },
    builtAt: "2026-07-21T00:10:00Z",
  });

  return yield* recallTierD({
    entries: corpus.entries,
    coverageNote: corpus.manifest.coverage.note,
    question: { _tag: "Grep", pattern: "deploy" },
  });
});

const response = await Effect.runPromise(program);
console.log(response.cost.modelCalls); // 0
```

## More

- [Layer index](../../docs/README.md) · [Packages](../../docs/packages.md) ·
  [Getting started](../../docs/getting-started.md)
- Roadmap: [`docs/ROADMAP.md`](../../docs/ROADMAP.md)
