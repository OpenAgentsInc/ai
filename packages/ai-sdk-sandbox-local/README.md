# @openagentsinc/ai-sdk-sandbox-local

> **Layer L3 — sandbox** · part of the [OpenAgents AI SDK](../../docs/README.md)

An owner-local sandbox provider for AI SDK harness fixtures. It creates a
temporary workspace, scopes the file APIs to that workspace, launches child
processes with explicit `HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`, and
exposes localhost port URLs for bridge experiments.

It is intentionally **not** a production sandbox: no kernel, network, or
multi-tenant containment. Use it to prove a coding-agent harness runs without
Vercel before the same provider contract is backed by the managed OpenAgents
sandbox/workroom runtime (`@openagentsinc/ai-sdk-sandbox-openagents`).

## Install

```sh
npm install @openagentsinc/ai-sdk-sandbox-local@rc
```

## Primary API

- `createLocalAiSdkSandboxProvider(options?)` — builds the provider (returns a
  `HarnessV1SandboxProvider`).
- `LocalAiSdkSandboxProvider` — the provider class.
- Options include per-account homes and `inheritClaudeConfig: true`, which
  reuses the host Claude Code CLI login instead of an isolated config path.

```ts
import { createLocalAiSdkSandboxProvider } from "@openagentsinc/ai-sdk-sandbox-local";

// An owner-local provider that isolates each session under a temp workspace.
const provider = createLocalAiSdkSandboxProvider({
  inheritClaudeConfig: true,
});
```

## More

- [Layer index](../../docs/README.md) · [Packages](../../docs/packages.md) ·
  [Getting started](../../docs/getting-started.md)
