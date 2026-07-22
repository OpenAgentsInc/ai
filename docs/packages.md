# Packages

The SDK publishes from this repository as one `rc` train on npm. This page
lists each package, its layer, its key exports, and when to use it. Every
export named here exists in the published `rc` packages.

**Source of truth.** This page is mirrored to the monorepo consumer copy at
[`openagents/docs/ai-sdk/packages.md`](https://github.com/OpenAgentsInc/openagents/blob/main/docs/ai-sdk/packages.md)
(live at [openagents.com/aisdk/docs/packages](https://openagents.com/aisdk/docs/packages)).
The engine and the export map live here; keep the two copies in sync.

For the L0–L6 diagram and the one-event rule, see the [layer index](./README.md).

## @openagentsinc/ai

The umbrella package (**all layers**). It holds no logic. The root entry
re-exports the L1 vocabulary, the L2–L5 harness contract, L6 recall, and the L0
model substrate. It exposes DSE as the `Dse` namespace and graph corpus as the
`Graph` namespace. Each layer also has a curated subpath, for example
`@openagentsinc/ai/harness` and `@openagentsinc/ai/recall`.

- Key exports: the union of the layer packages below, plus the subpaths
  `./model`, `./schema`, `./event-log`, `./sandbox`, `./harness`, `./ui-stream`,
  `./recall`, `./rlm`, `./graph`, `./graph/ranking`, `./graph/archive`, the
  optional `./conformance` test surface, and the `./program*` family.
- Use it as the default dependency. Reach for a layer package directly only when
  you want a smaller dependency surface.
- npm: [@openagentsinc/ai](https://www.npmjs.com/package/@openagentsinc/ai)

## @openagentsinc/agent-runtime-schema

The **L1** vocabulary. One neutral event union from the model call to the
rendered message.

- Key exports: `KhalaRuntimeEvent`, `decodeKhalaRuntimeEvent`,
  `AgentRuntimeVisibility`, `AgentRuntimeRedactionClass`, `RuntimeInteraction`,
  and the turn, provider, artifact, and route schemas. The `./webhooks` subpath
  normalizes provider webhook deliveries into bounded trigger events.
- Use it when a consumer needs the event union or its codecs without the harness
  machinery. `sequence` is the durable cursor. Visibility and redaction class
  are schema fields on every event.
- npm: [@openagentsinc/agent-runtime-schema](https://www.npmjs.com/package/@openagentsinc/agent-runtime-schema)

## @openagentsinc/agent-harness-contract

The **L2–L5** core. The durable event log, the sandbox contract, the harness
adapter contract, and the UI stream projection live here.

- L2 key exports: `makeHarnessEventLog`, `makeInMemoryEventLogStore`, replay,
  live attach, and rerun boundaries over a seq-cursor log.
- L3 key exports: the sandbox-provider contract, `makeLocalSandboxProvider`
  (in-memory double), and `makeLocalProcessSandboxProvider` (real host process).
- L4 key exports: the `AgentHarness` contract, `makeReferenceAdapter`,
  `projectHarnessReadiness`, capability-by-method-presence, the session verbs,
  skills, host tools, the slice runner, and the ACP and opencode adapters.
- L5 key exports: `khalaEventToUiChunks`, `initialUiMessage`, `applyUiChunk`,
  `reduceUiMessageStream`, smooth streaming, partial object streams, and the
  chat transports for event-log, SSE, and IPC.
- Use it to build or consume a coding-agent harness behind one versioned
  contract.
- npm: [@openagentsinc/agent-harness-contract](https://www.npmjs.com/package/@openagentsinc/agent-harness-contract)

## @openagentsinc/ai-model

The **L0** model-call substrate over `effect/unstable/ai`. Upstream is consumed,
never forked.

- Key exports: `khalaEffectAiLanguageModelLayer`, `makeKhalaModelFallbackPlan`,
  `buildKhalaAiSdkCoreStreamTextOptions`, `runKhalaEffectAiCoreRuntime`, and
  `khalaAiSdkTextStreamPartFromEffectAiStreamPart`.
- Use it to make the model call, map provider stream parts into
  `KhalaRuntimeEvent`, and run typed fallback plans that never launder an
  exhausted account.
- npm: [@openagentsinc/ai-model](https://www.npmjs.com/package/@openagentsinc/ai-model)

## @openagentsinc/history-corpus

**L6** recall. The full history stays durable and a typed service traverses it.

- Key exports: `buildHistoryCorpus`, `recallTierD`, the `HistoryRecall` service,
  the recursive recall engine, the `history_recall` host tool, and
  `historyCorpusToRlmInput` from the `./rlm` subpath.
- Use it for recall instead of compaction. Tier D recall is pure and
  deterministic and reports an honesty record with every answer.
- npm: [@openagentsinc/history-corpus](https://www.npmjs.com/package/@openagentsinc/history-corpus)

## @openagentsinc/rlm

The **L6** recursive recall engine. It runs typed recall programs over a corpus
source, deterministically first (Tier D) and recursively second (Tier S).

- Key exports: `makeRlm`, `rlmLayer`, `rlmDeterministicLayer`, `runRlm`,
  `streamRlm`, `RlmCorpusSource`, `makeCompositeCorpusHandle`,
  `migrateRlmCorpusV1`, and `rlmInlineCorpusSourceLayer`.
- Use it when Tier D questions are not enough and you want a bounded engine that
  composes recall steps. It is generic — history is one adapter
  (`@openagentsinc/history-corpus`).
- npm: [@openagentsinc/rlm](https://www.npmjs.com/package/@openagentsinc/rlm)

## @openagentsinc/conformance-kit

This package supplies reusable test laws. The graph-memory suite has six
granular runners: identity and provenance, capabilities and deletion, DSE
extraction, graph RLM projection, ranking, and archive portability. The
`./graph-fixtures` subpath supplies public-safe inputs for these laws. The
package root re-exports all runners.

The runners register tests through the `vite-plus` peer. Use this package as a
development dependency, or install it with the optional
`@openagentsinc/ai/conformance` subpath. A passing law suite proves only the
tested contract. It does not prove retrieval quality, grant host authority,
or authorize a release.

## @openagentsinc/graph-corpus

This package owns the portable derived-graph projection. It keeps mentions,
canonical entities, relations, merge evidence, embedding field descriptors,
and exact source locators in one deterministic snapshot.

- Key exports: `buildGraphCorpus`, `makeGraphMention`,
  `makeCanonicalEntity`, `makeGraphRelation`,
  `makeInMemoryGraphSnapshotHandle`, `makeGraphAdapterCapabilities`,
  `verifyGraphRankingOperationResult`, `makeGraphRankingSnapshot`,
  `rankGraphOperationResult`,
  `validateGraphUsedElementEvidence`, `planGraphSourceDeletion`,
  `makeGraphDeletePreExecutionRefusal`, and `makeGraphDeleteReceipt`.
- Use it to build a ref-only derived graph. It does not call a model, select a
  database, execute a query or delete plan, or grant memory authority.
- Umbrella path: `@openagentsinc/ai/graph` and the `Graph` namespace for the
  stable graph projection.
- Direct contract paths: `@openagentsinc/graph-corpus/capabilities` and
  `@openagentsinc/graph-corpus/deletion`, and
  `@openagentsinc/graph-corpus/ranking`.
- Portable archive paths: `@openagentsinc/graph-corpus/archive` and
  `@openagentsinc/ai/graph/archive`. They export and import canonical, bounded,
  inert graph corpus archive v1 data. This API is on explicit subpaths only.
  It is not on either package root or the `Graph` namespace.

## @openagentsinc/dse

The canonical typed model-program contract. A Program binds one Effect Schema
signature to one immutable candidate artifact. The portable runtime resolves
and predicts from exact bytes. The explicit offline optimizer evaluates bounded
candidate search and produces proposals; it cannot activate them.

- Key exports: `DseSignature`, `Program`, `bindProgram`, `CandidateArtifact`,
  `predict`, `predictReceiptToRuntimeEvents`, `compileSignature`, dataset and
  evaluation schemas, promotion and activation receipts,
  `graphExtractionSignature`, `runGraphExtraction`,
  `runDeterministicGraphExtraction`, and `applyGraphExtractionCandidates`.
- Use the root or `/runtime` for prediction. Import `/optimizer` only in an
  offline compile application. Graph extraction accepts only already-filtered
  corpus entries and returns advisory candidates plus exact-or-unavailable
  usage receipts. Version 1 is serial. Only a validated `Complete` result can
  join trusted source locators and enter graph construction. It does not select
  credentials, persist data, or apply a database operation. Use `/test` for
  deterministic fixtures.
- Umbrella paths: `@openagentsinc/ai/program`, `/program/contract`,
  `/program/runtime`, `/program/optimizer`, and `/program/test`.
- npm: [@openagentsinc/dse](https://www.npmjs.com/package/@openagentsinc/dse)

## @openagentsinc/ai-sdk-sandbox-local

The **L3** local sandbox provider implementation.

- Key exports: `createLocalAiSdkSandboxProvider` and `LocalAiSdkSandboxProvider`.
- Use it to run harness work in isolated local account homes on the developer
  machine. It is not a production sandbox — it adds no kernel, network, or
  multi-tenant containment.
- npm: [@openagentsinc/ai-sdk-sandbox-local](https://www.npmjs.com/package/@openagentsinc/ai-sdk-sandbox-local)

## @openagentsinc/ai-sdk-sandbox-openagents

The **L3** managed sandbox provider implementation.

- Key exports: `createOpenAgentsAiSdkSandboxProvider` and
  `OpenAgentsAiSdkSandboxProvider`.
- Use it to attach harness work to a managed OpenAgents sandbox with the server
  as the authority for filesystem and network policy.
- npm: [@openagentsinc/ai-sdk-sandbox-openagents](https://www.npmjs.com/package/@openagentsinc/ai-sdk-sandbox-openagents)

## Version discipline

The `rc` dist-tag tracks the current pre-stable train. Pre-stable never takes the
stable `latest` badge on purpose. Pin an exact version in a production consumer
and move the pin deliberately.
