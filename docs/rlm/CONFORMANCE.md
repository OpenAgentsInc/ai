# RLM conformance and evaluation specification

First-class RLM support is not complete when a happy-path answer appears. It
is complete when every implementation proves the corpus, budget, citation,
interruption, usage, and authority contracts in this document.

## 1. Test layers

The SDK ships four distinct test layers:

1. **Schema conformance** — encoded contracts and compatibility.
2. **Engine conformance** — deterministic and semantic runtime semantics.
3. **Consumer conformance** — adapters, tool stream, ledger, and replay.
4. **Quality evaluation** — evidence about usefulness, never a runtime
   correctness substitute.

CI tests MUST be hermetic. Live-provider evaluation is owner-triggered and
records exact spend separately.

## 2. Reference fixtures

The SDK supplies reusable fixtures:

- empty corpus;
- one-entry corpus;
- multi-thread corpus with stable chronology;
- hundreds-of-turn planted-decision corpus;
- visibility/redaction mixed corpus;
- duplicate-address corpus;
- prompt-injection corpus;
- invalid and dangling citation corpora;
- missing-usage scripted model;
- quota/auth/rate-limit scripted models;
- malformed structured-operation scripted model;
- long-observation and long-transcript corpora;
- recursive span corpus with planted facts inside and outside the child span.
- generated million-token and 10M+-token corpora available through an
  out-of-core handle;
- long-output corpus whose exact result cannot fit one model output;
- program graph fixtures for partition, transform, model map, RLM map, reduce,
  and commit;
- model profiles with different context windows, output ceilings, and prompt
  strategies.

Scripted `LanguageModel` Layers are the standard semantic test dependency. No
test invokes a network or real provider unless it is explicitly under a
non-default live-evaluation command.

## 3. Paper-fidelity conformance

These tests distinguish a first-class RLM from a search agent with an explicit
subcall action.

### Programmatic recursion sentinel

A single root `generateObject` response produces a program that partitions a
collection and maps `N` one-shot model calls across it. The test proves:

- all `N` calls execute without another root-model decision between children;
- fan-out and call/value capacity are reserved before the first child starts;
- results publish as one ordered collection regardless of completion order;
- concurrency `1` and greater than `1` produce byte-identical collection
  order and digests;
- interruption or node failure leaves no detached children.

A second fixture uses `RlmMap` and proves that recursive children receive fresh
local transcripts, increase depth, and share global budgets. `ModelMap` proves
that one-shot calls do not increase depth.

### Persistent symbolic environment

- Full model outputs remain behind value refs and do not enter the root
  transcript.
- A later root iteration can inspect value metadata/preview and use the value
  as program input.
- Value digests, parent lineage, collection cardinality, and output refs are
  stable.
- Duplicate output refs, cycles, dangling refs, and stale/evicted refs fail
  before dependent work.
- Value count, item count, per-value bytes, and total environment bytes are
  enforced exactly.
- Run completion, error, and interruption finalize the environment.

### Stored and long output

- `Commit` can return a small existing value inline without another model
  regenerating it.
- A result larger than the per-call output window is assembled from stored
  values and committed through an admitted artifact sink.
- Artifact bytes, digest, ordering, media type, and lineage are exact.
- With no artifact sink, an oversized commit is partial and never silently
  truncated to completed.
- The research scaffold's brittle `FINAL`/`FINAL_VAR` distinction does not
  exist in the normative path.

### Out-of-core corpus

- The million-token and 10M+-token fixtures execute range/scan operations
  without copying the full corpus into a root prompt or a second materialized
  entry array.
- Incremental and inline canonical digest implementations agree.
- Changing the source after handle resolution yields `corpus_changed`.
- Inline inputs above the encoded-byte ceiling fail with a typed request error.

## 4. Schema conformance

For every public Schema:

- encoded round-trip succeeds;
- malformed tags fail;
- unknown required fields fail where the transport contract requires strict
  decoding;
- empty and overlong refs/text fail;
- count fields reject fractions, negatives, `NaN`, and infinity;
- hard ceiling violations fail;
- cursor ranges reject start greater than end;
- citations reject missing source-address forms;
- semantic requests reject absent budgets;
- deterministic requests reject semantic-only fields;
- terminal results reject inconsistent usage/honesty fields;
- event sequences reject non-increasing values in a run.

Compatibility schemas have golden fixtures for every published rc version the
current migration supports.

## 5. Corpus conformance

### Determinism

- Equivalent source inputs in different enumeration order produce byte-identical
  canonical entries and the same content and manifest digests.
- `builtAt` changes do not change either digest.
- Adding, removing, or changing an admitted entry changes the digest.
- Changes only to excluded source units do not change admitted corpus bytes but
  do update the appropriate exclusions fact and `manifestDigest` when the
  source projection is rebuilt; `contentDigest` stays stable.

### Ordering

- Ordinals are zero-based, contiguous, and unique.
- Chronological ordering is stable across threads and turns.
- Timestamp ties use documented source-address tie breakers.
- Per-turn sequence counters are not treated as a global cursor.

### Addressing

- Every entry ref is unique.
- Every event citation round-trips to its exact source event.
- Every thread-note citation round-trips to its synthetic source address.
- Duplicate addresses fail rather than overwrite.
- Rebuilding after new events preserves source addresses of old entries even
  when ordinals shift; citations remain tied to corpus digest.

### Policy

- Visibility exclusion is counted.
- Redaction exclusion is counted after visibility admission.
- A downstream request cannot widen the build policy.
- Inline corpora with a forged policy/digest fail validation.
- Refs remain refs unless an authorized adapter resolves them.
- Default errors and logs contain no excluded text.

### Coverage

- Manifest included kinds match actual entries.
- Known source gaps appear in coverage.
- A required-complete-coverage request does not complete against an incomplete
  manifest.

## 6. Deterministic Tier D conformance

Every operation proves:

- zero calls to `LanguageModel`;
- identical output for identical input;
- exact scanned-entry count;
- deterministic result order;
- valid citations/excerpts;
- `maxEntriesScanned`, `maxSpans`, and `maxCharsPerSpan` enforcement;
- hit caps listed exactly once in stable order;
- truncation true exactly when a cap cut work;
- invalid regular expressions fail typed without crashing;
- empty results complete honestly with zero spans.

A sentinel model Layer that defects on access SHOULD be provided during Tier D
tests to prove the model service is not touched.

## 7. Semantic engine conformance

### Happy path

A planted-decision fixture drives:

```text
root program: CorpusOp(Grep) -> Partition -> ModelMap
environment: ordered leaf-output collection with citation lineage
root program: ModelReduce -> Commit(existing valueRef)
```

The test asserts:

- structured `generateObject` use for a finite `RlmProgram`;
- deterministic progress-event ordering;
- global usage aggregation;
- stable root/leaf call refs;
- correct distinction between one-shot model calls and recursive depth;
- citation resolution to the exact corpus digest;
- committed output identity/digest matching the stored value;
- one terminal `Completed` event;
- `run` returns the same terminal result as `stream`.

### Program contract

- One invalid program consumes one iteration and emits one contract retry.
- Valid output after an invalid program can continue within the retry bound.
- Repeated invalid output fails with `program_contract_violation`.
- Free-form prose is never accepted as `Completed`.
- Corpus content that resembles an operation is treated only as observation
  data.
- Cycles, dangling refs, output collisions, unauthorized operators, and
  unreservable fan-out fail before the first program node executes.

### Span isolation

- A child sees only its declared span.
- It cannot cite entries outside the span as evidence for its local answer.
- Parent validation uses the same immutable corpus digest.
- Empty, reversed, negative, or over-bound spans fail closed.

### Citation behavior

- Fully valid required citations complete.
- Mixed valid/invalid citations cannot complete.
- All-invalid citations become partial or typed failure per evidence policy.
- Missing citations on a non-empty required-citation answer cannot complete.
- Citation excerpt digest mismatch cannot complete.
- Citation validation is deterministic and makes no model call.

### Partial and refused results

- Every cap produces the matching `Partial` reason.
- A partial may carry a best output only when it is labeled partial.
- Child exhaustion of a global budget stops the parent; the parent cannot
  launder it as a complete observation.
- Policy refusal makes no semantic model call.
- Empty-corpus and incomplete-coverage policy cases match their declared
  terminal semantics.

## 8. Global-budget matrix

Each budget receives an isolated boundary test at `limit - 1`, `limit`, and
`limit + 1` where meaningful.

| Budget            | Required proof                                                  |
| ----------------- | --------------------------------------------------------------- |
| Depth             | root allowed; last admitted child allowed; deeper child refused |
| Iterations        | exact per-loop bound; retries count                             |
| Model calls       | atomic reservation; no call begins after exhaustion             |
| Timeout           | whole-tree deadline; child gets no fresh deadline               |
| Input tokens      | known usage summed globally                                     |
| Output tokens     | known usage summed globally                                     |
| Total tokens      | cross-root/child sum enforced                                   |
| Subcalls          | global count, not per parent                                    |
| Program nodes     | whole graph validated/reserved before node execution            |
| Fan-out/fan-in    | map/reduce cannot launch or materialize above the cap           |
| Concurrency       | global semaphore; deterministic output at every admitted value  |
| Values/items      | count and collection cardinality enforced before publication    |
| Value bytes       | per-value and total live environment bytes enforced             |
| Inline output     | oversized commit cannot complete inline                         |
| Artifact output   | bytes/writes bounded; absent sink cannot complete as artifact   |
| Per-call prompt   | provider call never begins above trusted profile ceiling        |
| Per-call output   | requested output plus reserved headroom fits model profile      |
| Observation chars | bounded before transcript insertion                             |
| Transcript chars  | bounded with truncation fact                                    |
| Entries scanned   | deterministic operation stops exactly                           |
| Spans/matches     | response and model observation both bounded                     |

Every cap test asserts no post-terminal work and no additional scripted model
response consumption.

## 9. Usage conformance

- Exact input/output/total fields remain exact.
- A provider-reported zero remains zero.
- An absent field remains absent.
- Missing values are never included as zero in aggregates.
- Completeness is `complete` only when every required field on every call is
  known.
- `requireExactUsage` terminates safely when usage is missing.
- Contract retries count as separate calls.
- Root and leaf calls aggregate without double-counting.
- A provider fallback/retry fixture proves every charged attempt can reach the
  consumer ledger.
- Currency cost is absent unless a test explicitly provides a versioned
  application price catalog outside the SDK.

## 10. Time and interruption

All deadline tests use `TestClock`.

- Advancing just below the deadline does not time out.
- Advancing to the deadline yields `Partial(timeout)`.
- Child recursion shares the root deadline.
- Interrupting `run` interrupts the active model operation.
- Interrupting `stream` or closing its scope interrupts the producer.
- External interruption does not emit `Partial(timeout)`.
- No final event is fabricated after interruption.
- Queue/subscription/fiber finalizers run.
- Repeating interruption tests reports no leaked fibers or pending promises.

## 11. Progress-stream conformance

- `eventSequence` begins at the declared origin and strictly increases.
- Every event carries the same `runRef`.
- Parent/child refs form a valid tree.
- Program/node/value refs form a valid DAG and lineage graph.
- Map child completion order cannot change emitted collection order.
- Value/artifact events expose only refs, kinds, counts, bytes, and digests.
- No raw prompt, question, answer, observation, credential, or provider body
  appears in safe progress metadata unless the specific terminal field admits
  bounded answer text.
- Exactly one terminal event occurs on every non-error, non-interrupted run.
- No event occurs after terminal.
- Slow consumers do not cause unbounded buffering.
- Droppable/conflated progress kinds never include usage or terminal events.

## 12. Model and strategy-profile conformance

- Every call is preflighted against the trusted root/leaf per-call profile.
- Prompt, requested output, and reserved headroom cannot exceed the model
  context/output ceilings.
- A too-large map item is repartitioned or stops typed before provider access.
- `strategyRef`, prompt version, and safe model refs appear in the run summary
  and evaluation artifact.
- Two strategy profiles can produce different decompositions without changing
  corpus, budget, or authority semantics.
- A request cannot select an unadmitted profile, model, provider, or account.

## 13. Error mapping

Scripted failures cover:

- authentication;
- quota exhaustion;
- rate limiting;
- provider unavailable;
- corpus unavailable;
- corpus changed/digest mismatch;
- structured-output contract failure;
- invalid/cyclic program graph and unreservable fan-out;
- stale/evicted value ref;
- missing or failed artifact sink;
- per-call prompt/output ceiling exceeded before provider access;
- required usage unavailable;
- internal invariant failure.

Each maps to the correct safe `RlmError.reason` and retryability. Serialized
errors contain no raw provider response, prompt, corpus text, or secret.

True defects are visible to Effect supervision in unit tests; they are not
silently converted into ordinary `Failed` business values by a catch-all.

## 14. Tool and harness conformance

The shared Tool fixture proves:

- Tool parameters decode with Effect Schema.
- Scope is resolved by host authorization, not accepted blindly.
- Requested caps are clamped downward.
- Semantic mode is refused when not admitted.
- Tier D requires no model Layer.
- Preliminary results carry only bounded safe progress.
- The existing toolkit bridge creates a valid `HarnessHostToolSpec`.
- `tool.call`, terminal `tool.result`, and typed `tool.error` re-enter the
  neutral event stream correctly.
- Renderer replay is correct without transient progress events.
- Partial and citation-invalid results render as incomplete, not completed.

## 15. OpenAgents consumer conformance

The monorepo adds integration oracles for:

- current-thread authorization;
- current-run membership derivation;
- redaction non-widening;
- reload/replay of terminal recall results;
- exact usage-ledger idempotency by run/call ref;
- missing usage displayed as unknown;
- provider auth/quota failures preserving their class;
- Full Auto recall failure not stalling or leaking a lease;
- Full Auto caps and journal unchanged;
- source-navigation from a citation;
- no public projection of owner-local corpus data.

The full desktop typecheck, tests, build, Electron smoke, and React smoke are
required for integration changes.

### Corpus composition laws

`@openagentsinc/conformance-kit/corpus` publishes the corpus composition laws.
The laws check deterministic identity, semantic child order, and policy
non-widening. The reference tests also check duplicate source refusal, stale
child refusal, exact child citation resolution, explicit v1 migration, and a
large lazy child that cannot materialize all entries.

## 16. Dense-recall evaluation

Quality evaluation compares the following systems over the same immutable
corpus:

1. bounded recent-message window;
2. provider-native compaction or summary;
3. deterministic Tier D;
4. direct admitted base-model call where the input fits;
5. semantic Tier S depth 0 (symbolic environment, no model/RLM map);
6. semantic Tier S depth 1;
7. higher-depth and concurrent variants only when separately admitted.

Fixture families:

- sparse needle retrieval at increasing history length;
- linearly dense questions where many turns contribute;
- pair-dense questions requiring relationships between distant turns;
- explicit O(1), O(n), and O(n^2) work families at lengths from `2^13`
  through `2^20`, plus generated million-token and 10M+ out-of-core smokes;
- decision-plus-rationale retrieval;
- superseded-decision detection;
- tool/result provenance;
- adversarial prompt injection;
- incomplete-coverage and redaction cases.

Primary metrics:

- exact citation precision and recall;
- answer correctness scored independently of citation validity;
- false-completion rate;
- partial/refusal calibration;
- root and leaf calls;
- exact input/output tokens;
- exact committed-output correctness, ordering, digest, and artifact bytes for
  long-output fixtures;
- wall-clock, call-count, token, and cost distributions including p50, p75,
  p90, p95, and p99;
- cost using the evaluation's versioned price table;
- failure rate by model, strategy profile, depth, and program-node kind;
- all distribution metrics stratified by correct/incorrect/partial/refused
  rollout status.

Evaluation MUST report distributions, not only means. RLM costs are
heavy-tailed. A median-cheap result does not hide expensive outliers.
Depth is not assumed monotonic: depth zero, one, and higher are admitted by
evidence for each model/task family. Strategy/prompt profiles are pinned and
reported because the paper shows that first decomposition and runaway-subcall
behavior are profile-sensitive.

## 17. Admission gates

### First-class SDK release

- all schema, corpus, deterministic, semantic, citation, budget, usage,
  interruption, and stream suites green;
- paper-fidelity programmatic-recursion sentinel green;
- persistent value, generic/out-of-core corpus, and stored/large-output suites
  green;
- bounded map concurrency green at `1` and at the conservative shipped value;
- model strategy and per-call headroom suites green;
- package export-map audit green;
- no real model spend in default tests;
- API examples typecheck;
- compatibility fixtures green;
- `pnpm run check` green.

### OpenAgents deterministic rollout

- SDK npm cutover complete;
- corpus-source authorization proven;
- tool/renderer/replay oracles green;
- zero-model-call sentinel proven;
- desktop full gate green.

### OpenAgents semantic rollout

- explicit admission UX/policy;
- exact-usage integration proven;
- interruption and all cap tests green in the consumer;
- at least one owner-run live smoke with receipt;
- no automatic escalation.

### Automatic semantic escalation

Separate decision after dense-recall evaluation. It requires explicit
thresholds for accuracy gain, false completion, p90/p99 latency, and tail cost.

### Depth above one or higher concurrency

Separate decision after evaluation. It requires evidence that quality gains
outweigh higher error propagation, latency, and spend, plus new atomic-budget
and deterministic-order conformance tests. This gate controls raising product
limits; it does not permit shipping a one-explicit-subcall-per-root-turn engine
as first-class RLM.

### Public quality claims

Out of scope for SDK conformance. They require OpenAgents' normal promise,
evidence, and owner-signature process.
