import { Deferred, Effect, Stream } from "effect";
import {
  decodeKhalaRuntimeEvent,
  KhalaRuntimeEventSchemaLiteral,
  type KhalaRuntimeSource,
} from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import type { AcpAdapterEvent, AcpTransport } from "./acp-adapter.ts";
import { makeAcpHarnessAdapter } from "./acp-adapter.ts";
import { makeAcpAgentServerConnection } from "./acp-server.ts";
import type { AgentHarness } from "./adapter.ts";
import { HarnessCapabilityUnsupported } from "./capability.ts";
import type { HarnessToolApprovalDecision } from "./host-tool.ts";
import { metaAgentHarness } from "./meta-agent-harness.ts";
import { makeReferenceAdapter } from "./reference-adapter.ts";
import type { HarnessSession } from "./session.ts";
import type { HarnessStreamEvent } from "./stream.ts";

const SOURCE: KhalaRuntimeSource = { lane: "test_fixture" };

interface JsonRecord {
  readonly [key: string]: unknown;
}

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null ? (value as JsonRecord) : null;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);

/**
 * In-memory loopback ACP client (HANDSHAKE + prompt + permission answering).
 * The conformance oracle: the SAME projection the live grok/cursor transports
 * perform, but over the in-repo server helper instead of a live peer.
 */
const makeLoopbackClient = (
  harness: AgentHarness,
  options?: { readonly permissionOptionId?: string },
) =>
  Effect.gen(function* () {
    const clientPending = new Map<number, Deferred.Deferred<JsonRecord, never>>();
    const updates: Array<AcpAdapterEvent> = [];
    const startedCalls = new Map<string, string>();
    const permissionRequests: Array<JsonRecord> = [];
    let nextClientId = 1;

    // Deferred wiring: connection is created below with a send handler that may
    // itself call back into `connection.receive` (permission responses).
    let receiveInbound: (message: unknown) => Effect.Effect<void> = () => Effect.void;

    const handleServerMessage = (message: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        const record = asRecord(message);
        if (record === null) return;
        const method = asString(record.method);

        if (method === "session/update") {
          const params = asRecord(record.params) ?? {};
          const update = asRecord(params.update) ?? {};
          switch (asString(update.sessionUpdate)) {
            case "agent_message_chunk": {
              const content = asRecord(update.content) ?? {};
              updates.push({ type: "acp_text_delta", text: asString(content.text) });
              break;
            }
            case "agent_thought_chunk": {
              const content = asRecord(update.content) ?? {};
              updates.push({ type: "acp_thought_delta", text: asString(content.text) });
              break;
            }
            case "tool_call": {
              const toolCallId = asString(update.toolCallId);
              const toolName = asString(update.title) || "tool";
              startedCalls.set(toolCallId, toolName);
              updates.push({ type: "acp_tool_call", toolCallId, toolName });
              break;
            }
            case "tool_call_update": {
              const toolCallId = asString(update.toolCallId);
              const status = asString(update.status);
              updates.push({
                type: "acp_tool_result",
                toolCallId,
                toolName: startedCalls.get(toolCallId) ?? "tool",
                ok: status === "completed",
              });
              break;
            }
            default:
              break;
          }
          return;
        }

        if (method === "session/request_permission" && record.id !== undefined) {
          permissionRequests.push(asRecord(record.params) ?? {});
          const optionId = options?.permissionOptionId ?? "allow-once";
          yield* receiveInbound({
            jsonrpc: "2.0",
            id: record.id,
            result: { outcome: { outcome: "selected", optionId } },
          });
          return;
        }

        // A response to one of the client's own requests.
        if (method === "" && typeof record.id === "number") {
          const deferred = clientPending.get(record.id);
          if (deferred !== undefined) {
            clientPending.delete(record.id);
            yield* Deferred.succeed(deferred, asRecord(record.result) ?? record);
          }
        }
      });

    const connection = yield* makeAcpAgentServerConnection({
      harness,
      send: handleServerMessage,
    });
    receiveInbound = connection.receive;

    const request = (method: string, params: unknown): Effect.Effect<JsonRecord> =>
      Effect.gen(function* () {
        const id = nextClientId++;
        const deferred = yield* Deferred.make<JsonRecord, never>();
        clientPending.set(id, deferred);
        yield* connection.receive({ jsonrpc: "2.0", id, method, params });
        return yield* Deferred.await(deferred);
      });

    return { connection, request, updates, permissionRequests };
  });

/** Complete the handshake and return an {@link AcpTransport} over the loopback. */
const makeLoopbackTransport = (
  harness: AgentHarness,
  options?: { readonly permissionOptionId?: string },
) =>
  Effect.gen(function* () {
    const client = yield* makeLoopbackClient(harness, options);
    const init = yield* client.request("initialize", { protocolVersion: 1 });
    expect(init.protocolVersion).toBe(1);
    const session = yield* client.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = asString(session.sessionId);
    expect(sessionId).not.toBe("");

    const transport: AcpTransport = {
      promptTurn: (params) =>
        Effect.gen(function* () {
          client.updates.length = 0;
          const result = yield* client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: params.prompt }],
          });
          const stopReason = asString(result.stopReason) || "end_turn";
          return [
            { type: "acp_turn_started" } as const,
            ...client.updates,
            { type: "acp_turn_stop", stopReason } as const,
          ];
        }),
      shutdown: () => client.connection.shutdown(),
    };
    return { transport, client, sessionId };
  });

/** The meta-agent fleet the server exposes in the conformance loop. */
const makeFleetHarness = () =>
  metaAgentHarness({
    members: [{ id: "alpha", harness: makeReferenceAdapter({ scriptWords: ["Hello ", "loop"] }) }],
    route: () => "alpha",
  });

// ---------------------------------------------------------------------------
// Conformance: the in-repo ACP CLIENT adapter drives the ACP SERVER helper
// over an in-memory loopback — no live peers — and the composed harness
// passes the same adapter laws as every other adapter.
// ---------------------------------------------------------------------------

describe("acp server — conformance via the in-repo ACP client adapter (loopback)", () => {
  test("a full turn through server + client adapter satisfies the contiguous-stream law", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { transport } = yield* makeLoopbackTransport(makeFleetHarness());
        const adapter = makeAcpHarnessAdapter({
          harnessId: "loopback",
          harnessKind: "custom",
          transport,
        });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* Stream.runCollect(control.events);
        const done = yield* control.done;
        yield* transport.shutdown();
        return { events, done };
      }),
    );

    expect(result.events[0]?.kind).toBe("turn.started");
    expect(result.events.at(-1)?.kind).toBe("turn.finished");
    // turn.started + 2 text deltas + turn.finished, contiguous from 0.
    expect(sequences(result.events)).toEqual([0, 1, 2, 3]);
    expect(result.events.filter((e) => e.kind === "text.delta").length).toBe(2);
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(3);
  });

  test("suspend then continue on the composed harness replays from cursor+1 (adapter law)", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { transport } = yield* makeLoopbackTransport(makeFleetHarness());
        const adapter = makeAcpHarnessAdapter({
          harnessId: "loopback",
          harnessKind: "custom",
          transport,
        });

        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* Stream.runCollect(control.events.pipe(Stream.take(2)));
        const continuation = yield* session.suspendTurn();

        const session2 = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* Stream.runCollect(control2.events);
        yield* transport.shutdown();
        return { phase1, continuation, phase2 };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1]);
    expect(outcome.continuation.cursor).toBe(1);
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(new Set(merged).size).toBe(merged.length);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]).toBe((merged[i - 1] ?? -1) + 1);
    }
  });

  test("consecutive prompt turns each settle with their own stop reason", async () => {
    const stopReasons = await Effect.runPromise(
      Effect.gen(function* () {
        const { transport } = yield* makeLoopbackTransport(makeFleetHarness());
        const first = yield* transport.promptTurn({ prompt: "one" });
        const second = yield* transport.promptTurn({ prompt: "two" });
        yield* transport.shutdown();
        const stopOf = (events: ReadonlyArray<AcpAdapterEvent>) => {
          const last = events.at(-1);
          return last?.type === "acp_turn_stop" ? last.stopReason : "missing";
        };
        return [stopOf(first), stopOf(second)];
      }),
    );
    expect(stopReasons).toEqual(["end_turn", "end_turn"]);
  });
});

// ---------------------------------------------------------------------------
// Permission requests: RuntimeInteraction mapping, deny-by-default.
// ---------------------------------------------------------------------------

/** Fixture harness whose single turn asks for a built-in tool approval. */
const makeApprovalFixtureHarness = (
  recorded: Array<{ toolCallId: string; decision: HarnessToolApprovalDecision }>,
): AgentHarness => {
  const harnessId = "approval-fixture";
  const base = (sessionId: string, turnId: string, sequence: number, suffix: string) => ({
    schema: KhalaRuntimeEventSchemaLiteral,
    eventId: `evt.${turnId}.${sequence}.${suffix}`,
    turnId,
    threadId: sessionId,
    sequence,
    observedAt: "2026-07-20T00:00:00.000Z",
    source: SOURCE,
    visibility: "private",
    redactionClass: "private_ref",
    causalityRefs: [] as ReadonlyArray<string>,
  });
  const unsupported = (capability: "suspend_turn" | "continue_turn" | "detach" | "compact") =>
    Effect.fail(new HarnessCapabilityUnsupported({ harnessId, capability }));
  return {
    specificationVersion: "agent-harness-v1",
    harnessId,
    harnessKind: "test_fixture",
    adapterKind: "test_fixture",
    builtinTools: [{ nativeName: "Bash", commonName: "bash", description: "run a shell command" }],
    start: ({ sessionId }) =>
      Effect.sync(() => {
        const session: HarnessSession = {
          sessionId,
          isResume: false,
          promptTurn: ({ turnId }) =>
            Effect.sync(() => {
              const events: ReadonlyArray<HarnessStreamEvent> = [
                decodeKhalaRuntimeEvent({
                  ...base(sessionId, turnId, 0, "start"),
                  kind: "turn.started",
                }),
                decodeKhalaRuntimeEvent({
                  ...base(sessionId, turnId, 1, "toolcall"),
                  kind: "tool.call",
                  toolCallId: "toolcall.fix.1",
                  toolName: "bash",
                  authority: {
                    authorityRef: "authority.fix.1",
                    policyRef: "policy.fixture",
                    decisionRef: "decision.fixture.pending",
                    toolRef: "toolref.fixture.bash",
                    status: "operator_escalation_required",
                    allowed: false,
                    blockerRefs: ["blocker.owner_approval"],
                  },
                }),
                decodeKhalaRuntimeEvent({
                  ...base(sessionId, turnId, 2, "finish"),
                  kind: "turn.finished",
                  finishReason: "stop",
                }),
              ];
              return {
                turnId,
                events: Stream.fromIterable(events),
                done: Effect.succeed({ turnId, finishReason: "stop" as const, lastCursor: 2 }),
                submitToolResult: () => Effect.void,
                submitToolApproval: (toolCallId, decision) =>
                  Effect.sync(() => {
                    recorded.push({ toolCallId, decision });
                  }),
                submitUserMessage: () => Effect.void,
                interrupt: () => Effect.void,
              };
            }),
          continueTurn: () => unsupported("continue_turn"),
          suspendTurn: () => unsupported("suspend_turn"),
          compact: () => unsupported("compact"),
          detach: () => unsupported("detach"),
          stop: () => Effect.succeed({ harnessId, sessionId, data: {} }),
          destroy: () => Effect.void,
        };
        return session;
      }),
  };
};

describe("acp server — permission requests ride session/request_permission, deny by default", () => {
  test("an approval-pending tool.call asks the client and applies an allow decision", async () => {
    const recorded: Array<{ toolCallId: string; decision: HarnessToolApprovalDecision }> = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { transport, client } = yield* makeLoopbackTransport(
          makeApprovalFixtureHarness(recorded),
          { permissionOptionId: "allow-once" },
        );
        const events = yield* transport.promptTurn({ prompt: "run it" });
        yield* transport.shutdown();
        return { events, permissionRequests: client.permissionRequests };
      }),
    );

    expect(outcome.permissionRequests.length).toBe(1);
    const toolCall = asRecord(outcome.permissionRequests[0]?.toolCall);
    expect(asString(toolCall?.toolCallId)).toBe("toolcall.fix.1");
    expect(recorded).toEqual([{ toolCallId: "toolcall.fix.1", decision: "allow-once" }]);
    // The wire stream still carried the tool_call update.
    expect(outcome.events.some((e) => e.type === "acp_tool_call")).toBe(true);
  });

  test("an unclear client outcome denies (fail-closed)", async () => {
    const recorded: Array<{ toolCallId: string; decision: HarnessToolApprovalDecision }> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const { transport } = yield* makeLoopbackTransport(makeApprovalFixtureHarness(recorded), {
          permissionOptionId: "something-weird",
        });
        yield* transport.promptTurn({ prompt: "run it" });
        yield* transport.shutdown();
      }),
    );
    expect(recorded).toEqual([{ toolCallId: "toolcall.fix.1", decision: "deny" }]);
  });

  test("a host-supplied decider overrides the wire flow (still fail-closed on error)", async () => {
    const recorded: Array<{ toolCallId: string; decision: HarnessToolApprovalDecision }> = [];
    const payloads: Array<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* Effect.gen(function* () {
          // Direct wiring (not the shared helper) so we can pass decidePermission.
          const clientPending = new Map<number, Deferred.Deferred<JsonRecord, never>>();
          let nextClientId = 1;
          const connection = yield* makeAcpAgentServerConnection({
            harness: makeApprovalFixtureHarness(recorded),
            decidePermission: ({ payload }) =>
              Effect.sync(() => {
                payloads.push(`${payload.kind}:${payload.toolName}`);
                return "deny" as const;
              }),
            send: (message) =>
              Effect.gen(function* () {
                const record = asRecord(message);
                if (record === null) return;
                if (asString(record.method) === "" && typeof record.id === "number") {
                  const deferred = clientPending.get(record.id);
                  if (deferred !== undefined) {
                    clientPending.delete(record.id);
                    yield* Deferred.succeed(deferred, asRecord(record.result) ?? {});
                  }
                }
              }),
          });
          const request = (method: string, params: unknown): Effect.Effect<JsonRecord> =>
            Effect.gen(function* () {
              const id = nextClientId++;
              const deferred = yield* Deferred.make<JsonRecord, never>();
              clientPending.set(id, deferred);
              yield* connection.receive({ jsonrpc: "2.0", id, method, params });
              return yield* Deferred.await(deferred);
            });
          return { connection, request };
        });

        yield* client.request("initialize", { protocolVersion: 1 });
        const session = yield* client.request("session/new", { cwd: "/tmp", mcpServers: [] });
        yield* client.request("session/prompt", {
          sessionId: asString(session.sessionId),
          prompt: [{ type: "text", text: "run it" }],
        });
        yield* client.connection.shutdown();
      }),
    );
    expect(payloads).toEqual(["tool_approval:bash"]);
    expect(recorded).toEqual([{ toolCallId: "toolcall.fix.1", decision: "deny" }]);
  });
});

describe("acp server — protocol surface", () => {
  test("unknown methods and unknown sessions fail with typed JSON-RPC errors", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const collected: Array<JsonRecord> = [];
        const connection = yield* makeAcpAgentServerConnection({
          harness: makeFleetHarness(),
          send: (message) =>
            Effect.sync(() => {
              const record = asRecord(message);
              if (record !== null && asRecord(record.error) !== null) {
                collected.push(asRecord(record.error) ?? {});
              }
            }),
        });
        yield* connection.receive({ jsonrpc: "2.0", id: 1, method: "session/bogus", params: {} });
        yield* connection.receive({
          jsonrpc: "2.0",
          id: 2,
          method: "session/prompt",
          params: { sessionId: "acp.session.nope", prompt: [{ type: "text", text: "x" }] },
        });
        yield* connection.shutdown();
        return collected;
      }),
    );
    expect(errors.length).toBe(2);
    expect(errors[0]?.code).toBe(-32601);
    expect(errors[1]?.code).toBe(-32602);
  });
});
