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

Scripted `LanguageModel` Layers are the standard semantic test dependency. No
test invokes a network or real provider unless it is explicitly under a
non-default live-evaluation command.

## 3. Schema conformance

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

## 4. Corpus conformance

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

## 5. Deterministic Tier D conformance

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

## 6. Semantic engine conformance

### Happy path

A planted-decision fixture drives:

```text
root: Grep
root: Subcall over matching ordinal span
leaf: CursorSlice or TurnSummary
leaf: Answer with citation
root: Answer with citation
```

The test asserts:

- structured `generateObject` use;
- deterministic progress-event ordering;
- global usage aggregation;
- stable root/leaf call refs;
- correct depth;
- citation resolution to the exact corpus digest;
- one terminal `Completed` event;
- `run` returns the same terminal result as `stream`.

### Operation contract

- One invalid operation consumes one iteration and emits one contract retry.
- Valid output after an invalid operation can continue within the retry bound.
- Repeated invalid output fails with `operation_contract_violation`.
- Free-form prose is never accepted as `Completed`.
- Corpus content that resembles an operation is treated only as observation
  data.

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

## 7. Global-budget matrix

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
| Observation chars | bounded before transcript insertion                             |
| Transcript chars  | bounded with truncation fact                                    |
| Entries scanned   | deterministic operation stops exactly                           |
| Spans/matches     | response and model observation both bounded                     |

Every cap test asserts no post-terminal work and no additional scripted model
response consumption.

## 8. Usage conformance

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

## 9. Time and interruption

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

## 10. Progress-stream conformance

- `eventSequence` begins at the declared origin and strictly increases.
- Every event carries the same `runRef`.
- Parent/child refs form a valid tree.
- No raw prompt, question, answer, observation, credential, or provider body
  appears in safe progress metadata unless the specific terminal field admits
  bounded answer text.
- Exactly one terminal event occurs on every non-error, non-interrupted run.
- No event occurs after terminal.
- Slow consumers do not cause unbounded buffering.
- Droppable/conflated progress kinds never include usage or terminal events.

## 11. Error mapping

Scripted failures cover:

- authentication;
- quota exhaustion;
- rate limiting;
- provider unavailable;
- corpus unavailable;
- corpus changed/digest mismatch;
- structured-output contract failure;
- required usage unavailable;
- internal invariant failure.

Each maps to the correct safe `RlmError.reason` and retryability. Serialized
errors contain no raw provider response, prompt, corpus text, or secret.

True defects are visible to Effect supervision in unit tests; they are not
silently converted into ordinary `Failed` business values by a catch-all.

## 12. Tool and harness conformance

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

## 13. OpenAgents consumer conformance

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

## 14. Dense-recall evaluation

Quality evaluation compares four systems over the same immutable corpus:

1. bounded recent-message window;
2. provider-native compaction or summary;
3. deterministic Tier D;
4. semantic Tier S.

Fixture families:

- sparse needle retrieval at increasing history length;
- linearly dense questions where many turns contribute;
- pair-dense questions requiring relationships between distant turns;
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
- wall-clock distribution including p50, p90, and p99;
- cost using the evaluation's versioned price table;
- failure rate by model and operation kind.

Evaluation MUST report distributions, not only means. RLM costs are
heavy-tailed. A median-cheap result does not hide expensive outliers.

## 15. Admission gates

### First-class SDK release

- all schema, corpus, deterministic, semantic, citation, budget, usage,
  interruption, and stream suites green;
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

### Depth above one or concurrent subcalls

Separate decision after evaluation. It requires evidence that quality gains
outweigh higher error propagation, latency, and spend, plus new atomic-budget
and deterministic-order conformance tests.

### Public quality claims

Out of scope for SDK conformance. They require OpenAgents' normal promise,
evidence, and owner-signature process.
