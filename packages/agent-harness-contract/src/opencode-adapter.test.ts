import { Effect, Stream } from "effect";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import {
  decodeOpencodeSessionEvent,
  makeOpencodeAdapter,
  OPENCODE_APPROVAL_DECISION_TO_REPLY,
  type OpencodeEvent,
  opencodeEventToKhalaEvents,
  type OpencodePermissionReply,
  opencodePermissionToRuntimeInteractionPayload,
  type OpencodeProjectionContext,
  opencodeToolCallId,
  type OpencodeTransport,
  OpencodeTransportError,
  type OpencodeWireEvent,
} from "./opencode-adapter.ts";
import type { HarnessStreamEvent } from "./stream.ts";

// opencode is an external-agent (ACP-adjacent) runtime; its neutral events are
// labelled with the ACP lane while the adapter itself reports adapterKind
// "opencode".
const SOURCE: KhalaRuntimeSource = { lane: "agent_client_protocol", adapterKind: "opencode" };

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);
const kinds = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.kind);

const makeCtx = (): OpencodeProjectionContext => {
  let seq = 0;
  return {
    source: SOURCE,
    threadId: "s1",
    turnId: "t1",
    nextSequence: () => seq++,
    toolNames: new Map<string, string>(),
  };
};

// A representative opencode stream: text -> reasoning -> tool call+result ->
// step-ended (the neutral turn-finish carrier).
const REPRESENTATIVE_SCRIPT: ReadonlyArray<OpencodeEvent> = [
  {
    type: "session.next.text.delta",
    assistantMessageID: "msg_1",
    textID: "text_1",
    delta: "On it. ",
  },
  {
    type: "session.next.reasoning.delta",
    assistantMessageID: "msg_1",
    reasoningID: "r_1",
    delta: "plan",
  },
  {
    type: "session.next.tool.called",
    assistantMessageID: "msg_1",
    callID: "call_1",
    tool: "bash",
    providerExecuted: true,
  },
  { type: "session.next.tool.success", callID: "call_1", providerExecuted: true },
  {
    type: "session.next.step.ended",
    assistantMessageID: "msg_1",
    finish: "stop",
    tokens: { input: 20, output: 8, reasoning: 3, cache: { read: 1, write: 0 } },
  },
];

describe("opencode projection — neutral event mapping", () => {
  test("a representative stream projects onto a contiguous KhalaRuntimeEvent stream", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter({ script: REPRESENTATIVE_SCRIPT });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* collect(control.events);
      }),
    );

    // turn.started + text.delta + reasoning.delta + tool.call + tool.result + turn.finished.
    expect(kinds(events)).toEqual([
      "turn.started",
      "text.delta",
      "reasoning.delta",
      "tool.call",
      "tool.result",
      "turn.finished",
    ]);
    // Sequences are contiguous 0..5 with no gap and no duplicate.
    expect(sequences(events)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(sequences(events)).size).toBe(events.length);

    // step.ended carried token usage onto the neutral turn.finished.
    const finished = events.at(-1);
    expect(finished).toMatchObject({
      kind: "turn.finished",
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 3, totalTokens: 31 },
    });
  });

  test("reasoning deltas project onto reasoning.delta events", () => {
    const ctx = makeCtx();
    const projected = opencodeEventToKhalaEvents(
      {
        type: "session.next.reasoning.delta",
        assistantMessageID: "msg_1",
        reasoningID: "r_1",
        delta: "thinking",
      },
      ctx,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ kind: "reasoning.delta", text: "thinking" });
  });

  test("session.idle projects to no neutral event (turn boundary is step.ended)", () => {
    const ctx = makeCtx();
    expect(opencodeEventToKhalaEvents({ type: "session.idle" }, ctx)).toEqual([]);
  });
});

describe("opencode projection — tool-name normalization", () => {
  test("opencode 'bash' projects with the shared common name", () => {
    const ctx = makeCtx();
    const called = opencodeEventToKhalaEvents(
      {
        type: "session.next.tool.called",
        assistantMessageID: "m",
        callID: "c1",
        tool: "bash",
        providerExecuted: true,
      },
      ctx,
    );
    expect(called[0]).toMatchObject({ kind: "tool.call", toolName: "bash" });
    // The success event correlates the tool id from the earlier call and keeps the common name.
    const success = opencodeEventToKhalaEvents(
      { type: "session.next.tool.success", callID: "c1", providerExecuted: true },
      ctx,
    );
    expect(success[0]).toMatchObject({
      kind: "tool.result",
      toolName: "bash",
      providerExecuted: true,
    });
  });

  test("opencode 'read' normalizes to the common vocabulary", () => {
    const ctx = makeCtx();
    const called = opencodeEventToKhalaEvents(
      {
        type: "session.next.tool.called",
        assistantMessageID: "m",
        callID: "c2",
        tool: "read",
        providerExecuted: false,
      },
      ctx,
    );
    expect(called[0]).toMatchObject({ kind: "tool.call", toolName: "read" });
  });

  test("an opencode tool with no common equivalent keeps its native id", () => {
    const ctx = makeCtx();
    const called = opencodeEventToKhalaEvents(
      {
        type: "session.next.tool.called",
        assistantMessageID: "m",
        callID: "c3",
        tool: "webfetch",
        providerExecuted: true,
      },
      ctx,
    );
    expect(called[0]).toMatchObject({ kind: "tool.call", toolName: "webfetch" });
  });
});

describe("opencode adapter — turn semantics and cursor exactness", () => {
  test("a full turn streams turn.started -> ... -> turn.finished with contiguous sequences", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );

    expect(result.events[0]?.kind).toBe("turn.started");
    expect(result.events.at(-1)?.kind).toBe("turn.finished");
    // turn.started + 2 text.delta + turn.finished = 4 events, sequences 0..3.
    expect(sequences(result.events)).toEqual([0, 1, 2, 3]);
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(3);
  });

  test("suspend then continue replays from cursor+1 with no gap and no duplicate", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter();

        // Phase 1: pull only the first two events, then suspend.
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(2)));
        const continuation = yield* session.suspendTurn();

        // Phase 2: a FRESH session (different process) resumes from the cursor.
        const session2 = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* collect(control2.events);

        return { phase1, continuation, phase2 };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1]);
    // The cursor is exactly the last event delivered in phase 1.
    expect(outcome.continuation.cursor).toBe(1);
    expect(outcome.continuation.lossy).toBe(false);
    // Phase 2 attaches at cursor + 1 — no gap, no duplicate.
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    expect(sequences(outcome.phase2)).toEqual([2, 3]);

    // Concatenation is the full, contiguous turn exactly once.
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(merged).toEqual([0, 1, 2, 3]);
    expect(new Set(merged).size).toBe(merged.length);
  });
});

describe("opencode adapter — identity and capability posture", () => {
  test("the adapter reports the opencode harness/adapter kind", () => {
    const adapter = makeOpencodeAdapter();
    expect(adapter.harnessId).toBe("opencode");
    expect(adapter.harnessKind).toBe("opencode");
    expect(adapter.adapterKind).toBe("opencode");
  });

  test("a refused capability fails closed with a typed capability error", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter({ supportsSuspend: false });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.suspendTurn().pipe(Effect.flip);
      }),
    );
    expect(error.capability).toBe("suspend_turn");
  });
});

// The raw SSE wire shapes the live transport actually decodes: `GET /event`
// wraps each `session.next.*` notification's schema fields under `properties`
// (opencode `packages/schema/src/session-event.ts`). tool.called/success/failed
// carry `provider: { executed }`; step.ended carries the real `tokens`; a
// permission ask arrives as `permission.v2.asked` with a `source.callID`.
const WIRE_TEXT_DELTA: OpencodeWireEvent = {
  type: "session.next.text.delta",
  properties: { sessionID: "ses_1", assistantMessageID: "msg_1", textID: "txt_1", delta: "Hi " },
};
const WIRE_TOOL_CALLED: OpencodeWireEvent = {
  type: "session.next.tool.called",
  properties: {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_ab",
    tool: "bash",
    input: { command: "ls" },
    provider: { executed: true },
  },
};
const WIRE_TOOL_SUCCESS: OpencodeWireEvent = {
  type: "session.next.tool.success",
  properties: {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_ab",
    structured: {},
    content: [],
    provider: { executed: true },
  },
};
const WIRE_STEP_ENDED: OpencodeWireEvent = {
  type: "session.next.step.ended",
  properties: {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    finish: "stop",
    cost: 0.001,
    tokens: { input: 30, output: 9, reasoning: 4, cache: { read: 2, write: 1 } },
  },
};

describe("opencode live-path — decode of the real SSE wire shapes", () => {
  test("decodeOpencodeSessionEvent flattens provider.executed and the real tokens shape", () => {
    expect(decodeOpencodeSessionEvent(WIRE_TOOL_CALLED)).toEqual({
      type: "session.next.tool.called",
      assistantMessageID: "msg_1",
      callID: "call_ab",
      tool: "bash",
      providerExecuted: true,
    });
    expect(decodeOpencodeSessionEvent(WIRE_STEP_ENDED)).toEqual({
      type: "session.next.step.ended",
      assistantMessageID: "msg_1",
      finish: "stop",
      tokens: { input: 30, output: 9, reasoning: 4, cache: { read: 2, write: 1 } },
    });
  });

  test("tool.failed extracts a bounded public-safe message from the error payload", () => {
    const decoded = decodeOpencodeSessionEvent({
      type: "session.next.tool.failed",
      properties: {
        sessionID: "ses_1",
        callID: "call_ab",
        error: { type: "unknown", message: "command not found: frobnicate" },
        provider: { executed: false },
      },
    });
    expect(decoded).toEqual({
      type: "session.next.tool.failed",
      callID: "call_ab",
      messageSafe: "command not found: frobnicate",
      providerExecuted: false,
    });
  });

  test("a live-only / unmodelled event decodes to undefined (no neutral projection)", () => {
    expect(
      decodeOpencodeSessionEvent({
        type: "session.next.tool.input.delta",
        properties: { sessionID: "ses_1", callID: "call_ab", delta: "{" },
      }),
    ).toBeUndefined();
    expect(
      decodeOpencodeSessionEvent({ type: "session.next.step.started", properties: {} }),
    ).toBeUndefined();
  });

  test("a decoded real stream projects onto the neutral stream with call/result correlation", () => {
    let seq = 0;
    const ctx: OpencodeProjectionContext = {
      source: SOURCE,
      threadId: "s1",
      turnId: "t1",
      nextSequence: () => seq++,
      toolNames: new Map<string, string>(),
    };
    const wire: ReadonlyArray<OpencodeWireEvent> = [
      WIRE_TEXT_DELTA,
      WIRE_TOOL_CALLED,
      WIRE_TOOL_SUCCESS,
      WIRE_STEP_ENDED,
    ];
    const events = wire.flatMap((w) => {
      const decoded = decodeOpencodeSessionEvent(w);
      return decoded === undefined ? [] : opencodeEventToKhalaEvents(decoded, ctx);
    });

    expect(kinds(events)).toEqual(["text.delta", "tool.call", "tool.result", "turn.finished"]);
    // The tool.call and its later tool.success (which carries only callID) share
    // one neutral toolCallId derived from the opencode callID.
    const call = events.find((e) => e.kind === "tool.call");
    const result = events.find((e) => e.kind === "tool.result");
    const expectedId = opencodeToolCallId("call_ab");
    expect((call as { toolCallId?: string }).toolCallId).toBe(expectedId);
    expect((result as { toolCallId?: string }).toolCallId).toBe(expectedId);
    // step.ended carried the real tokens onto turn.finished.
    expect(events.at(-1)).toMatchObject({
      kind: "turn.finished",
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 9, reasoningTokens: 4, totalTokens: 43 },
    });
  });

  test("step.failed projects to an error turn.finished with no fabricated usage", () => {
    let seq = 0;
    const ctx: OpencodeProjectionContext = {
      source: SOURCE,
      threadId: "s1",
      turnId: "t1",
      nextSequence: () => seq++,
      toolNames: new Map<string, string>(),
    };
    const decoded = decodeOpencodeSessionEvent({
      type: "session.next.step.failed",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", error: { message: "boom" } },
    });
    const events = decoded === undefined ? [] : opencodeEventToKhalaEvents(decoded, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "turn.finished", finishReason: "error" });
    expect((events[0] as { usage?: unknown }).usage).toBeUndefined();
  });

  test("permission.v2.asked records a pending approval and projects to no transcript event", () => {
    let seq = 0;
    const pendingApprovals = new Map<string, string>();
    const toolNames = new Map<string, string>([["call_ab", "bash"]]);
    const ctx: OpencodeProjectionContext = {
      source: SOURCE,
      threadId: "s1",
      turnId: "t1",
      nextSequence: () => seq++,
      toolNames,
      pendingApprovals,
    };
    const decoded = decodeOpencodeSessionEvent({
      type: "permission.v2.asked",
      properties: {
        id: "per_xyz",
        sessionID: "ses_1",
        action: "run a shell command",
        resources: ["bash"],
        source: { type: "tool", messageID: "msg_1", callID: "call_ab" },
      },
    });
    const events = decoded === undefined ? [] : opencodeEventToKhalaEvents(decoded, ctx);
    expect(events).toEqual([]);
    // The pending approval keys the neutral toolCallId to the opencode per_ id.
    expect(pendingApprovals.get(opencodeToolCallId("call_ab"))).toBe("per_xyz");

    // The permission routes onto the durable RuntimeInteraction tool_approval model.
    const payload = opencodePermissionToRuntimeInteractionPayload(
      decoded as Extract<OpencodeEvent, { type: "permission.v2.asked" }>,
      toolNames,
    );
    expect(payload).toMatchObject({
      kind: "tool_approval",
      toolCallId: opencodeToolCallId("call_ab"),
      toolName: "bash",
      authority: { status: "operator_escalation_required", allowed: false },
    });
  });

  test("the harness decision vocabulary maps onto opencode's reply vocabulary", () => {
    expect(OPENCODE_APPROVAL_DECISION_TO_REPLY["allow-once"]).toBe("once");
    expect(OPENCODE_APPROVAL_DECISION_TO_REPLY["allow-session"]).toBe("always");
    expect(OPENCODE_APPROVAL_DECISION_TO_REPLY.deny).toBe("reject");
  });
});

/**
 * A fixture {@link OpencodeTransport} scripted with real-wire-decoded events.
 * It records the calls a live transport would make (createSession, prompt,
 * replyToPermission) so a test can assert the adapter drives the control plane
 * correctly without a live opencode server.
 */
const makeRecordingTransport = (
  turnEvents: ReadonlyArray<OpencodeWireEvent>,
): {
  readonly transport: OpencodeTransport;
  readonly replies: Array<{ sessionId: string; requestId: string; reply: OpencodePermissionReply }>;
  readonly created: { count: number };
} => {
  const replies: Array<{
    sessionId: string;
    requestId: string;
    reply: OpencodePermissionReply;
  }> = [];
  const created = { count: 0 };
  const decoded = turnEvents.flatMap((w) => {
    const event = decodeOpencodeSessionEvent(w);
    return event === undefined ? [] : [event];
  });
  const transport: OpencodeTransport = {
    createSession: () =>
      Effect.sync(() => {
        created.count += 1;
        return { sessionId: "ses_live_1" };
      }),
    prompt: () => Effect.succeed(decoded),
    replyToPermission: (params) =>
      Effect.sync(() => {
        replies.push(params);
      }),
    shutdown: () => Effect.void,
  };
  return { transport, replies, created };
};

describe("opencode adapter — live transport drive path", () => {
  test("the adapter creates a session and drives a turn through the injected transport", async () => {
    const { transport, created } = makeRecordingTransport([
      WIRE_TEXT_DELTA,
      WIRE_TOOL_CALLED,
      WIRE_TOOL_SUCCESS,
      WIRE_STEP_ENDED,
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter({ transport });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );
    expect(created.count).toBe(1);
    expect(kinds(result.events)).toEqual([
      "turn.started",
      "text.delta",
      "tool.call",
      "tool.result",
      "turn.finished",
    ]);
    expect(sequences(result.events)).toEqual([0, 1, 2, 3, 4]);
    expect(result.done.finishReason).toBe("stop");
  });

  test("a live transport reports builtin-tool approvals; the scripted fixture does not", () => {
    const { transport } = makeRecordingTransport([WIRE_STEP_ENDED]);
    expect(makeOpencodeAdapter({ transport }).supportsBuiltinToolApprovals).toBe(true);
    expect(makeOpencodeAdapter().supportsBuiltinToolApprovals).toBe(false);
  });

  test("submitToolApproval answers opencode's permission reply endpoint", async () => {
    const wirePermission: OpencodeWireEvent = {
      type: "permission.v2.asked",
      properties: {
        id: "per_live",
        sessionID: "ses_live_1",
        action: "run a shell command",
        resources: ["bash"],
        source: { type: "tool", messageID: "msg_1", callID: "call_ab" },
      },
    };
    const { transport, replies } = makeRecordingTransport([
      WIRE_TOOL_CALLED,
      wirePermission,
      WIRE_TOOL_SUCCESS,
      WIRE_STEP_ENDED,
    ]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter({ transport });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        // Drain the turn so the permission ask is folded into pending approvals.
        yield* collect(control.events);
        yield* control.submitToolApproval(opencodeToolCallId("call_ab"), "allow-once");
      }),
    );
    expect(replies).toEqual([{ sessionId: "ses_live_1", requestId: "per_live", reply: "once" }]);
  });

  test("a transport createSession failure surfaces as a typed start error", async () => {
    const failing: OpencodeTransport = {
      createSession: () =>
        Effect.fail(
          new OpencodeTransportError({
            failureClass: "account_rate_limited",
            detail: "429 too many requests",
          }),
        ),
      prompt: () => Effect.succeed([]),
      replyToPermission: () => Effect.void,
      shutdown: () => Effect.void,
    };
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter({ transport: failing });
        return yield* adapter.start({ sessionId: "s1", source: SOURCE }).pipe(Effect.flip);
      }),
    );
    expect(error.failureClass).toBe("account_rate_limited");
  });

  test("detach exports the opencode session id and start reuses it (no second create)", async () => {
    const { transport, created } = makeRecordingTransport([WIRE_STEP_ENDED]);
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeOpencodeAdapter({ transport });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const resume = yield* session.detach();
        const resumed = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          resumeFrom: resume,
        });
        return { resume, resumed };
      }),
    );
    expect((outcome.resume.data as { opencodeSessionId?: string }).opencodeSessionId).toBe(
      "ses_live_1",
    );
    expect(outcome.resumed.isResume).toBe(true);
    // One create for the fresh session; the resume reused the exported id.
    expect(created.count).toBe(1);
  });
});

// LIVE SMOKE — NEVER runs in CI (skipped). It documents how to drive a real
// local opencode server end to end. To run it by hand: start `opencode serve`,
// implement `OpencodeTransport` over its REST + SSE control plane (see the seam
// doc in opencode-adapter.ts), point `OPENCODE_BASE_URL` at the printed URL,
// and change `test.skip` to `test`. The hermetic suite above never needs it.
describe("opencode adapter — live smoke (skipped)", () => {
  test.skip("drives a real local opencode server: session create -> prompt -> projected turn", async () => {
    // 1. `POST {OPENCODE_BASE_URL}/session` -> opencode session id.
    // 2. Subscribe to `GET {OPENCODE_BASE_URL}/event` (SSE); for each event with
    //    `properties.sessionID === sessionId`, decode via
    //    `decodeOpencodeSessionEvent` and buffer non-undefined results.
    // 3. `POST {OPENCODE_BASE_URL}/session/{sessionId}/message` with
    //    `{ parts: [{ type: "text", text: prompt }] }`; resolve the buffer when
    //    `session.next.step.ended` for the assistant message arrives.
    // 4. Answer any `permission.v2.asked` via
    //    `POST {OPENCODE_BASE_URL}/api/session/{sessionId}/permission/{id}/reply`.
    // 5. Wire that as an `OpencodeTransport`, then:
    //      const adapter = makeOpencodeAdapter({ transport: liveTransport })
    //      const session = await Effect.runPromise(adapter.start({ sessionId, source: SOURCE }))
    //      const control = await Effect.runPromise(session.promptTurn({ turnId: "t1", prompt: "..." }))
    //      const events = await Effect.runPromise(collect(control.events))
    //    Assert `events[0].kind === "turn.started"` and the last is `turn.finished`.
    expect(true).toBe(true);
  });
});
