# `@openagentsinc/rlm`

First-class Effect-native Recursive Language Model engine for the OpenAgents
AI SDK.

## What this is

- **Generic L6 engine** — not history-specific. History is an adapter in
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
# or via umbrella:
npm install @openagentsinc/ai@rc
```

```ts
import { Rlm, rlmDeterministicLayer } from "@openagentsinc/rlm";
// or:
import { Rlm } from "@openagentsinc/ai/rlm";
```

## Safety

No Python, REPL, `eval`, shell, or arbitrary model-authored code. Operators
are trusted pure functions registered at Layer construction. Results are
cited candidates, never authority.

See `docs/rlm/` in this repository for the normative specification.
