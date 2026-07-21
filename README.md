# @openagentsinc/ai

The Effect-native OpenAgents AI SDK — an Effect toolkit for building agent
applications with durable, cursor-exact streams. One neutral event union from
the model call to the rendered message, suspend and continue that persists,
coding-agent harnesses, redaction as a schema field, and recall instead of
compaction.

## Layers

```
L6  RECALL        @openagentsinc/history-corpus
L5  UI STREAM     agent-harness-contract: ui-message-chunk, reducer,
                  smooth-stream, partial-object-stream
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

## Development

Node 24, pnpm, Vite Plus — the same toolchain contract as the
[openagents](https://github.com/OpenAgentsInc/openagents) monorepo this SDK
was extracted from (2026-07-21).

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm check
```

## License

Apache-2.0
