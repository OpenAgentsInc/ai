# @openagentsinc/ai

The Effect-native OpenAgents AI SDK — an Effect toolkit for building agent
applications with durable, cursor-exact streams. One neutral event union from
the model call to the rendered message, suspend and continue that persists,
coding-agent harnesses, redaction as a schema field, and recall instead of
compaction.

**License:** Apache-2.0  
**Registry:** npm scope `@openagentsinc/*` (pre-stable under dist-tag `rc` only)  
**Gates:** local only — no GitHub Actions (`pnpm run check`, `.githooks/pre-push`)

## Layers

```
L6  RECALL        @openagentsinc/history-corpus
L5  UI STREAM     agent-harness-contract: ui-message-chunk, reducer,
                  smooth-stream, partial-object-stream, ChatTransport
L4  HARNESS       agent-harness-contract: AgentHarness, session verbs,
                  slice runner, readiness, toolkit bridge, ACP + opencode
L3  SANDBOX       sandbox-provider contract + local + interop providers
L2  DURABLE LOG   event-log: seq-cursor append, replay, attach, rerun
L1  VOCABULARY    @openagentsinc/agent-runtime-schema (KhalaRuntimeEvent)
L0  MODEL CALL    effect/unstable/ai (upstream) + @openagentsinc/ai-model
```

Every layer speaks `KhalaRuntimeEvent` upward. One event union. One durable
cursor.

## Packages

| Package                                    | Layer                         |
| ------------------------------------------ | ----------------------------- |
| `@openagentsinc/ai`                        | umbrella — curated re-exports |
| `@openagentsinc/agent-runtime-schema`      | L1 vocabulary                 |
| `@openagentsinc/agent-harness-contract`    | L2–L5 core                    |
| `@openagentsinc/ai-model`                  | L0 model-call bridge          |
| `@openagentsinc/history-corpus`            | L6 recall                     |
| `@openagentsinc/ai-sdk-sandbox-local`      | L3 interop                    |
| `@openagentsinc/ai-sdk-sandbox-openagents` | L3 interop                    |

## Supported harnesses

Every harness implements the one L4 [`AgentHarness`](packages/agent-harness-contract/src/adapter.ts)
contract and emits `KhalaRuntimeEvent` upward:

| Harness        | Factory                        | Adapter source                                                                         |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| Claude Code    | `makeClaudeCodeHarnessAdapter` | [`claude-code-adapter.ts`](packages/agent-harness-contract/src/claude-code-adapter.ts) |
| Codex          | `makeCodexHarnessAdapter`      | [`codex-adapter.ts`](packages/agent-harness-contract/src/codex-adapter.ts)             |
| OpenCode       | `makeOpencodeAdapter`          | [`opencode-adapter.ts`](packages/agent-harness-contract/src/opencode-adapter.ts)       |
| Pi             | `makePiHarnessAdapter`         | [`pi-adapter.ts`](packages/agent-harness-contract/src/pi-adapter.ts)                   |
| Goose          | `makeGooseHarnessAdapter`      | [`goose-adapter.ts`](packages/agent-harness-contract/src/goose-adapter.ts)             |
| Cursor (ACP)   | `makeCursorHarnessAdapter`     | [`cursor-adapter.ts`](packages/agent-harness-contract/src/cursor-adapter.ts)           |
| Grok CLI (ACP) | `makeAcpHarnessAdapter`        | [`acp-adapter.ts`](packages/agent-harness-contract/src/acp-adapter.ts)                 |

The generic [ACP adapter](packages/agent-harness-contract/src/acp-adapter.ts)
serves any Agent Client Protocol peer; Grok CLI (`grok_acp`) uses it directly
and the Cursor adapter (`cursor_acp`) builds on it.

## Train policy

The roster ships as one **train**: every publishable package carries the same
`version`, and every inter-package dependency inside the workspace points at
that one train through `workspace:*` (rewritten to the concrete version at pack
time). Converge the whole roster to one train in a single command:

```sh
node scripts/set-train-version.ts 0.2.0-rc.2         # bump every package + fix inter-package ranges
node scripts/set-train-version.ts 0.2.0-rc.2 --check # verify convergence, no writes
pnpm run audit:surface:update                        # record the new train's API-surface baseline
```

Pre-stable trains publish under dist-tag **`rc` only** — never `latest`.
Publish leaf packages first and the `@openagentsinc/ai` umbrella last, all at
the one converged version.

## Roadmap

The proposed engine roadmap is [`docs/ROADMAP.md`](./docs/ROADMAP.md) —
conformance-as-product, Programs (the DSPy of Effect), RLM deepening,
generative UI, transport productization, provider gateway, harness breadth.

## Development

Node 24, pnpm, Vite Plus — the same toolchain contract as the openagents monorepo.

```sh
pnpm install
pnpm run check
pnpm run hooks:install   # enables .githooks/pre-push on this clone
```

Docs index: [`docs/README.md`](docs/README.md).

## Install (consumers)

```sh
npm install @openagentsinc/ai@rc
```
