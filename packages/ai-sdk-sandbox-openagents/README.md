# @openagentsinc/ai-sdk-sandbox-openagents

> **Layer L3 — sandbox** · part of the [OpenAgents AI SDK](../../docs/README.md)

A managed sandbox provider that adapts the OpenAgents sandbox/workroom contract
to the AI SDK harness provider surface. It is intentionally thin: lifecycle,
files, process execution, port ingress, and egress policy are delegated to an
`openagents.sandbox.v1` client. The managed OpenAgents sandbox remains the
authority for public and untrusted filesystem and network restrictions.

The adapter adds the harness provider surface, snapshot identity, explicit agent
account homes, and restricted tool views. For an owner-local, non-production
alternative, see `@openagentsinc/ai-sdk-sandbox-local`.

## Install

```sh
npm install @openagentsinc/ai-sdk-sandbox-openagents@rc
```

## Primary API

- `createOpenAgentsAiSdkSandboxProvider(options)` — builds the provider (returns
  a `HarnessV1SandboxProvider`). The options carry the `openagents.sandbox.v1`
  client, the lane, and account homes.
- `OpenAgentsAiSdkSandboxProvider` — the provider class.

```ts
import { createOpenAgentsAiSdkSandboxProvider } from "@openagentsinc/ai-sdk-sandbox-openagents";

// `client` implements the openagents.sandbox.v1 contract; the server stays the
// authority for filesystem and network policy.
const provider = createOpenAgentsAiSdkSandboxProvider({ client });
```

## More

- [Layer index](../../docs/README.md) · [Packages](../../docs/packages.md) ·
  [Getting started](../../docs/getting-started.md)
