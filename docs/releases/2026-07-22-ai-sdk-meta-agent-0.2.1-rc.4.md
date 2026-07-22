# AI SDK meta-agent release receipt

Date: 2026-07-22. Train: `0.2.1-rc.4`. Dist-tag: `rc`.

## What moved

The release makes the meta-agent primitives from ai#39 consumable off the
registry. `@openagentsinc/agent-harness-contract` now publishes two members
that landed on ai `main` at `490053d` but were not yet on a published train:

- `metaAgentHarness` (`meta-agent-harness.ts`): an `AgentHarness` that wraps a
  FLEET of member harnesses behind the exact same contract every single-runtime
  adapter satisfies — one session-global contiguous `HarnessStreamEvent`
  cursor, per-turn routing to one member, member events re-framed onto the meta
  sequence space WITHOUT laundering (each keeps its own `source` and gains a
  `cause.member.<id>.<memberEventId>` ref, bracketed by
  `agent.child.started` / `agent.child.finished`), honest capability
  intersection/delegation, and cursor-exact suspend/continue across member
  boundaries (honestly `lossy: true` when a member re-drives).
- The ACP agent SERVER helper (`acp-server.ts`): `makeAcpAgentServerConnection`,
  `AcpAgentServerConnection`, `AcpAgentServerOptions`,
  `AcpServerPermissionRequest`, `ACP_SERVER_PROTOCOL_VERSION`,
  `finishReasonToStopReason`. This is the inversion of `acp-adapter.ts`: it
  exposes ANY `AgentHarness` (including `metaAgentHarness`) AS an ACP agent, so
  an external ACP host (Zed, our own ACP client adapter) can drive it over
  `initialize` / `session/new` / `session/prompt` / `session/cancel`, projecting
  harness stream events onto `session/update` notifications and mapping an
  `operator_escalation_required` tool call onto the canonical
  `tool_approval` `RuntimeInteraction` — fail-closed, deny-by-default, over
  `session/request_permission`.

The in-repo ACP client adapter is the conformance oracle for the server: drive
the server with `makeAcpHarnessAdapter` over an in-memory loopback and the
composed harness passes the same contiguous-stream, suspend/continue, and
permission laws as every other adapter (`acp-server.test.ts`).

## Source and gates

The release source commit is `490053d` (`metaAgentHarness` conformer + ACP
agent server helper, ai#39), with the roster converged to `0.2.1-rc.4` by
`scripts/set-train-version.ts`. The full repository check passed at that state:
format, lint, type checks for all 11 packages, the full test suite (759 harness
tests green), export-map, and public API-surface checks. The API-surface
baseline was regenerated to `docs/api-surface/0.2.1-rc.4.json`; the two changed
surfaces (`@openagentsinc/agent-harness-contract` and the `@openagentsinc/ai`
umbrella gaining the meta-agent + ACP server exports) are recorded there.

## Published artifacts

All 11 roster packages published at `0.2.1-rc.4` under dist-tag `rc`, leaf and
runtime packages before the umbrella `@openagentsinc/ai`. `latest` was not
touched and stays `0.1.1-rc.1`. Registry `rc` dist-tags for every roster
package now point at `0.2.1-rc.4`.

## Publication proof

`npm view @openagentsinc/agent-harness-contract dist-tags` returns
`{ latest: '0.1.1-rc.1', rc: '0.2.1-rc.4' }` and
`@openagentsinc/ai` matches. The published
`@openagentsinc/agent-harness-contract@0.2.1-rc.4` registry tarball was fetched
and confirmed to carry `src/meta-agent-harness.ts` (exporting
`metaAgentHarness`) and `src/acp-server.ts`, both re-exported from
`src/index.ts`.

This receipt proves package publication and exact-version availability of the
meta-agent + ACP server primitives. It does not by itself prove OpenAgents
Desktop adoption — the loopback ACP server that consumes them is
openagents#9181 (META-2).
