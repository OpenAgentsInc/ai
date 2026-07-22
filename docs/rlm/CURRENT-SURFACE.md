# Current surface and implementation gap

**Train:** workspace `0.2.0-rc.4`

## Current workspace surface

### `@openagentsinc/rlm` (generic engine)

- Canonical schemas: corpus identity with content/manifest digests, budgets,
  programs, requests/results, events, errors.
- Inline corpus handles with hard byte ceiling and citation validation.
- Corpus v2 source planes, policy facts, exact source locators, and explicit v1
  migration.
- Deterministic multi-corpus composition with stale-child and policy checks.
- Bounded engine and citation paths that do not require full materialization.
- Shared deterministic interpreter (Grep, OrdinalSlice, InspectMetadata).
- Run-scoped symbolic `RlmEnvironment` (opaque values, digests, byte caps).
- Declarative program DAG with `CorpusOp`, `Partition`, `Transform`,
  `ModelMap`, `RlmMap`, `ModelReduce`, `Commit`.
- Paper-fidelity: one root program can launch N `ModelMap` leaf calls without
  intervening root decisions; concurrency 1 and >1 digest-identical.
- `Rlm` Effect service with `stream` + `run`; deterministic Layer refuses semantic.
- Tool authoring helper `makeRlmToolHandler`.
- Hermetic paper-fidelity + digest tests (no network).

### Umbrella / history

- `@openagentsinc/ai/rlm` re-exports the generic package.
- `@openagentsinc/history-corpus/rlm` history adapter re-export + compatibility
  history surfaces.

### Still host-owned / follow-on

- Durable application `RlmCorpusSource` adapters for repositories and evidence
  stores.
- Live Effect AI `generateObject` root/leaf Layers (scripted models ship).
- Artifact sink for oversized output (honest partial ships without sink).
- Dense OOLONG evaluation harness against live providers (contracts only).
- OpenAgents monorepo pin bump to `0.2.0-rc.1` (separate consumer issue).

See PAPER-AUDIT.md for the fidelity matrix.
