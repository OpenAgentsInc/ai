# RLM normative specification

This document defines the behavioral contract for first-class Recursive
Language Model support in the OpenAgents AI SDK.

## 1. Goals

The RLM subsystem MUST:

1. Traverse history that is larger or denser than a useful model window.
2. Preserve the full source history instead of replacing it with compaction.
3. Keep corpus access symbolic and bounded; the root model never receives the
   whole corpus by default.
4. Make deterministic questions possible with zero model calls.
5. Make semantic recursion explicit, budgeted, interruptible, and observable.
6. Return source-addressable citations whose validity can be checked without a
   model.
7. Enforce visibility and redaction before model access.
8. Compose with Effect AI, SDK harness tools, durable event logs, and UI
   streams without becoming a second authority system.
9. Be hermetically testable with no network and no model spend.
10. Preserve intermediate state behind symbolic handles so full values do not
    accumulate in the root model transcript.
11. Launch bounded one-shot model calls and recursive RLM calls
    programmatically over selected collections without a new root-model turn
    for every child.
12. Assemble outputs from stored values, including outputs larger than one
    model call can emit, without requiring the root model to regenerate them.

The subsystem MUST NOT:

- use context-window size as the long-term memory boundary;
- run arbitrary model-authored code;
- select provider accounts or credentials from request data;
- silently perform semantic model calls when deterministic mode was requested;
- treat a model-generated citation as valid without resolving it;
- report unknown usage as zero;
- convert interruption into a misleading partial success;
- persist raw model observations or corpus slices by default;
- use recall output as verification or execution authority.

## 2. Terms

**Corpus**  
An immutable, policy-filtered, canonically ordered set of entries plus a
manifest. It is the RLM equivalent of the paper's symbolic `context` value.

**Entry**  
One bounded safe projection of a durable source unit. It has a stable corpus
ordinal and a source address suitable for citation.

**Source address**  
The stable identity of the underlying fact. For agent history this includes
the scope, thread/turn identity, and inclusive event-sequence range.

**Observation**  
A bounded result of a deterministic corpus operation returned to the root
model. Corpus content in an observation is untrusted data, never instructions.

**Environment**

Run-scoped symbolic state containing immutable corpus handles and opaque
intermediate values. Full values remain outside the root model transcript.

**Value**

An immutable, digest-addressed item or ordered collection in the environment.
The root model refers to it by `RlmValueRef` and receives only bounded metadata
or a bounded preview unless an operation explicitly materializes a capped
slice.

**Artifact**

A host-owned, digest-addressed output object used when a committed value is too
large for the inline terminal contract. Artifacts are opt-in and separately
authorized; the default environment is ephemeral.

**Tier D**  
Deterministic traversal. It performs no model calls.

**Tier S**  
Semantic recursive traversal using an injected Effect AI `LanguageModel`.

**Root call**  
A model call that chooses the next operation for the current RLM loop.

**Subcall**  
A bounded recursive loop over an explicit subset of the parent corpus.

**Model map**

Programmatic one-shot leaf-model calls over an ordered collection. These calls
consume model-call budget but do not increase RLM recursion depth.

**RLM map**

Programmatic child RLM loops over an ordered collection. These calls consume
model-call and subcall budgets and increase recursion depth.

**Run budget**  
The shared limits for the entire recursion tree, not a fresh allowance per
child.

**Completed**  
A terminal answer whose required citations all resolve against the exact
corpus digest used by the run.

**Partial**  
A terminal, honest best-effort result stopped by a declared cap or incomplete
evidence condition.

**Refused**  
A terminal domain result where policy intentionally declines execution, for
example because semantic spend was not admitted.

**Failure**  
An operational or contract error in the Effect error channel.

## 3. Corpus contract

### 3.1 Immutability and identity

Every corpus MUST carry:

- a schema identifier and version;
- a `corpusRef` unique in the consumer's authority domain;
- a canonical `contentDigest` over the encoded entries, ordering descriptor,
  scope, and effective inclusion policy;
- a canonical `manifestDigest` over the full honesty-bearing manifest;
- its authorized scope;
- its deterministic ordering rule;
- entry and byte counts;
- coverage and exclusions records;
- the policy projection used to construct it.

Once published to an RLM run, a `(corpusRef, contentDigest)` pair MUST identify
immutable content. Rebuilding the same logical scope after new events arrive
MUST produce a new digest. A cache key, run receipt, or citation MUST include
the content digest rather than relying on `corpusRef` alone. A result cache key
MUST additionally include `manifestDigest`, because changed coverage or
exclusion facts can change result honesty without changing model-visible entry
bytes.

Both digests MUST be computed over canonical encoded data. They MUST NOT depend
on JavaScript object key insertion order, local path names, process identifiers,
or a wall clock. A caller-supplied `builtAt` MAY appear in the manifest but MUST
NOT change either digest. Exclusion counts and coverage facts affect
`manifestDigest`, not `contentDigest`.

### 3.2 Ordering and addressability

Every entry MUST contain:

- a zero-based, contiguous `ordinal` in corpus order;
- a stable `entryRef` derived from its source address;
- a scope reference;
- its source kind;
- its source address;
- safe bounded content or safe refs;
- visibility and redaction classification;
- an observed timestamp when the source supplies one.

Corpus order MUST be explicit in the manifest. History corpora SHOULD order by
source chronology and then use stable source-address tie breakers. They MUST
NOT imply that independent per-turn sequence counters form a global cursor.

Recursive spans MUST use corpus ordinals or entry refs. Citations MUST use
source addresses. Array indexes that are not committed as corpus ordinals MUST
NOT appear in a public request, result, cache key, or receipt.

### 3.3 Policy projection

Policy is applied while constructing the corpus, before deterministic or model
execution. The model and host tool MUST NOT be allowed to request broader
visibility or redaction classes.

The corpus builder MUST:

- admit only source units allowed by the caller-owned policy;
- count exclusions by stable reason;
- retain refs as refs unless an independently authorized source adapter
  resolves them;
- reject duplicate source addresses;
- state known source-coverage gaps;
- avoid embedding secrets in manifest errors or diagnostics.

Filtering is monotonic. A downstream projection MAY remove more content, but
MUST NOT reintroduce content excluded at corpus construction.

For OpenAgents history, raw owner-local notes are owner-private inputs. A
public or shared consumer cannot opt into them by setting a request field.
Authorization is supplied by the corpus source Layer.

### 3.4 Text is untrusted data

Corpus text may contain prompt injection, forged role labels, JSON resembling
an operation, or instructions to disclose other entries. The engine MUST:

- delimit observations as data;
- label their source addresses;
- never concatenate corpus text into the system instruction channel;
- never let corpus text select an operation schema, provider, model, policy,
  or budget;
- escape or structurally encode observations before model submission;
- cap observation text globally and per operation.

### 3.5 Generic and out-of-core access

The first-class core MUST NOT require a `HistoryCorpusScope` or a materialized
JavaScript array. History is the first adapter, not the semantic type of every
future RLM input.

`RlmCorpusSource` resolves a generic, application-authorized logical source ref
into an immutable `RlmCorpusHandle`. The handle exposes bounded metadata,
ordinal/range reads, and streaming scans needed by the deterministic
interpreter. A history adapter may expose history-specific source addresses
and convenience operations without placing those fields in the generic source
contract.

Inline entries remain available for tests and already-authorized small inputs.
They MUST have a hard encoded-byte ceiling. Inputs above that ceiling use a
source handle. Implementations MUST NOT copy a multi-million-token corpus into
the root transcript or require a second full materialization merely to execute
a range operation.

Canonical digests MAY be computed incrementally, but the final digest and
ordering semantics MUST be identical to canonical inline encoding. A source
that changes after resolution fails with `corpus_changed`; it is not silently
re-read under the original run identity.

## 4. Request modes

The public service supports two explicit modes.

### 4.1 Deterministic mode

A deterministic request contains one typed operation, not a free-form semantic
question. The generic v1 vocabulary is:

- `Grep` — bounded lexical or regular-expression search;
- `OrdinalSlice` — bounded corpus-ordinal range selection;
- `InspectMetadata` — bounded corpus/value structure and size information;
- an application-registered pure deterministic operation admitted by the
  operator registry.

The history adapter adds `CursorSlice`, `TimeSlice`, `KeyTurns`, and
`TurnSummary` with history-specific Schemas and source-address behavior.

Deterministic execution MUST make zero model calls. It MUST be deterministic
for identical corpus bytes, operation, and caps. Caps truncate and are reported
in the result; they do not become operational failures.

### 4.2 Semantic mode

A semantic request contains a natural-language question and a mandatory
semantic run budget. It runs the Effect-native typed-operation loop.

Semantic mode MUST be explicitly selected by trusted caller code. A model tool
argument MAY request semantic mode only when the host tool configuration
allows it. The default OpenAgents tool configuration is deterministic-only or
requires an explicit user/application escalation for semantic mode.

The SDK MUST NOT ship an opaque `auto` policy that can spend tokens. A consumer
MAY implement an automatic policy outside the SDK after its own evaluation and
cost gate. If the SDK later standardizes such a policy, it must be a separately
versioned addition with its decisions exposed in the result.

## 5. Typed symbolic program loop

### 5.1 Program production

Each semantic iteration MUST request one finite `RlmProgram` with
`LanguageModel.generateObject` using the SDK's Effect Schema. The engine MUST
set an object name and provider-safe structured-output schema. It MUST NOT use
free-form `generateText` plus `JSON.parse` in the normative path.

An `RlmProgram` is an acyclic, bounded graph whose nodes consume corpus or
value refs and publish immutable output refs. The v1 node families are:

- `CorpusOp` — a registered pure deterministic operation such as generic
  `Grep`/`OrdinalSlice` or history-adapter `CursorSlice`/`TimeSlice`/
  `TurnSummary`;
- `Partition` — create an ordered collection of bounded spans or value slices;
- `Transform` — apply an allowlisted pure deterministic collection/value
  operator, including bounded project, filter, group, distinct, sort, join,
  combination, and formatting operations;
- `ModelMap` — invoke a one-shot leaf model over each admitted collection item;
- `RlmMap` — invoke a child RLM loop over each admitted collection item;
- `ModelReduce` — combine selected values through one-shot model calls using a
  bounded fan-in or reduction tree;
- `Commit` — select an existing value as the semantic output and attach
  citations or citation lineage.

Programs MUST NOT contain source code, arbitrary expressions, unbounded loops,
filesystem paths, imports, provider/account configuration, or application
Tools. Program graphs and every node parameter are decoded before execution.
Cycles, unresolved refs, output-ref collisions, excessive graph size, and
unbounded fan-out fail before any node starts.

The deterministic operations used inside semantic execution MUST share their
implementation with Tier D rather than grow a second search engine.

The engine MAY support application-registered deterministic operators. The
registry is trusted Layer configuration. Each operator supplies its own Effect
Schema, declares its cost dimensions, is pure over admitted values, and cannot
perform side effects or access services outside the narrow operator context.

This program graph is the safe equivalent of the paper's persistent REPL. A
surface that offers corpus operations and one explicit `Subcall` per root turn
does not satisfy this specification because it cannot launch programmatic
recursion over a collection.

### 5.2 Iteration transcript

The root model receives:

- constant-size corpus metadata;
- the user's question;
- current depth and remaining budget summary;
- a bounded catalog of current value refs, kinds, sizes, digests, lineage, and
  previews;
- a bounded transcript of prior program summaries and observations;
- the fixed program schema, admitted operator catalog, strategy profile, and
  security instruction.

It MUST NOT receive the whole corpus unless the corpus itself falls under a
separately configured direct-inclusion threshold. Direct inclusion is an
optimization for small corpora, not the default RLM mechanism, and must still
honor policy and observation limits.

Transcript growth MUST be bounded by bytes or encoded tokens. When the bound is
reached, the engine SHOULD retain operation summaries and source refs rather
than compact facts into an uncited prose summary. Transcript truncation MUST be
reported in progress and terminal honesty metadata.

Full intermediate values MUST NOT be copied into the transcript merely because
they were produced by a model call. The environment stores them and exposes a
bounded preview. A later node refers to the value by ref.

### 5.3 Persistent environment and value lineage

The environment is allocated per run and scoped under the run fiber. Values
are immutable after publication and carry:

- a run-local `valueRef`;
- kind and encoded media/schema ref;
- exact encoded byte count and digest;
- ordered collection cardinality where applicable;
- parent refs and producing program/node refs;
- source/citation lineage;
- bounded safe preview metadata.

The SDK MUST cap individual value bytes, total live environment bytes, value
count, collection cardinality, and preview bytes. It MAY evict an unreferenced
value under a deterministic policy, but MUST report that fact and fail a later
reference rather than returning different data. Environment state is
non-durable by default and is finalized on completion, error, or interruption.

### 5.4 Programmatic model and RLM calls

`ModelMap` performs one-shot semantic transformation. `RlmMap` performs
recursive symbolic traversal. The two MUST remain distinct in schemas, budget
accounting, progress, and evaluation.

Every mapped item MUST:

- resolve to an explicitly admitted corpus span or value ref;
- receive a bounded self-contained prompt derived from the strategy profile;
- share the parent run's deadline, token usage, call count, subcall count, and
  cancellation signal;
- fail closed when the input ref or span is empty, stale, or outside the
  admitted corpus/value lineage;
- publish its result as an immutable environment value;
- preserve deterministic input order in the resulting collection regardless
  of fiber completion order.

`RlmMap` additionally receives a fresh local iteration transcript, increments
depth before model execution, and returns citations that resolve to the parent
corpus digest. `ModelMap` does not increment RLM depth.

The engine MUST reserve whole-node fan-out, call/subcall allowance, value-byte
allowance, and concurrency permits before launching children. It MUST use
scoped Effect fibers and a global semaphore. A child failure follows the
declared node failure policy, interrupts policy-defined siblings, and cannot
leave detached work.

V1 supports bounded concurrency and MUST also be deterministic at concurrency
`1`. Applications may clamp concurrency to `1`; completion order never changes
collection or event-causality order.

### 5.5 Commit and large output

Semantic completion occurs only through `Commit`. `Commit` references an
existing environment value and validated citation lineage. It does not carry a
fresh free-form answer generated in the same operation.

If the value fits the inline-output cap, the terminal result includes it as a
bounded inline output. Otherwise, completion requires an admitted
`RlmArtifactSink`. The sink receives a bounded stream from the environment and
returns an artifact ref, digest, byte count, media type, and retention class.
Without an admitted sink, exceeding the inline cap yields an honest partial
result; the engine does not truncate and call it completed.

Artifact bytes, writes, and duration are globally budgeted. Default SDK Layers
do not persist artifacts. OpenAgents' initial `history_recall` tool admits only
inline terminal output.

### 5.6 Model and strategy profiles

The paper reports material differences across models, context windows, output
limits, and in-context strategy examples. The model Layer therefore includes a
trusted, versioned strategy profile with:

- safe root and leaf model refs;
- `strategyRef` and prompt-template version;
- allowed program/operator node families;
- per-call prompt/input and requested-output ceilings;
- reserved context/output headroom and token-estimation policy;
- batch-size/fan-out recommendations and hard application clamps.

The profile is construction-time policy, not model- or user-controlled request
data. Every terminal result and evaluation artifact records `strategyRef` and
safe model refs. A call that cannot fit within its per-call ceiling is split,
reduced, or stopped before provider invocation; global token budget alone is
not sufficient protection.

### 5.7 Model and contract failures

An invalid structured operation is a contract failure for that iteration. The
engine MAY re-ask within a small configured limit, but every re-ask:

- consumes an iteration;
- counts as a model call;
- contributes exact usage when known;
- emits a safe contract-retry progress event.

Repeated invalid operations fail with a typed contract error. They MUST NOT be
treated as a plausible free-form answer.

Authentication, quota exhaustion, rate limiting, and provider unavailability
remain typed model failures. The RLM engine does not invent its own blind retry
loop. Callers may provide an Effect `ExecutionPlan` through the model Layer for
admitted retry or fallback behavior.

## 6. Budgets

### 6.1 Required semantic caps

Every semantic request MUST carry or resolve to finite positive caps for:

- maximum depth;
- maximum iterations across each loop and maximum calls globally;
- wall-clock duration;
- maximum total known input tokens;
- maximum total known output tokens;
- maximum total known tokens;
- maximum subcalls;
- maximum program nodes per iteration and across the run;
- maximum map/reduce fan-out and fan-in;
- maximum concurrent model/RLM calls;
- maximum values, collection items, bytes per value, and total live
  environment bytes;
- maximum inline-output and artifact-output bytes;
- maximum prompt/input and requested output tokens per model call;
- maximum observation characters per operation;
- maximum transcript characters;
- maximum entries scanned by any deterministic operation;
- maximum spans or matches returned by an operation.

V1 defaults `maxDepth` to `1`. SDK defaults MUST be conservative.
Applications MAY lower them. Raising depth above `1`, enabling artifact
output, or raising concurrency above the application-tested value SHOULD
require evaluation evidence.

Schema decoders MUST reject `NaN`, infinity, negative values, fractional counts,
and values above SDK hard ceilings. Runtime code MUST NOT rely on TypeScript
types alone for budget validity.

### 6.2 Global enforcement

Depth is evaluated per branch. Every other spend cap is global across the run.
Children do not receive fresh token, call, subcall, environment, artifact, or
time budgets.

The engine MUST reserve program-node, fan-out, call/subcall, estimated
per-call-token, environment-byte, artifact-byte, and concurrency allowance
atomically before starting work. Usage is committed after a model response. If
committed usage crosses a cap, the run terminates as `Partial` and MUST NOT
start another call.

The wall-clock budget uses the Effect `Clock`. Tests use `TestClock`; production
code MUST NOT call `Date.now`, `setTimeout`, or a bespoke timer for run
deadlines.

### 6.3 Usage honesty

Provider usage fields are optional. Missing input, output, or total token counts
are `unknown`, never `0`. Usage carries a completeness state:

- `complete` — every admitted field for every call was reported;
- `partial` — some calls or fields were reported;
- `unavailable` — no token counts were reported.

The aggregate MAY sum known values but MUST state which fields are incomplete.
When `requireExactUsage` is true, an unmetered model response terminates the run
as a typed partial outcome before another call. OpenAgents semantic recall uses
`requireExactUsage: true`.

The SDK reports tokens and model-call identity. It MUST NOT calculate currency
cost without a caller-supplied, versioned price catalog. OpenAgents converts
usage into cost in its own exact-usage ledger.

## 7. Results and citations

### 7.1 Terminal domain results

Successful execution yields exactly one of:

- `Completed` — validated mode-specific output and citations;
- `Partial` — declared stop/incompleteness reason, optional best output, and
  any validated citations;
- `Refused` — policy intentionally declined the requested mode or scope.

Deterministic completed output is a set of exact cited findings. It MUST NOT be
represented as model-synthesized prose. Semantic completed output is either a
bounded inline committed value or an artifact descriptor plus citations. The
artifact descriptor is not permission to fetch the artifact; fetch authority
belongs to the host sink/consumer.

All terminal values include:

- run and corpus identity;
- mode/tier actually executed;
- validated citations;
- usage with completeness;
- budget consumption and hit caps;
- iteration, call, subcall, and maximum-depth counts;
- program-node, value, collection, concurrency, and artifact counts/bytes;
- safe root/leaf model refs and the versioned `strategyRef`;
- corpus coverage and exclusions summary;
- transcript/observation truncation facts;
- a safe trajectory summary containing operation kinds and refs, not raw
  corpus observations.

Cap reasons include at least timeout, iteration, program node, call, token,
per-call context/output, subcall, fan-out, concurrency, environment value/byte,
inline/artifact output, observation, and transcript caps. Evidence reasons
include missing citations, invalid citations, empty corpus, and incomplete
corpus coverage where the request requires complete coverage.

### 7.2 Citation validation

A citation MUST include:

- `corpusRef` and `contentDigest`;
- `scopeRef`;
- a bounded canonical source address with an adapter-owned Schema id;
- an entry ref or inclusive entry-ref range;
- optional bounded excerpt and excerpt digest.

Validation is deterministic. A citation resolves only if:

1. the corpus identity matches the run;
2. at least one corpus entry exists in the cited source range;
3. every included entry is visible in that already-filtered corpus;
4. an excerpt digest, when present, matches canonical excerpt bytes.

The engine MUST NOT silently drop invalid citations and still return
`Completed`. If citations are required and any are invalid or none resolve, the
answer becomes `Partial` with an evidence reason or the run fails with a typed
contract error according to fixed SDK policy. OpenAgents uses `Partial` so the
candidate answer remains inspectable without being laundered as complete.

Citation validity establishes provenance, not truth. UI and documentation MUST
not label an RLM answer “verified” solely because its citations resolve.

### 7.3 Error channel

Expected bounded outcomes stay in the value channel. Operational and contract
failures use a Schema-defined tagged error union. The public reasons include:

- invalid request or budget;
- corpus unavailable or changed during resolution;
- model authentication, quota, rate-limit, or availability failure;
- structured-output contract violation;
- usage required but unavailable;
- internal invariant violation.

Errors include bounded safe detail. Provider response bodies, prompts, corpus
text, and credentials MUST NOT be exposed in serialized errors.

## 8. Progress stream

Semantic execution exposes a canonical `Stream<RlmEvent, RlmError>`. The run
function is derived by draining that stream and returning its terminal result.
There is not a separate callback implementation.

The event vocabulary includes:

- run started;
- corpus resolved;
- iteration started;
- program selected/validated;
- program node started/completed;
- observation completed;
- value published/evicted with safe metadata;
- model-map and RLM-map batch started/completed;
- subcall started/completed;
- model call completed with safe exact-usage fields;
- artifact write started/completed;
- budget state changed;
- contract retry;
- one terminal completed/partial/refused event.

Events carry refs, counts, kinds, durations, and bounded safe summaries. They
MUST NOT carry raw prompts, reasoning, corpus slices, provider payloads, or
credentials by default.

For a non-interrupted run, the stream MUST emit exactly one terminal event and
then end. It MUST NOT emit events after the terminal event. A stream consumer
that stops early interrupts the producer through normal Effect scope cleanup.

Interruption emits no fabricated terminal domain result. The consumer's durable
runtime may independently record its standard interrupted event.

## 9. Security and privacy

- Authorization belongs to the corpus-source Layer, not model-controlled
  request fields.
- Requests crossing a network boundary MUST be decoded with Effect Schema.
- Corpus entries are filtered before any root or leaf call.
- Model-map and RLM-map children inherit the same filtered corpus and value
  lineage; they cannot change policy.
- The run-scoped environment exposes opaque refs and bounded previews, not an
  ambient filesystem or object graph.
- Registered deterministic operators are pure, Schema-decoded, allowlisted by
  trusted Layer configuration, and have no application service access.
- Raw observations are ephemeral unless a caller deliberately supplies a
  private trace sink.
- Default tracing records only refs and numeric metadata.
- Semantic model selection is supplied by a trusted Layer; requests contain no
  API keys or executable provider configuration.
- Provider calls MUST follow the application's existing trust boundary. The
  SDK does not send owner-private history to a newly selected provider.
- No arbitrary code execution exists in the engine. Sandbox support is not a
  requirement for the core RLM service.
- Artifact persistence is disabled unless the host supplies and admits an
  `RlmArtifactSink`; a terminal artifact ref does not widen read authority.
- If a future operation can perform side effects, it is a separate Tool with
  its own approval policy; it is not added to the corpus-operation union.

## 10. Authority boundary

The SDK owns traversal mechanics and contract honesty. It does not own:

- the authoritative source stores;
- provider/account admission;
- pricing and financial ledgers;
- application leases or run limits;
- app routing decisions;
- verification, acceptance, or release state;
- payments or settlement;
- public claims.

Consumers MUST treat RLM output as a cited candidate. Any transition from that
candidate to authority requires the consumer's existing proof and approval
system.

## 11. Compatibility

The first implementation may preserve current `HistoryRecall`, `recallTierD`,
and `runRecursiveRecall` exports. New code SHOULD consume the first-class
`Rlm` service and `@openagentsinc/ai/rlm` subpath.

Compatibility wrappers MUST preserve honesty. In particular they MUST NOT:

- coerce unknown tokens to zero;
- accept unvalidated numeric caps;
- complete with silently removed citations;
- reconstruct a terminal result from incomplete progress events;
- perform hidden semantic escalation.

Breaking removal of compatibility exports waits for a stable-major policy and
a completed OpenAgents npm-consumer migration.
