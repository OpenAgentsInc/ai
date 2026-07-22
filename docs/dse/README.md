# DSE — Declarative Self-Improving Effect

**Status:** introductory orientation for DSE, the compile-side companion to
the OpenAgents AI SDK runtime layers. The implementation currently lives in
the OpenAgents monorepo as `@openagentsinc/dse`
([`packages/dse`](https://github.com/OpenAgentsInc/openagents/tree/main/packages/dse),
AFS-08 lineage). This folder is the SDK-side home for its concepts and its
eventual public contract; any package move follows the same extraction
discipline as the rest of the SDK.

**Date:** 2026-07-21
**Implementation home:** `OpenAgentsInc/openagents` (`packages/dse`)
**First consumer:** the Apple FM prompt and policy path in OpenAgents
Desktop (AFS-09)

## What DSE is

DSE is the DSPy idea rebuilt on Effect v4: a compiler for model programs.
It turns a hand-written prompt into a typed, evaluated, versioned, and
immutable artifact — with the same discipline the rest of this SDK applies
to streams and sessions applied to the prompts themselves. The name and
lineage come from the original DSPy-in-Effect program that ran in the
OpenAgents codebase before the 2026-02 prune; the current package is its
Effect v4 successor, rebuilt for the Apple FM compile path.

The core pieces:

1. **Signatures.** `DseSignature<I, O>` binds an Effect Schema input and
   output to a default Prompt IR. The contract export is derived
   deterministically, so a signature is a stable, serializable interface —
   not a string template.
2. **Predict.** `predict` renders the compiled program, calls the model
   through an injected model port, decodes the result with the output
   schema, runs one bounded repair on a first decode failure, and writes an
   append-only predict receipt.
3. **Datasets.** Immutable, content-addressed revisions with fail-closed
   splits: a missing holdout fails, and train can never become holdout by
   omission.
4. **Metrics.** A `Metric` scores one example; `rewardBundle` combines
   quality and resource components with correctness taking precedence over
   resource savings.
5. **Optimizer.** A deterministic, deduplicated, capped candidate search
   (instruction grid, greedy few-shot pool, joint search, knob grids).
   `compileSignature` scores candidates on validation and selects a winner
   against the held-out split.
6. **Release and activation.** Compilation produces a released, immutable
   artifact behind a pointer, with gated activation states — shadow,
   canary, active, rolled-back — that a runtime host enacts, plus rollback
   and promotion receipts.

DSE is offline and portable by construction. The optimizer imports no
provider SDK, no host runtime, and opens no network connection. A runtime
resolves a released artifact from its bytes and serves the compiled prompt
only after an explicit promotion. The subpath split enforces the boundary:
`/contract` (schemas), `/runtime` (resolve, verify, predict — no compile
authority), `/optimizer` (compile only — never imported by a runtime
application).

## Why it matters

Every agent framework treats prompts as configuration: strings edited by
hand, deployed by copy, evaluated by vibes, and rolled back by git
archaeology. DSE makes them artifacts. A prompt change becomes: edit the
signature or search space, compile against a pinned dataset revision,
compare metric reports on a holdout that cannot leak, release a new
immutable artifact, activate it behind a gate, and keep the receipts.

For the SDK thesis this closes the loop. The harness layer runs agent
programs with durable, cursor-exact streams. RLM recalls cited evidence
from what those programs did. DSE compiles and releases the programs
themselves — so improvement over time is a governed, receipted process
instead of prompt drift. Together they turn "the agent got better" from an
anecdote into a diff between two evaluated artifacts.

This is also the seam where evaluation signals become optimization
pressure: any metric a consumer can score per example — task success,
schema-decode rate, resource cost, or conversation-quality measures like
the OpenAgents coherence screening — can drive the search, provided it is
computed offline against a dataset revision.

## Where it sits relative to the layers

DSE is not a new runtime layer. It is the offline compile side that feeds
the model-call layer:

```
offline:  signature + dataset revision + metrics
             └── /optimizer: candidate search → evaluation → winner
                    └── released artifact (immutable, pointer + receipts)
runtime:  /runtime: resolve + verify artifact from bytes
             └── predict → model port (L0) → typed decode → receipt
```

The runtime side speaks the SDK's existing vocabulary: model calls go
through the injected port, results decode through Effect Schema, and
receipts are append-only records a host can project.

## Boundaries

A compiled artifact is evidence of evaluation, not authority. Promotion to
`active` is a host decision enacted through the gated-activation states; the
optimizer cannot activate its own output. DSE does not dispatch providers,
select credentials, widen a corpus policy, or bypass a consumer's release
gates. Correctness metrics outrank resource savings in every reward bundle,
and holdout splits fail closed so an optimizer can never grade itself on its
own training data.

## Current surface and roadmap

Shipped today (monorepo `@openagentsinc/dse`): signatures, predict with
receipts, dataset revisions and splits, metrics and reward bundles, the
deterministic candidate search with a default cap of 128, compile and
release records, and the portable gated-activation state. MIPRO, GEPA,
COPRO, Pareto search, and a generic module graph are explicitly out of
scope for the current surface.

The first production consumer is the Apple FM prompt path in OpenAgents
Desktop: checked-in compiled artifacts, offline resolution, and serving
only after explicit promotion (AFS-09).

SDK-side next steps, in order: a public contract page in this folder
mirroring the RLM `SPEC.md`/`PUBLIC-API.md` pattern; an adapter showing a
harness host tool compiled through a `DseSignature`; and an extraction
decision for the package itself once the public contract is stable enough
to pin.
