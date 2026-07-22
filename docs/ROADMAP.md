# @openagentsinc/ai — Proposed Roadmap

Date: 2026-07-22. Revision: 3. Status: active. This roadmap sequences the SDK's own
engine work. Consumption sequencing for the OpenAgents product lives in the
monorepo (`openagents/docs/desktop/2026-07-21-chat-runtime-unified-roadmap.md`
and the division-of-labor audit in `openagents/docs/fable/`). The two must
not drift — engine issues are filed HERE, consumption issues stay in the
monorepo.

## Where the SDK is today

Extracted 2026-07-21 from the openagents monorepo. Apache-2.0. Published rc
trains through `0.2.0-rc.5`. The monorepo consumes the train from npm and
deleted its in-tree copies. Layers L0–L6 are live: the
`effect/unstable/ai` model bridge (`ai-model`), the `KhalaRuntimeEvent`
vocabulary (`agent-runtime-schema`), the durable seq-cursor event log, the
sandbox seams, the `AgentHarness` contract with suspend/continue and the
slice runner, the UI stream (chunk projection, progressive reducer,
smoothStream, partial objects, ChatTransport), recall (`history-corpus`),
and the first-class recursive engine (`rlm`, SDK-RLM-01..08 + 04A —
Effect-native, no Python, no code execution).

## The one rule

Every layer speaks `KhalaRuntimeEvent` upward. One event union. One durable
cursor. New work either speaks it or maps into it at the boundary.

## Phase 1 — Stabilize the train (near term)

1. **Conformance as product.** Promote the per-package test suites into a
   published conformance kit: reference-adapter semantics, event-log
   replay/attach laws, reducer snapshot laws, recall honesty laws, RLM cap
   laws. A third-party adapter or store passes the kit or it is not
   conformant.
2. **Export-map and API audits per train.** No breaking export change
   without a train bump the monorepo adopts in one commit. Automate the
   audit the AISDK-02 collision check started.
3. **Version convergence.** One version per train across the roster. The
   known monorepo straggler pin converges on the next bump.
4. **Docs.** Per-package READMEs to one standard, a getting-started that
   runs, and the layer index mirrored from the monorepo `docs/ai-sdk/`.

## Phase 1B — The harness wave (owner directive 2026-07-21: ASAP, first wave)

Six adapters behind the `AgentHarness` contract, mirroring the Vercel AI SDK
harness family (a harness is a complete agent runtime — workspace access,
built-in tools, native session state, compaction, permission flows,
runtime-specific configuration — behind one surface, sandbox-safe by
default):

1. **Codex** — the `codex` runtime as a first-class adapter (app-server
   JSON-RPC preferred, `codex exec --json` fallback). The monorepo lane is
   the reference implementation to generalize.
2. **Claude Code** — the `@anthropic-ai/claude-agent-sdk` runtime as an
   adapter. Host-resident — suspend and continue take the contract-blessed
   degraded rerun form.
3. **OpenCode** — promote the existing fixture-tested adapter to a live
   runtime adapter against a local opencode server.
4. **Pi** — host-process adapter per the 2026-07-21 Pi teardown scope
   (injected SessionManager seams, no bridge needed, per-account agent
   dirs, JSONL session-tree resume).
5. **Cursor** — productize the ACP factory configuration into a named
   adapter with its own conformance run.
6. **Goose** — a new adapter (ACP if Goose speaks it, else its native
   session surface).

Each adapter ships with: the event projection onto `KhalaRuntimeEvent`,
capability honesty (which verbs are lossless, degraded, or refused),
approval routing through `RuntimeInteraction`, a conformance run against
the reference-adapter laws, and a sandbox posture (owner-local or a
sandbox-provider seam). A thin `HarnessAgent`-style facade may follow so a
consumer drives any adapter with one call surface — the session verbs stay
the contract underneath.

## Phase 2 — DSE programs (the DSPy of Effect)

The OpenAgents monorepo already implements the first typed-program compiler as
`@openagentsinc/dse`. The SDK must not create a second `Program` abstraction
beside it. DSE is the canonical compile-side contract. This phase stabilizes
that contract, extracts it with the same package discipline as the other SDK
layers, and connects its runtime receipts to the neutral event stream.

- **Signatures are Effect Schemas.** `DseSignature<I, O>` declares its input
  and output schemas. Decode is the only validity authority. A partial-object
  stream is progress only. It is not a validated result.
- **Compiled programs are immutable artifacts.** A program binds its Prompt
  IR, signature, dataset and metric refs, optimizer configuration, and content
  digest. A runtime resolves exact bytes. It does not silently change a prompt
  or optimizer output.
- **Predict is the model-program runtime.** Predict uses an injected
  `LanguageModel`, performs bounded Schema repair, records exact or explicitly
  unavailable usage, and emits neutral run events through an adapter. DSE does
  not create a second event union.
- **Optimizers are bounded offline workflows.** Search is capped by candidate,
  token, time, and spend limits. It produces typed candidate and evaluation
  records. It cannot activate its own output.
- **Eval contracts are first-class.** Immutable datasets, fail-closed splits,
  and typed scorers bind every improvement claim to an exact evaluation.
  Correctness has priority over resource savings.
- **One public vocabulary.** “Program” means a DSE signature plus an immutable
  compiled artifact at the model-program boundary. An RLM symbolic program is
  a separate, run-scoped query plan and keeps the explicit `RlmProgram` name.

## Phase 3 — RLM deepening

1. Multi-corpus recall — thread sets, repositories, evidence packs — with
   corpus composition laws and per-corpus redaction policy.
2. Tier D indexing for large corpora (the deterministic tier stays fast as
   corpora reach repo scale).
3. The dense-recall evaluation harness as a public conformance suite
   (monorepo RLM-07 produces the first evidence; the harness itself lives
   here).
4. A trained-orchestrator admission path, gated strictly on that evidence.

### Phase 3A — Derived graph-memory corpora (Cognee fast follow)

SDK-MEM-02 (#31) supplies corpus v2 source planes, deterministic composition,
exact child citations, and explicit v1 migration. Later graph issues consume
this contract. They do not change its authority boundary.

SDK-MEM-03 (#32) adds the portable graph schemas, canonical identity,
ref-only provenance, deterministic rebuild, small snapshot handle, and exact
RLM locator compatibility. It does not add the #35 RLM projection, extraction,
persistence, ranking, deletion, archive, or query execution.

Owner direction on 2026-07-21 admits issue decomposition for this ordered
program. Implementation remains issue-scoped. The source evidence is the
Apache-2.0 Cognee tree at
[`90b4acaac937dc1c0aeffaead8b707c896ebf3db`](https://github.com/topoteretes/cognee/tree/90b4acaac937dc1c0aeffaead8b707c896ebf3db)
and the commit-pinned
[OpenAgents teardown](https://github.com/OpenAgentsInc/openagents/blob/c69976916460461a92dae074e9ddba32db88bfd1/docs/teardowns/2026-07-21-cognee-teardown.md).
Cognee is evidence, not a dependency or design authority.

The target is not “Cognee in TypeScript.” The target is a rebuildable,
source-addressed graph projection that implements the existing
`RlmCorpusSource` contract. `KhalaRuntimeEvent` remains the durable runtime
event vocabulary. Graph nodes, edges, embeddings, summaries, and ranking
features are derived read artifacts. They do not become new event kinds or a
second truth store.

#### Placement and ownership

- **`@openagentsinc/rlm` owns generic corpus identity and composition.** It
  keeps immutable content and manifest digests, bounded handles, source
  addresses, visibility, redaction, and citation validation.
- **`@openagentsinc/graph-corpus` owns the portable graph projection.** It owns
  graph schemas, deterministic identity, provenance, graph-source capability
  declarations, pure index planning, deterministic retrieval operators, and
  conformance laws. It does not own a database, tenant policy, or a model
  credential.
- **`@openagentsinc/dse` owns entity and relation extraction.** An extractor is
  a DSE signature and exact compiled artifact. Its output is decoded graph
  candidate data with a predict receipt. Deterministic parsers use the same
  output contract without a model call.

SDK-MEM-05 (#34) implements this boundary. Model output contains batch-local
candidate keys, confidence, and advisory graph facts only. The runtime joins
exact RLM source locators, scope, compiled-program identity, derivation, and
usage receipt refs after decode. It reports `Complete`, `Partial`, `Refused`,
or `Failed` and enforces explicit entry, character, token, output, model-call,
and time limits. Version 1 runs batches in serial and fixes the concurrency
limit at `1`. The model receives one receipt-bound canonical envelope that
separates trusted program blocks from untrusted corpus text. The runtime checks
immutable-corpus evidence at each external-call boundary. Only a validated
`Complete` result can enter the separate pure graph build. It adds no database,
retrieval, ranking, deletion, background, spend, or profile-memory authority.

- **Consuming applications own authority and persistence.** Consent, owner
  scope, promotion, durable adapters, deletion execution, spend admission,
  profile memory, and public projection stay outside the SDK. The OpenAgents
  monorepo keeps these rules in `packages/agent-experience-memory` and app
  composition roots.

#### Graph identity and provenance

Name-only identity is not sufficient. Two entities can have the same name.
Every canonical graph element therefore binds:

- the graph schema and canonicalization versions;
- the element kind;
- an adapter-declared identity namespace and canonical key;
- the authorized scope when identity is not global; and
- the ordered source-address set that supports the element.

Mentions and canonical entities are separate types. A mention always retains
its exact source address. A merge creates explicit merge evidence; it does not
erase the mentions. Equal source bytes, extractor artifacts, decoded outputs,
canonicalization rules, and policy inputs must produce the same graph digest.
A model rerun is a new input and can produce a new digest.

Each node and edge records provenance through refs, not copied private source
text: source addresses, source content digests, extractor kind, signature and
compiled-program digests, decode outcome, and usage receipt ref. A
deterministic extractor records its parser and version instead of fabricated
model usage.

#### Corpus composition and recall

Graph recall enters RLM through a graph corpus handle. It does not add graph
fields to every runtime event. Multi-corpus composition must:

- preserve each child corpus identity and source plane;
- apply policy before composition and never widen a child policy;
- use deterministic ordering and a composition digest;
- retain original source addresses for citation validation; and
- report coverage, exclusions, stale projections, and unsupported operations.

The generic corpus vocabulary must distinguish the source plane from an
adapter-specific source kind. Initial source planes are event log, thread
snapshot, repository, evidence pack, derived graph, and profile memory. A graph
result cites both its graph element address and the original source addresses
that support it. Natural-language and raw Cypher execution are not public
agent operations. The first graph operators are bounded, typed, and
deterministic: element lookup, neighbor traversal, source expansion, and
bounded graph-text search.

#### Capabilities and storage

The SDK declares observed adapter capabilities instead of assuming that every
store supports the same operations. Capabilities include graph read, vector
read, hybrid query, atomic graph-vector projection, provenance delete
planning, and snapshot export. A capability is descriptive. It grants no
authority and does not create a generic memory-provider seam.

The portable package starts with an in-memory conformance adapter. Concrete
database adapters are separate packages or application layers after a real
placement need exists. No Python process, Cognee service, Cognee Cloud call,
or third-party stateful sidecar enters an engine path.

#### Deletion, ranking, and truth

Forgetting is planned from sources outward. A pure delete planner accepts an
exact source address and graph snapshot. It returns the nodes, edges, vectors,
summaries, and ranking features that become removable. Shared elements retain
their other source memberships. Execution is host-owned, idempotent, and
receipted. A successful plan is not evidence that deletion ran.

SDK-MEM-04 (#33) implements this portable contract. The package declares
adapter support, plans from one exact RLM v2 source locator, preserves shared
support through explicit rekeys, and accounts for vector, summary, and ranking
artifacts. Each artifact plane has an explicit coverage claim. Incomplete
inventories, retained edges with removed endpoints, and rekey collisions stay
explicit. Complete result validation compares the actual after state with a
pure projection. A retained owner rekey removes each obsolete artifact and
requires a later rebuild. Only a complete plan can produce a result and
receipt. An incomplete plan can produce only a pre-execution refusal. The
implementation does not execute deletion or grant host authority.

Feedback changes a separate ranking snapshot. It never changes graph content,
identity, provenance, or embedding bytes. A recall result records the exact
graph digest, ranking-snapshot digest, query, and used element refs. Equal graph
and ranking inputs must produce equal order. A consumer can ignore ranking
state and still traverse the same graph truth.

SDK-MEM-07 (#36) implements this ranking boundary. Feedback, confidence,
features, snapshots, outcomes, and used-element evidence bind the exact graph
and RLM identities. All score values use bounded fixed-point micro-units. The
pure ranker accepts only complete graph operations and uses a stable tuple:
feedback, confidence, operation-local relevance, and element ref. Missing
ranking inputs stay explicit and do not remove a candidate. A disabled ranker
returns `Unranked` and keeps the original order. A truncated operation also
stays `Unranked` and retains its cap evidence. Used-element evidence contains
exact bounded addresses and source locators but excludes source text and
canonical keys. A separate typed operation binding derives the ranking query
digest without a change to the #35 operation-result schema. It keeps exact
text queries, descriptor refs, vector digests, and complete retrieval-context
digests, but excludes raw vector bytes. The #35 vector and hybrid operation
receipts also bind the descriptor and retrieval-context digests. The caller supplies the trusted
`expectedOperationDigest` separately. Strict validators reconstruct
deterministic results, compare each observation with the unchanged projected
corpus, and reject stale graphs, changed snapshot children, changed operation
inputs, substituted provider descriptors, and substituted evidence. A content
hash proves integrity. It does not grant authority or prove who approved the
operation. Ranking artifact refs connect this snapshot to the source-outward
delete planner without making ranking state part of graph truth.

#### Portability

SDK-MEM-08 (#37) adds the OpenAgents graph corpus archive v1. It uses canonical
UTF-8 JSON and independently digested graph, node, edge, source-membership,
merge-evidence, provenance, and descriptor sections. The manifest binds exact
content, section, manifest, archive-ref, coverage, exclusion, ordering, and
provenance-ref values. Optional portable vector and summary payloads and #36
ranking state do not change base graph identity.

The importer applies byte and aggregate item limits before expensive work. It
rejects noncanonical bytes, changed digests, stale bindings, unsupported
versions, and unversioned data that requires a migration. It rebuilds the
graph through `buildGraphCorpus` and returns deeply frozen inert data only. A
content extension requires an exact source, graph, policy, classification,
content-digest, and separately supplied host-authority binding. Import does not
activate a service, call a model, access credentials, write storage, grant
consent, or claim COGX compatibility.
Private source content is absent unless a host separately authorizes it.
Import validates bytes and produces an inert corpus snapshot. It does not
grant consent, promote memory, activate an index, or claim compatibility with
COGX. COGX support needs a separate, evidence-backed interoperability issue.

#### Conformance and close conditions

The published conformance kit must test:

- deterministic rebuild and canonical ordering;
- identity separation for same-name entities and explicit merge evidence;
- policy monotonicity and redaction before extraction and recall;
- citation resolution from graph elements to original source addresses;
- shared-element retention and complete derived-artifact delete plans;
- no orphan vector, summary, or ranking refs after simulated deletion;
- graph-digest stability when only ranking state changes;
- deterministic ranking for equal graph and ranking snapshots;
- capability refusal for unsupported operations; and
- archive round-trip identity, corruption refusal, and inert import.

The phase is implemented only when the packages and laws are merged and the
OpenAgents consumer has completed its separate authority and durable-adapter
work. It is released only in an intentional rc train. Neither state proves
retrieval quality, owner acceptance, production use, or a public product
claim.

#### Explicit rejections

- Cognee as a runtime dependency, Python sidecar, service, or cloud backend.
- Background “improve” work that spends tokens or promotes session content
  without host admission and exact usage truth.
- Dataset ACLs as a substitute for owner scope, consent, visibility, and
  redaction policy.
- Name-only canonical identity.
- Feedback that mutates graph truth or embedding identity.
- Unbounded natural-language graph queries or agent-authored Cypher.
- A generic memory-provider seam before two owned backing implementations
  require one.
- A COGX compatibility claim without a separately pinned interoperability
  study and conformance corpus.

## Phase 4 — Surface and transport

1. **Generative UI.** A schema-constrained UI-spec layer in the
   `UiMessageChunk` pipeline: typed component catalogs, streamed as chunks,
   validated at the boundary — agents stream typed UI, not just text.
   Composes with partial objects and guided generation.
2. **Web transport productization.** The SSE `ChatTransport` Layer hardened
   for server use: resume-at-cursor over public APIs, reconnect
   conformance fixtures, browser reducer bindings.
3. **Provider gateway.** A registry/gateway Layer over `Model`s with
   `ExecutionPlan` policies per model class — ordered fallback, honest
   failure classes (`ModelFailureClass`), never laundering an exhausted
   account.

## Phase 5 — Harness breadth (beyond wave 1)

1. Adapters beyond the Phase 1B six: additional ACP peers and non-ACP
   runtimes that fit the session verbs.
2. Sandbox provider breadth: the managed-provider seam
   (`ai-sdk-sandbox-openagents`) tracks the monorepo's managed-sandbox
   substrate as it opens.
3. Suspend/continue conformance for every adapter — lossless where the
   architecture allows, honest `lossy` where it does not.

## Boundaries (standing)

- No authority: leases, caps, journals, receipts, custody, settlement, and
  usage ledgers stay in consuming applications.
- No app wiring: renderers, routers, product policy stay downstream.
- No Python, no arbitrary code execution in any engine path.
- Redaction (`visibility`, `redactionClass`) gates every projection — a
  public surface can never widen what it sees.
- Ideas from other SDKs are re-derived, never vendored.
- Derived memory indexes remain advisory read projections. They cannot become
  authority, consent, verification, release, or public-claim state.

## Issue conventions

Engine work is filed on this repository (the SDK-RLM-01..08 pattern).
Consumption work stays on `OpenAgentsInc/openagents`. Cross-cutting
programs keep a monorepo epic with SDK children linked. Each phase above
becomes its own epic when admitted — this roadmap proposes, it does not
dispatch. The 2026-07-21 owner direction admits the Phase 3A issue series only;
each child issue still owns its exact paths, dependencies, proof, and close
rule.
