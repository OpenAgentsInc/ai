# OpenAgents consumption specification

This document defines how `OpenAgentsInc/openagents` consumes first-class RLM
support from this SDK. It is an adapter and authority contract, not a license to
move desktop or fleet policy into the public package.

## 1. Outcome

OpenAgents should be able to:

1. build an authorized corpus from its durable event logs and thread stores;
2. offer deterministic recall to every admitted agent lane;
3. offer semantic recursive recall only under explicit spend policy;
4. show bounded progress and cited results through the existing tool/UI stream;
5. record exact per-call usage through its existing ledger;
6. let Full Auto consult run history without transferring Full Auto authority;
7. evaluate dense-history recall before making quality claims or enabling
   automatic semantic escalation.

OpenAgents MUST consume these capabilities from published
`@openagentsinc/*` packages. It MUST NOT retain or recreate private copies of
the SDK RLM engine after the npm cutover.

## 2. Repository boundary

### Lives in this SDK

- corpus and manifest Schemas;
- deterministic corpus builder primitives;
- deterministic traversal;
- first-class `Rlm` and `RlmCorpusSource` service contracts;
- Effect-native semantic recursion;
- budgets, progress, results, errors, usage completeness, and citation
  validation;
- the Effect `history_recall` Tool constructor;
- conformance fixtures and scripted-model test helpers.

### Stays in OpenAgents

- desktop event-log and thread-store adapters;
- authorization and visibility policy selection;
- provider/account readiness and model Layer choice;
- account custody and credentials;
- the desktop usage ledger and any price catalog;
- runtime `tool.call`/`tool.result` recording;
- renderer copy and behavior contracts;
- Full Auto leases, run caps, journal, continuation framing, and receipts;
- workroom/evidence-pack adapters;
- cloud placement and owner-scoped storage;
- verification, release, promise, payment, and settlement authority.

The dependency direction is one way: OpenAgents depends on the SDK. The SDK
does not import OpenAgents app modules.

## 3. Dependency cutover

The monorepo completed its SDK npm-consumer swap at SHA `314a14da78`. The
package catalog pins one coherent rc train, including:

- `@openagentsinc/ai`;
- `@openagentsinc/rlm`;
- `@openagentsinc/history-corpus`;
- `@openagentsinc/agent-harness-contract`;
- `@openagentsinc/agent-runtime-schema`;
- `@openagentsinc/ai-model`.

OpenAgents application code SHOULD import the canonical umbrella subpath:

```ts
import { Rlm, makeRlmTool, rlmLayer } from "@openagentsinc/ai/rlm";
```

It SHOULD import granular packages only in adapters whose type dependency is
specifically narrower. No `workspace:*` dependency on removed SDK packages
remains after cutover.

Because the package train is pre-stable, the monorepo pins exact rc versions.
It does not consume `latest`, a floating `rc` tag, or semver ranges in the lock
step that changes runtime contracts.

## 4. Corpus-source Layer

OpenAgents provides a `DesktopHistoryCorpusSource` Layer. It adapts, read-only:

- the durable `HarnessEventLogStore` implementation;
- the thread store's neutral snapshots;
- the run registry's authorized thread/turn membership;
- any separately admitted evidence/workroom adapter.

The Layer owns authorization. Its `resolve` implementation receives a logical
scope and derives the effective policy from the current owner/session context.
It does not accept a model-provided visibility or redaction allowlist.

The Layer returns the SDK's generic immutable `RlmCorpusHandle`. It SHOULD use
bounded range reads and streaming scans over the durable stores rather than
materializing a second complete copy of a very large run. History-specific
scope and source-address details remain in this adapter.

For a thread scope it:

1. proves the current owner can access the thread;
2. resolves the complete authorized turn set;
3. reads each durable turn from the beginning;
4. joins neutral thread notes where admitted;
5. applies visibility/redaction filtering;
6. builds canonical chronological order, ordinals, entry refs, and digest;
7. returns the coverage and exclusions manifest.

For a run scope it derives thread membership from the authoritative run
registry. A model cannot nominate an unrelated thread id.

The adapter MUST state source gaps. RLM support does not excuse missing neutral
event projections. If a source kind is absent, the manifest names that absence.

## 5. Model Layer and account policy

The SDK receives already-admitted model Layers. OpenAgents chooses them using
its existing readiness, account-health, model-selection, and routing policy.

Rules:

- no credentials or raw provider config in `RlmRequest`;
- no fallback to a different account unless existing policy admits it;
- authentication and quota exhaustion remain distinguishable;
- root and leaf model refs are safe policy refs, not secrets;
- leaf calls may use a cheaper admitted model;
- the model plan pins a versioned `strategyRef`, prompt profile, and trusted
  per-call context/output headroom;
- semantic recall is unavailable when no healthy admitted model Layer exists;
- a recall outage does not make an unrelated agent turn or Full Auto run
  falsely successful.

The first OpenAgents rollout uses `requireExactUsage: true`. A provider that
does not report the necessary usage may support deterministic recall but is not
admitted for multi-call semantic recall until an exact accounting path exists.

## 6. `history_recall` host tool

OpenAgents builds the tool with `makeRlmTool` and passes it through the existing
Effect Toolkit/harness bridge. There is one tool definition and one approval
path.

### Tool input

The model-visible input contains only:

- a bounded question or deterministic operation;
- a constrained logical scope such as `current_thread` or `current_run`;
- an admitted tier selector;
- optionally requested caps that the host clamps downward.

It MUST NOT expose:

- arbitrary owner/thread ids without authorization;
- visibility or redaction policy;
- model/provider/account selection;
- API keys;
- local filesystem paths;
- arbitrary corpus text;
- an unbounded budget.

### Admission

Deterministic mode is admitted by default when a corpus can be resolved.
Semantic mode requires one of:

- explicit user intent in the turn;
- an application-owned policy already admitted by the dense-recall evaluation
  gate;
- an approval interaction when the product chooses approval-per-spend.

The model cannot self-authorize semantic spend merely by setting
`mode: "semantic"`.

### Stream re-entry

The host tool invocation and final result use the existing neutral runtime
events:

- `tool.call` when recall begins;
- safe transient progress through Toolkit preliminary results and UI chunks;
- `tool.result` containing a bounded encoded terminal result;
- `tool.error` for typed operational failure.

No new RLM-specific `KhalaRuntimeEvent` union is created. Raw prompts,
observations, and subcall transcripts do not enter the durable neutral log.

The final tool result includes answer/candidate text, validated citations,
honesty, coverage, and usage summary. The UI labels it as recalled/cited, never
verified.

The initial desktop tool admits only bounded inline output. The SDK's artifact
output capability is not permission for `history_recall` to create or expose a
durable artifact; that requires a separate application policy and UI contract.

## 7. Renderer contract

The renderer uses the existing `UiMessageChunk` and progressive tool-state
machine. It should display:

- deterministic versus semantic tier;
- current iteration/subcall progress;
- elapsed time;
- exact tokens used so far when known;
- hit caps and usage incompleteness;
- completed, partial, refused, or failed status;
- citations that can navigate to the source turn/cursor;
- corpus coverage caveats.

Progress is transient. The bounded terminal result is persisted through the
normal tool result. The renderer must remain correct after replay when transient
progress is absent.

Partial answers are visibly partial. A citation-resolution failure cannot use
the completed treatment. Unknown token usage reads “unknown” or “not measured,”
not `0`.

## 8. Usage-ledger integration

Every `RlmModelCallCompleted` event carries a stable call ref and optional exact
usage. OpenAgents records it idempotently using:

```text
rlm:<runRef>:<callRef>
```

The ledger row records:

- provider and account selected by OpenAgents policy;
- requested model ref;
- root/leaf role and depth;
- known input/output/total fields;
- usage completeness;
- the RLM run ref and source tool call ref.

The SDK does not assign monetary cost. OpenAgents may compute cost using its
versioned price catalog. If a provider supplies no usage, the ledger records an
unknown measurement state; it does not synthesize zeros.

Contract retries and provider fallback attempts are distinct calls when they
incur spend. The integration must not record only the final successful call.

## 9. Full Auto consumer

Full Auto may consume RLM as bounded evidence during continuation framing. It
does not delegate run authority to RLM.

The consumer:

1. derives a run-scoped corpus from authoritative registry membership;
2. first attempts deterministic recall for known structural questions;
3. performs semantic recall only when admitted and within a per-run budget;
4. inserts a bounded cited candidate into continuation context;
5. records recall usage and result refs in the run graph;
6. continues safely without recall when recall is refused, partial, or
   unavailable according to existing run policy.

Unchanged Full Auto invariants:

- leases and generation fencing;
- run and concurrency caps;
- provider/account custody;
- journal and receipts;
- stop/reconcile behavior;
- acceptance and verification authority.

RLM failure MUST NOT stall teardown or leak a lease. A remembered candidate
MUST NOT be presented as a verified continuation fact without the normal proof
path.

## 10. Current issue mapping

The existing OpenAgents RLM program maps to the SDK boundary as follows:

| OpenAgents issue              | Disposition after SDK first-class support                                              |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| #9137 RLM-01 corpus           | SDK implementation; OpenAgents keeps only source adapter                               |
| #9138 RLM-02 Tier D           | SDK implementation; OpenAgents consumes it                                             |
| #9139 RLM-03 host tool        | Landed for Tier D; migrate the adapter to the first-class SDK `makeRlmTool` for Tier S |
| #9140 RLM-04 recursive engine | SDK implementation and conformance                                                     |
| #9141 RLM-05 Tier S service   | SDK `Rlm` service plus OpenAgents model/ledger/UI adapter                              |
| #9142 RLM-06 Full Auto        | OpenAgents-only consumer                                                               |
| #9143 RLM-07 evaluation       | shared SDK fixtures; OpenAgents transcript evaluation/report                           |
| #9144 RLM-08 cloud/evidence   | deferred OpenAgents admission; SDK contract reused                                     |

Completed monorepo implementations are treated as extraction source and
behavioral evidence. Once the npm cutover lands, future fixes are made here and
consumed by version bump rather than patched in both repositories.

## 11. Ordered rollout

### Phase A — SDK contract release

- implement this spec in `OpenAgentsInc/ai`;
- add `@openagentsinc/ai/rlm` and granular `./rlm` exports;
- publish one coherent rc train;
- ship conformance fixtures and migration notes.

### Phase B — monorepo npm cutover (landed)

- replace workspace SDK dependencies with the published train;
- delete duplicate SDK packages;
- keep app adapters, fleet policy, and desktop wiring;
- run the full desktop gate and smokes.

### Phase C — deterministic tool

- treat the landed #9139 implementation as the behavior oracle;
- provide `DesktopHistoryCorpusSource`;
- wire `history_recall` deterministic mode through Toolkit/harness;
- persist normal tool call/result events;
- render citations and partial states;
- prove reload/replay behavior.

### Phase D — semantic tool

- provide admitted root/leaf model Layers plus a pinned strategy profile and
  per-call context/output headroom;
- provide exact-usage sink integration;
- enable semantic mode behind explicit admission;
- clamp program nodes, fan-out, concurrency, values, and inline output;
- prove interruption, caps, account failures, and missing usage behavior.

### Phase E — Full Auto

- consume run-scoped recall at continuation framing;
- prove recall failure does not stall or change authority;
- display run-level usage and result refs.

### Phase F — evidence gate

- run the dense-recall suite against OpenAgents transcript shapes;
- compare deterministic, direct-model, semantic depth 0/1/higher,
  bounded-window, and provider-compaction baselines;
- include O(1), O(n), O(n^2), long-output, and million/10M+-token out-of-core
  fixtures where applicable;
- report success-stratified p50/p75/p90/p95/p99 calls, latency, tokens, and
  cost for each pinned strategy profile;
- decide separately whether automatic semantic escalation or depth above one
  is justified.

## 12. OpenAgents acceptance checklist

- [ ] All SDK imports resolve from pinned npm packages.
- [ ] No duplicate RLM engine remains in the monorepo.
- [ ] Scope authorization is enforced before corpus construction.
- [ ] Visibility/redaction cannot be widened through tool arguments.
- [ ] Deterministic mode makes zero model calls.
- [ ] Semantic mode is explicit and globally capped.
- [ ] Program nodes, fan-out, concurrency, environment bytes, and inline
      output are application-clamped.
- [ ] The initial desktop tool cannot create artifact output.
- [ ] Strategy profile and per-call model headroom are pinned and recorded.
- [ ] Provider/account selection remains OpenAgents-owned.
- [ ] Exact usage is idempotently recorded per model call.
- [ ] Unknown usage is never zero.
- [ ] Tool progress is transient and bounded.
- [ ] Terminal result replay renders without progress history.
- [ ] Invalid citations cannot complete.
- [ ] Recall output is labeled candidate/cited, not verified.
- [ ] Full Auto authority and teardown invariants are unchanged.
- [ ] Full desktop check, build, Electron smoke, and React smoke are green.
- [ ] No public long-context quality claim is made without the normal promise
      and evidence gate.
