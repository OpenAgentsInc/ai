# @openagentsinc/ai-model

> **Layer L0 — model call** · part of the [OpenAgents AI SDK](../../docs/README.md)

The L0 model-call substrate. It keeps `effect/unstable/ai` (and the AI SDK Core
`streamText` transport) as provider-call transport only: it makes the call, maps
provider stream parts into the neutral `openagents.khala_runtime_event.v1`
vocabulary, and runs typed provider-fallback plans that never launder an
exhausted account. Upstream is consumed, never forked — AI SDK stream parts are
not the product transcript schema.

Every layer above speaks `KhalaRuntimeEvent` upward. This package is the one
place where a provider call becomes that vocabulary.

## Install

```sh
npm install @openagentsinc/ai-model@rc
# or via the umbrella:
npm install @openagentsinc/ai@rc   # re-exported at @openagentsinc/ai/model
```

## Primary API

- `khalaEffectAiLanguageModelLayer` — supplies the Effect AI `LanguageModel`
  service over an injectable `streamText`-compatible transport.
- `runKhalaEffectAiCoreRuntime` — runs one `LanguageModel.streamText` turn and
  collects it into `KhalaRuntimeEvent` values.
- `khalaAiSdkTextStreamPartFromEffectAiStreamPart` — maps one Effect AI
  `Response.StreamPart` to the ingestion vocabulary.
- `normalizeAiSdkTextStreamPart` — normalizes an unknown provider stream part
  into the typed ingestion vocabulary (unknown shapes fall back to `raw`).
- `buildKhalaAiSdkCoreStreamTextOptions`, `lowerKhalaAiSdkProviderOptions` —
  lower typed provider options for the transport call.

```ts
import { normalizeAiSdkTextStreamPart } from "@openagentsinc/ai-model";

// A raw provider stream part is normalized before it can become a runtime
// event — the projection is the only bridge, so no raw chunk leaks upward.
const part = normalizeAiSdkTextStreamPart({
  type: "text-delta",
  id: "text-1",
  delta: "Hello",
});
console.log(part.type); // 'text-delta'
```

A model-call failure on the Effect AI path is a typed `AiError`. The map from
`AiError` reasons to harness failure classes lives in
`@openagentsinc/harness-conformance` (monorepo).

## More

- [Layer index](../../docs/README.md) · [Packages](../../docs/packages.md) ·
  [Getting started](../../docs/getting-started.md)
