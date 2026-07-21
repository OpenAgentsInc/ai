# Current surface and implementation gap

This document is the factual bridge between the specification and the code in
this repository at `0.1.3-rc.1`. It prevents the target API from being mistaken
for an already shipped contract.

## 1. What already ships

`@openagentsinc/history-corpus` currently provides:

- `HistoryCorpusEntry`, scope, policy, manifest, coverage, and exclusion
  Schemas;
- `buildHistoryCorpus` over a harness event-log reader and neutral thread
  snapshots;
- stable JSONL encoding;
- visibility/redaction filtering and exclusion counts;
- deterministic Tier D operations and the `HistoryRecall` Effect service;
- `runRecursiveRecall`, an Effect-native bounded recursive loop;
- typed operations for grep, cursor/time slices, turn summary, subcall, and
  answer;
- shared global token/subcall/deadline state in the seed engine;
- completed/partial/failed compatibility results;
- scripted Effect AI `LanguageModel` tests with no network spend;
- the deterministic `HistoryRecallTool` and `HistoryRecallToolkit` authoring
  form;
- a registered harness wire specification for `history_recall`;
- deterministic Tool/Toolkit dispatch through the existing harness bridge;
- neutral `tool.call`/`tool.result` or `tool.error` re-entry helpers;
- bounded cited-span summaries for the renderer boundary.

The umbrella package exports this surface from:

- `@openagentsinc/ai`;
- `@openagentsinc/ai/recall`.

The granular package also exports the deterministic tool integration from
`@openagentsinc/history-corpus/host-tool`.

The implementation is already Python-free. It contains no REPL or arbitrary
code execution.

## 2. What is not yet first-class

The seed is useful but does not yet satisfy the specification.

### Discovery and packaging

- There is no `@openagentsinc/ai/rlm` subpath.
- There is no generic `@openagentsinc/rlm` implementation package.
- There is no history-adapter `@openagentsinc/history-corpus/rlm` subpath.
- The public product is described as recall rather than an explicit RLM
  service.
- The `HistoryRecall` and recursive surfaces are separate rather than composed
  behind one service.

### Corpus identity

- The manifest has no schema id, content digest, or full manifest digest.
- Entries have no committed corpus ordinal or stable `entryRef`.
- Sorting by `(scopeRef, turnId, sequence)` is deterministic but does not
  necessarily represent cross-turn chronology.
- `corpusRef` includes `builtAt`; it is not a content identity.
- Recursive subcall spans are raw array indexes.

### Schema validation

- Many caps use unrefined `Schema.Number`.
- Negative, fractional, infinite, or impractically large caps are not rejected
  by the public Schema.
- Citation ranges lack the full corpus/scope identity required for robust
  cross-scope validation.

### Model operation contract

- The engine uses `LanguageModel.generateText`, fence stripping,
  `JSON.parse`, and Schema decode.
- The target uses `LanguageModel.generateObject` directly.
- Deterministic operation implementations are duplicated between Tier D and
  recursive helpers in places instead of sharing one interpreter.
- The seed emits one explicit operation/subcall per root iteration. The RLM
  paper identifies that shape as the poor alternative because a sub-LM cannot
  be invoked programmatically over a collection inside persistent symbolic
  state.
- There is no run-scoped value environment, declarative program graph,
  `ModelMap`/`RlmMap`, reduce/compose, or commit-by-value-ref contract.
- Root and leaf prompts have no versioned strategy profile or trusted per-call
  context/output headroom.

### Generality and scale

- The public request is coupled to `HistoryCorpusScope`; the core source
  contract is not generic.
- Corpus resolution materializes entry arrays rather than exposing an
  out-of-core immutable handle.
- There is no inline-input byte ceiling or multi-million-token handle smoke.
- Semantic output is one bounded answer string. There is no artifact-backed
  committed output for exact results larger than one model output window.

### Results and errors

- Operational failures are encoded as `Failed` success-channel values and the
  function advertises an error channel of `never`.
- A broad `catchDefect` converts defects into leaf failures.
- Citations that do not resolve are silently filtered; a run may still return
  `Completed` with fewer or no citations.
- Recursive citations omit corpus digest and scope ref.
- The deterministic and semantic honesty/result shapes do not share one
  terminal contract.

### Usage

- Missing provider token fields are coerced with `?? 0` in the recursive
  aggregate.
- Usage has no complete/partial/unavailable state.
- There is no per-model-call progress record or stable call ref for external
  ledger idempotency.
- There is no `maxModelCalls` cap distinct from loop iterations.

### Effect runtime shape

- There is no first-class `Rlm` service.
- There is no `RlmCorpusSource` service tag.
- The recursive state is a mutable JavaScript object shared through recursive
  calls rather than a per-run Effect Ref.
- There is no progress `Stream`.
- There is no root/leaf model-plan distinction.
- There are no SDK spans for runs, iterations, operations, or calls.

### Consumer integration

- The shipped `HistoryRecallTool` covers deterministic Tier D only; there is no
  first-class `makeRlmTool` spanning deterministic and semantic modes.
- Its model-facing parameters currently carry a full `HistoryCorpusScope`;
  first-class consumption requires the host authorization/clamping hook so a
  model-supplied scope is never trusted directly.
- The deterministic host-tool path has no semantic progress stream or
  preliminary root/leaf call progress to project through the harness bridge.
- OpenAgents completed its SDK npm dependency swap at monorepo SHA
  `314a14da78`; future first-class RLM work must arrive through a pinned SDK
  release rather than restoring extracted package copies.

## 3. Compatibility posture

The current package train is pre-stable and the OpenAgents npm cutover has
landed. Implementation SHOULD remain additive through the first-class RLM rc:

- add new schemas, services, exports, and fields through versioned v1
  contracts;
- retain current entrypoints and wrappers;
- do not remove or rename existing exports during the cutover;
- keep one coherent fixed-version rc train;
- make unsafe compatibility semantics visible in deprecation documentation;
- migrate OpenAgents to the canonical service before removing wrappers.

Where correctness requires a behavior change—such as preventing a completed
answer with no valid required citations—the rc release notes MUST call it out
as a safety correction.

## 4. Ordered SDK implementation plan

### SDK-RLM-01 — schemas and canonical corpus identity

Deliver:

- refined ref/count/duration/digest Schemas;
- corpus schema id, canonical content/manifest digests, stable ordinals, and
  entry refs;
- explicit chronological ordering descriptor;
- full citation shape and deterministic validator;
- compatibility decoding for the current manifest/entries.
- generic logical source refs and an immutable out-of-core `RlmCorpusHandle`;
- inline-input byte ceilings and incremental canonical digest equivalence.

Verify:

- canonical/digest tests;
- ordering and source-address round trips;
- redaction/exclusion non-widening;
- old fixture decoding.

### SDK-RLM-02 — shared deterministic interpreter

Deliver:

- one deterministic operation algebra used by Tier D and semantic runs;
- uniform observation bounds and safe rendering;
- zero-model-call sentinel tests;
- deterministic progress-event adapters.

Verify every Tier D operation and cap matrix.

### SDK-RLM-03 — first-class service and result contract

Deliver:

- `Rlm`, `RlmCorpusSource`, request, result, error, honesty, and usage Schemas;
- deterministic `Rlm` Layer;
- canonical `run` derived from `stream`;
- generic `@openagentsinc/rlm` package, canonical `@openagentsinc/ai/rlm`
  export, and history-adapter `./rlm` compatibility export;
- one-way package dependency from history adapter to the generic engine;
- umbrella export identity tests.
- public value, program, strategy-profile, and artifact descriptors/services.

### SDK-RLM-04A — typed symbolic environment and programmatic recursion

Deliver:

- a scoped immutable value environment with refs, digests, lineage, previews,
  collection cardinality, and deterministic finalization;
- Schema-decoded finite program DAGs with static ref/fan-out validation;
- pure registered corpus/value operators;
- `Partition`, `Transform`, `ModelMap`, `RlmMap`, `ModelReduce`, and `Commit`;
- atomic whole-node budget reservation and bounded structured concurrency;
- deterministic output order independent of fiber completion order;
- inline commit plus optional host-owned artifact sink for large output;
- paper-fidelity sentinel proving multiple child calls from one root program.

Verify environment/value limits, concurrency `1` and greater than `1`, child
failure/interruption cleanup, stored output, and 10M+-token out-of-core input.

### SDK-RLM-04 — structured semantic engine

Deliver:

- `LanguageModel.generateObject` program production;
- per-run Effect budget Ref;
- global program-node/model-call/token/subcall/value/artifact/deadline
  enforcement;
- root/leaf model Layers with versioned strategy profiles and per-call
  prompt/output headroom;
- distinct one-shot model-map and recursive RLM-map depth/accounting;
- typed error mapping rather than catch-all success values;
- required citation validation;
- usage completeness and exact-usage policy.

Verify with scripted model Layers, `TestClock`, and interruption tests.

### SDK-RLM-05 — progress and observability

Deliver:

- canonical `RlmEvent` Stream;
- stable call/subcall refs and monotonic event sequence;
- program/node/value/map/artifact refs and events;
- bounded backpressure behavior;
- Effect spans with safe attributes;
- terminal uniqueness and scope-finalization tests.

### SDK-RLM-06 — Effect Tool and harness integration

Deliver:

- `makeRlmTool`;
- explicit mode admission and budget clamp hooks;
- preliminary safe progress;
- toolkit-bridge fixture proving host-tool projection and resolution;
- no second harness/runtime-event vocabulary.

### SDK-RLM-07 — conformance package and examples

Deliver:

- reusable corpus and scripted-model fixtures;
- conformance runner or exported fixture suite;
- typechecked deterministic, semantic, streaming, and tool examples;
- dense-history fixture generator and scoring contracts;
- paper-fidelity programmatic recursion, persistent-value, generic/out-of-core,
  and long-output suites;
- O(1)/O(n)/O(n^2) scaling, depth 0/1/higher comparisons, strategy profiles,
  and success-stratified p50/p75/p90/p95/p99 cost/runtime/call distributions;
- migration guide from current exports.

### SDK-RLM-08 — rc release

Deliver:

- coherent package version bump;
- pack/tarball inspection;
- export-map audit;
- release notes naming compatibility and safety changes;
- npm `rc` publish only after explicit release authorization.

Publishing is separate from implementing and pushing code. This specification
does not itself authorize a package release.

## 5. OpenAgents follow-through

After an SDK rc contains the first-class surface:

1. pin the coherent first-class SDK rc train;
2. implement only the authorized store/model/ledger/UI adapters described in
   [`OPENAGENTS-CONSUMPTION.md`](./OPENAGENTS-CONSUMPTION.md);
3. migrate the landed deterministic host tool to the canonical service;
4. add semantic recall under explicit admission;
5. add the Full Auto consumer;
6. run dense-recall evaluation before automatic escalation.

The existing OpenAgents issue order remains useful, but implementation bugs in
the SDK surface belong in this repository after cutover.

## 6. Definition of first-class

RLM support is first-class only when all of the following are true:

- a user can discover it at `@openagentsinc/ai/rlm`;
- one typed Effect service composes deterministic and semantic execution;
- schemas cover every public request/result/event/error;
- corpus identity and citations are independently verifiable;
- semantic work is explicit and globally budgeted;
- model programs are structured output;
- one root program can launch bounded programmatic child calls over a
  collection;
- intermediate and final values can remain symbolic and be committed by ref;
- generic/out-of-core input and exact large-output assembly pass conformance;
- interruption and timeout are distinct;
- progress streams without leaking raw history;
- exact usage remains exact and unknown remains unknown;
- the standard Tool/Toolkit/harness path consumes it;
- conformance is hermetic;
- OpenAgents consumes it from npm without a private engine fork.
