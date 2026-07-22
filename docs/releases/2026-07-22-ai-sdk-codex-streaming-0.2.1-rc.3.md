# AI SDK codex-streaming release receipt

Date: 2026-07-22. Train: `0.2.1-rc.3`. Dist-tag: `rc`.

## What moved

The release adds the live-streaming app-server transport seam to the Codex
harness adapter (`@openagentsinc/agent-harness-contract`,
openagents#9167 / HARN-09):

- `CodexAppServerTransport.runTurnStreaming` (optional): a `Stream`-based seam
  that emits each `CodexEvent` the instant the app-server produces it and
  completes when the turn settles. When a transport provides it,
  `makeCodexHarnessAdapter` (app-server mode) projects onto the neutral
  `HarnessStreamEvent` stream AS EACH EVENT ARRIVES — mirroring the claude
  adapter's `Stream.fromAsyncIterable` drive — so text/reasoning deltas and
  tool rows reach a consumer live instead of only after the whole turn settles
  through the batch `runTurn`.
- Back-compat: the seam is optional. The batch `runTurn` and the `exec` mode
  are unchanged; a transport that omits `runTurnStreaming` behaves exactly as
  before.
- Cursor exactness: the fully-consumed ordered event set is identical to the
  batch path. A mid-turn suspend over a live turn is honestly `lossy: true`
  (no already-computed tail to replay).
- Fixtures gained a `streaming` mode; the adapter test suite proves events
  arrive INCREMENTALLY (a neutral event is received before the last wire event
  is produced), settle-parity with the batch path, honest-lossy streaming
  suspend, typed live-failure propagation, and native approvals over the live
  transport.

## Source and gates

The release source commit is
`72ca3b3b1896d0193d74f69e0c51069edcbfc2d5`. The full repository check passed at
that commit: format, lint, type checks for all 11 packages, the full test
suite (293 harness-contract tests passed, 5 new), export-map, and public
API-surface checks. The API-surface baseline was regenerated to
`docs/api-surface/0.2.1-rc.3.json`; the one changed surface
(`CodexAppServerTransport` gaining the optional streaming method) is captured
there.

## Published artifacts

All 11 roster packages published at `0.2.1-rc.3` under dist-tag `rc`, leaf and
runtime packages before the umbrella `@openagentsinc/ai`. `latest` was not
touched and stays `0.1.1-rc.1`. Registry `rc` dist-tags for every roster
package now point at `0.2.1-rc.3`.

## External install proof

A new temporary npm project installed `@openagentsinc/agent-harness-contract`,
`@openagentsinc/agent-runtime-schema`, and `@openagentsinc/ai` at exact
`0.2.1-rc.3` from the public registry and confirmed the published
`agent-harness-contract` source exports the `runTurnStreaming` seam.

This receipt proves package publication and exact-version installation. It does
not prove OpenAgents product adoption of the live app-server path (the desktop
wiring residual is tracked in openagents#9167).
