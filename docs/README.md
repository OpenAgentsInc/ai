# The OpenAgents AI SDK

**The product sentence.** The OpenAgents AI SDK is an Effect-native toolkit
for building agent applications with durable, cursor-exact streams — one
neutral event union from the model call to the rendered message, with
suspend and continue that persists, coding-agent harnesses, redaction as a
schema field, and recall instead of compaction.

**Status.** This repository is the extracted public home of the SDK
(`OpenAgentsInc/ai`, Apache-2.0). Packages publish under the `@openagentsinc/`
npm scope with pre-stable dist-tag `rc` only. The OpenAgents monorepo
consumes these packages from npm (see issue #2). The reserved shell
`OpenAgentsInc/openagents-ai` remains a placeholder name reservation.

**This is the layer index and the single source of truth.** The engine, the
layer diagram, and the per-package export map are authored here. The monorepo
copy under
[`openagents/docs/ai-sdk/`](https://github.com/OpenAgentsInc/openagents/blob/main/docs/ai-sdk/README.md)
(live at [openagents.com/aisdk](https://openagents.com/aisdk)) mirrors this
index for consumers and must not drift. Companion pages:
[Getting started](./getting-started.md) and [Packages](./packages.md).

## Layer diagram

```
L6  RECALL        @openagentsinc/history-corpus
L5  UI STREAM     agent-harness-contract: ui-message-chunk, reducer,
                  smooth-stream, partial-object-stream, ChatTransport
L4  HARNESS       agent-harness-contract: session verbs, slice runner,
                  readiness, toolkit bridge, ACP + opencode adapters
L3  SANDBOX       sandbox-provider contract + local + interop providers
L2  DURABLE LOG   event-log: seq-cursor append, replay, attach, rerun
L1  VOCABULARY    @openagentsinc/agent-runtime-schema (KhalaRuntimeEvent)
L0  MODEL CALL    effect/unstable/ai (upstream) + @openagentsinc/ai-model
P   PROGRAMS      @openagentsinc/dse (typed signatures, immutable artifacts,
                  portable runtime; explicit offline optimizer)
G   GRAPH         @openagentsinc/graph-corpus (derived RLM/DSE projection;
                  graph truth does not add a runtime event layer)
X   CONFORMANCE   @openagentsinc/conformance-kit (cross-cutting test laws)
```

**The one rule.** Every layer speaks `KhalaRuntimeEvent` upward. One event
union. One durable cursor.

## Roster

| Package                                    | Layer                               |
| ------------------------------------------ | ----------------------------------- |
| `@openagentsinc/ai`                        | umbrella — curated re-exports       |
| `@openagentsinc/agent-runtime-schema`      | L1 vocabulary                       |
| `@openagentsinc/agent-harness-contract`    | L2–L5 core (includes ChatTransport) |
| `@openagentsinc/ai-model`                  | L0 model-call bridge                |
| `@openagentsinc/history-corpus`            | L6 recall (history adapter)         |
| `@openagentsinc/rlm`                       | L6 recursive engine (Tier D + S)    |
| `@openagentsinc/dse`                       | typed model programs                |
| `@openagentsinc/graph-corpus`              | derived graph projection            |
| `@openagentsinc/conformance-kit`           | cross-cutting test laws             |
| `@openagentsinc/ai-sdk-sandbox-local`      | L3 interop                          |
| `@openagentsinc/ai-sdk-sandbox-openagents` | L3 interop                          |

**Not in this repo (monorepo-only):** desktop wiring, Full Auto authority,
`khala-tools`, `harness-conformance`, account custody, settlement surfaces.

## Install (rc)

```sh
npm install @openagentsinc/ai@rc
# or pin a version:
npm install @openagentsinc/agent-harness-contract@0.2.1-rc.2
```

Pre-stable releases never take the `latest` dist-tag.

## Development

Node 24, pnpm, Vite Plus. Local gates only — **no GitHub Actions**.

```sh
pnpm install
pnpm run check          # fmt + lint + typecheck + test
git config core.hooksPath .githooks   # enable pre-push gate
```

## Related

- First-class Recursive Language Model specification:
  [`rlm/README.md`](rlm/README.md)
- DSE normative contract and public API:
  [`dse/README.md`](dse/README.md)
- Monorepo consumer: https://github.com/OpenAgentsInc/openagents
- Monorepo pointer doc (after swap): `docs/ai-sdk/README.md` in openagents
- npm scope: `@openagentsinc/*`
