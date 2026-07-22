# @openagentsinc/rlm

> **Layer L6 — recursive engine** · part of the [OpenAgents AI SDK](../../docs/README.md)

The first-class Effect-native Recursive Language Model engine for the OpenAgents
AI SDK. It runs typed recall programs over a corpus source — deterministically
first (Tier D) and recursively second (Tier S).

- **Generic L6 engine** — not history-specific. History is one adapter in
  `@openagentsinc/history-corpus`.
- **Tier D** — zero-model-call deterministic traversal over a corpus handle.
- **Tier S** — budgeted semantic recursion with a scoped symbolic environment
  and Schema-decoded declarative programs.
- **Paper-faithful** — one root program can partition and `ModelMap`/`RlmMap`
  over a collection without one root turn per child; intermediate values stay
  opaque outside the root transcript; commit is by value ref (inline or
  artifact).

## Install

```sh
npm install @openagentsinc/rlm@rc
# or via the umbrella:
npm install @openagentsinc/ai@rc   # re-exported at @openagentsinc/ai/rlm
```

## Primary API

- `runRlm(request)` — runs one RLM request (`Deterministic` or a semantic Tier S
  program) and returns `Completed`, `Partial` (with an honest reason), or
  `Failed` (with a typed failure class).
- `streamRlm(request)` — the streaming form.
- `rlmDeterministicLayer` — the Tier D layer (never touches a model).
- `rlmLayer(options)` / `makeRlm(options)` — the semantic-capable layer/service,
  built with an injected root `model`.
- `RlmCorpusSource` — the service the host application implements to supply a
  corpus; `rlmInlineCorpusSourceLayer` + `buildInlineCorpusInput` serve an inline
  corpus for tests and small cases.
- `makeCompositeCorpusHandle` — combines authorized child handles. It preserves
  child identities, source planes, policies, and exclusions.
- `migrateRlmCorpusV1` — requires the caller to supply a source plane and an
  authorized policy before it creates v2 bytes.

```ts
import { Effect } from "effect";
import {
  buildInlineCorpusInput,
  rlmDeterministicLayer,
  rlmInlineCorpusSourceLayer,
  runRlm,
} from "@openagentsinc/rlm";

const corpus = buildInlineCorpusInput({
  corpusRef: "corpus.readme",
  scopeRef: "scope.readme",
  entries: [
    {
      scopeRef: "scope.readme",
      sourcePlane: "evidence_pack",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a0" },
      text: "alpha fact one",
      visibility: "public",
      redactionClass: "none",
    },
  ],
});

const result = await Effect.runPromise(
  runRlm({
    _tag: "Deterministic",
    schemaId: "openagents.ai.rlm_request.v1",
    runRef: "run.readme",
    corpus,
    operation: { _tag: "Grep", pattern: "alpha" },
    limits: {
      maxEntriesScanned: 100,
      maxSpans: 10,
      maxCharsPerSpan: 200,
      maxObservationChars: 2000,
    },
  }).pipe(Effect.provide(rlmDeterministicLayer), Effect.provide(rlmInlineCorpusSourceLayer)),
);

console.log(result._tag); // 'Completed'
if (result._tag === "Completed") console.log(result.usage.modelCalls); // 0
```

## Safety

No Python, REPL, `eval`, shell, or arbitrary model-authored code. Operators are
trusted pure functions registered at Layer construction. Results are cited
candidates, never authority.

The v2 corpus contract separates `sourcePlane` from adapter-specific
`sourceKind`. A manifest records the admitted policy. A composite policy can
be narrower than a child policy. It cannot be wider. Composite construction
rejects duplicate source addresses and stale child identities. Engine scans
and citation checks use bounded handle operations. They do not require full
corpus materialization.

See [the v1 migration note](../../docs/rlm/CORPUS-V2-MIGRATION.md) before you
upgrade stored corpus bytes.

See [`docs/rlm/`](../../docs/rlm) for the normative specification.

## More

- [Layer index](../../docs/README.md) · [Packages](../../docs/packages.md) ·
  [Getting started](../../docs/getting-started.md)
