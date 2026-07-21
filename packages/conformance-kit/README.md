# @openagentsinc/conformance-kit

Published law suites for the `@openagentsinc/ai` contracts. This package
promotes the per-package test suites that already encode the SDK's laws into
one reusable kit. Point a suite at an implementation under test — an adapter, a
store, a reducer, a recall source, or the RLM engine — and it either passes the
kit or it is not conformant.

This is Phase 1 item 1 of `docs/ROADMAP.md` (issue #15, parent epic #14):
conformance as product.

## The idea

Each law suite is one exported function. You call it inside your own test file,
parameterized over your implementation. The suite registers the `describe` /
`test` blocks against the same `vite-plus/test` runner your package already
uses, so a conformance run is just part of your normal test sweep.

The kit's own tests run every suite against the in-repo reference
implementations (the reference adapter, the in-memory event-log store, the
UI-message reducer, the Tier D recall backend, and the RLM engine), so the kit
is proven to work before anyone points it at a third-party implementation.

## The suites

| Import                                     | Runner            | Implementation under test        | Laws                                                                                                                                                   |
| ------------------------------------------ | ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@openagentsinc/conformance-kit/adapter`   | `runAdapterLaws`  | `AgentHarness`                   | turn framing, capability refusal is fail-closed and named, suspend/continue cursor exactness (with honest lossy degradation)                           |
| `@openagentsinc/conformance-kit/event-log` | `runEventLogLaws` | `HarnessEventLogStore`           | append monotonicity / dup-free, gap-free replay from a cursor, durable replay after process death, rerun boundaries, live attach, single-flight attach |
| `@openagentsinc/conformance-kit/reducer`   | `runReducerLaws`  | a progressive UI-message reducer | progressive fold, tool state machine, transient bypass, fail-loud-never-corrupt                                                                        |
| `@openagentsinc/conformance-kit/recall`    | `runRecallLaws`   | a `HistoryRecall` Tier D source  | correctness anchor, caps truncate + report, `cost.modelCalls === 0`, coverage-note carry-through, typed invalid input                                  |
| `@openagentsinc/conformance-kit/rlm`       | `runRlmCapLaws`   | the RLM engine + corpus source   | every cap → honest `Partial`, generous → `Completed`, no laundering, deterministic never touches a model                                               |

Everything is re-exported from the package root too
(`@openagentsinc/conformance-kit`).

## Run the kit against your adapter

Add the kit as a dev dependency, then write a test file that calls the runner:

```ts
// my-adapter.conformance.test.ts
import { Effect } from "effect";
import { runAdapterLaws } from "@openagentsinc/conformance-kit/adapter";

import { makeMyAdapter } from "./my-adapter.ts";

runAdapterLaws({
  label: "my-adapter",
  makeHarness: () => Effect.sync(() => makeMyAdapter()),
});
```

That single call registers the full reference-adapter law suite against your
adapter. The laws are content-agnostic: the kit starts the session and drives
the turn itself, so they hold whatever your runtime emits. An adapter that
cannot suspend a turn still passes — the suite proves the refusal is a typed,
named `HarnessCapabilityUnsupported`, not a silent success.

## Run the kit against your store

```ts
import { Effect } from "effect";
import { runEventLogLaws } from "@openagentsinc/conformance-kit/event-log";

import { makeMyStore } from "./my-store.ts";

runEventLogLaws({
  label: "my-store",
  makeStore: () => Effect.sync(() => makeMyStore()),
});
```

The kit builds the `HarnessEventLog` runtime over your store, so satisfying the
`HarnessEventLogStore` port earns both the store-level and the live-attach and
single-flight laws.

## Run the kit against the recall and RLM engines

```ts
import { runRecallLaws } from "@openagentsinc/conformance-kit/recall";
import { runRlmCapLaws } from "@openagentsinc/conformance-kit/rlm";
import { recallTierD } from "@openagentsinc/history-corpus";
import { makeRlm, rlmInlineCorpusSourceLayer } from "@openagentsinc/rlm";

runRecallLaws({ label: "my-recall", recall: (params) => recallTierD(params) });

runRlmCapLaws({
  label: "my-rlm",
  makeEngine: makeRlm,
  corpusSourceLayer: rlmInlineCorpusSourceLayer,
});
```

The kit owns the corpus fixtures (a deep planted-decision corpus for recall, a
small four-entry corpus for RLM), so a recall or RLM implementation only has to
answer honestly.

## What "conformant" means

The laws are the honesty contract, not just the happy path:

- An adapter must never present a lossy re-drive as an exact cursor attach.
- A store must reject a non-increasing sequence so replay stays duplicate-free.
- A reducer must throw its tagged error on a malformed sequence rather than
  silently corrupt the message.
- A recall source must report exactly what it scanned, which caps it hit, and
  the corpus coverage bound — and never fabricate a model call behind a
  deterministic answer.
- The RLM engine must surface every cap that bites as an honest `Partial`,
  never as a `Completed` result that quietly dropped work.
