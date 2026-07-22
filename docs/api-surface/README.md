# API-surface baselines (breaking-change gate)

This directory holds the committed public export-surface snapshots for the
`@openagentsinc/ai` roster, one file per **train** (the shared roster version):
`docs/api-surface/<train>.json`. The current baseline is
[`0.2.1-rc.2.json`](./0.2.1-rc.2.json). It includes the graph-memory laws and
the new umbrella subpaths.

The gate (P1-2, issue #16) is the automated version of the AISDK-02
collision audit: it enumerates every package's exported symbols through the
TypeScript compiler API and records, per export-map entry point, each exported
name with a `kind` and a hash of its resolved type signature.

## Snapshot format

```jsonc
{
  "train": "0.2.0-rc.1",
  "extractorSchema": "openagents.ai.public_export_surface.v2",
  "packages": {
    "@openagentsinc/agent-runtime-schema": {
      "version": "0.2.0-rc.1",
      "entrypoints": {
        ".": {
          "source": "./src/index.ts",
          "exports": {
            "AgentDefinition": { "kind": "value", "sig": "<16-hex hash>" },
          },
        },
      },
    },
  },
}
```

Extractor schema v2 measures each entry point in an independent TypeScript
program. It also replaces checkout-local compiler paths with logical paths.
Thus, a new entry point or a different worktree cannot change an unrelated
signature hash. The `0.2.1-rc.2` snapshot is the intentional v1-to-v2 hash
migration. The published v1 snapshots through `0.2.0-rc.7` remain unchanged.

## Commands

- `pnpm run audit:surface` — check the current surface against the latest
  committed baseline. Runs inside `pnpm run check`.
- `pnpm run audit:surface:update` — regenerate the snapshot for the current
  train.

## How the gate decides

For each package, the current surface is diffed against the baseline:

- **Removed / renamed export**, or a **changed signature** — breaking.
- **New export name or new entry point** — additive.

Verdict per package:

| Diff                 | Version vs. baseline        | Result   |
| -------------------- | --------------------------- | -------- |
| none / additive only | any                         | pass     |
| breaking             | current > baseline (bumped) | pass     |
| breaking             | current == baseline         | **fail** |

So an additive change ships freely, but a removal or a signature change fails
the check until the owning package's version is bumped past the baseline train.
On an intentional break: bump the roster version, then run
`pnpm run audit:surface:update` to record the new train as the next baseline.
