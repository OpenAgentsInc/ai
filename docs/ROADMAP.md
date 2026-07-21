# @openagentsinc/ai — Proposed Roadmap

Date: 2026-07-21. Status: proposed. This roadmap sequences the SDK's own
engine work. Consumption sequencing for the OpenAgents product lives in the
monorepo (`openagents/docs/desktop/2026-07-21-chat-runtime-unified-roadmap.md`
and the division-of-labor audit in `openagents/docs/fable/`). The two must
not drift — engine issues are filed HERE, consumption issues stay in the
monorepo.

## Where the SDK is today

Extracted 2026-07-21 from the openagents monorepo. Apache-2.0. Published rc
trains through `0.2.0-rc.1`. The monorepo consumes the train from npm and
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

## Phase 2 — Programs (the DSPy of Effect)

The largest differentiator no upstream ships. Typed prompt-programs over
this substrate:

- **Signatures are Effect Schemas.** A program declares its input and
  output schemas. Decode is the only validity authority — the
  partial-object stream is progress affordance, never a validated value.
- **Modules are typed programs over `LanguageModel`.** Compose with
  ordinary Effect. Program runs emit `KhalaRuntimeEvent` streams, so every
  run is durable, cursor-exact, replayable, and renderable through the
  existing UI stream.
- **Optimizers are bounded loops with the RLM honesty contract.** A
  GEPA-style reflective/evolutionary search over prompt text and program
  structure, Pareto-scored by eval contracts, with caps (iterations,
  tokens, budget) and honest `Partial` outcomes. No optimizer ever edits a
  program silently — proposals are typed diffs a caller admits.
- **Eval contracts.** Typed datasets + scorers as first-class schemas, so
  optimizer claims cite the eval they moved, and the RLM-07-style honesty
  gate generalizes to any program.

## Phase 3 — RLM deepening

1. Multi-corpus recall — thread sets, repositories, evidence packs — with
   corpus composition laws and per-corpus redaction policy.
2. Tier D indexing for large corpora (the deterministic tier stays fast as
   corpora reach repo scale).
3. The dense-recall evaluation harness as a public conformance suite
   (monorepo RLM-07 produces the first evidence; the harness itself lives
   here).
4. A trained-orchestrator admission path, gated strictly on that evidence.

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

## Phase 5 — Harness breadth

1. More adapters behind `AgentHarness`: the ACP factory generalizes —
   candidates include additional ACP peers and non-ACP runtimes that fit
   the session verbs.
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

## Issue conventions

Engine work is filed on this repository (the SDK-RLM-01..08 pattern).
Consumption work stays on `OpenAgentsInc/openagents`. Cross-cutting
programs keep a monorepo epic with SDK children linked. Each phase above
becomes its own epic when admitted — this roadmap proposes, it does not
dispatch.
