import { Effect, Schema as S, Stream } from "effect";
import {
  RuntimeInteractionPayload,
  type KhalaRuntimeSource,
} from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import {
  DEFAULT_GOOSE_SCRIPT,
  GOOSE_PERMISSION_OPTION_KINDS,
  gooseModelFailureClass,
  gooseOptionForApprovalDecision,
  goosePermissionToRuntimeInteractionPayload,
  gooseScriptToAcpScript,
  gooseUpdateToAcpEvents,
  gooseUsageUpdateToKhalaUsage,
  harnessDecisionForGooseOption,
  isRefusedGooseHome,
  makeGooseHarnessAdapter,
  type GooseSessionUpdate,
} from "./goose-adapter.ts";
import type { HarnessStreamEvent } from "./stream.ts";

// Goose is an ACP peer; its events ride the agent-client-protocol lane.
const SOURCE: KhalaRuntimeSource = {
  lane: "agent_client_protocol",
  adapterKind: "agent_client_protocol",
};

const ISOLATED_HOME = "/tmp/pylon/accounts/goose/acct-1/data";

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);
const kinds = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.kind);

const decodeRuntimeInteractionPayload = S.decodeUnknownSync(RuntimeInteractionPayload);

const makeAdapter = (options?: {
  readonly script?: ReadonlyArray<GooseSessionUpdate>;
  readonly gooseHome?: string;
}) =>
  makeGooseHarnessAdapter({
    gooseHome: options?.gooseHome ?? ISOLATED_HOME,
    ...(options?.script === undefined ? {} : { script: options.script }),
  });

describe("goose projection — SessionUpdate onto neutral ACP input", () => {
  test("each Goose update maps onto the expected ACP adapter event", () => {
    expect(gooseUpdateToAcpEvents({ type: "agent_message_chunk", text: "hi" })).toEqual([
      { type: "acp_text_delta", text: "hi" },
    ]);
    expect(gooseUpdateToAcpEvents({ type: "agent_thought_chunk", text: "plan" })).toEqual([
      { type: "acp_thought_delta", text: "plan" },
    ]);
    expect(
      gooseUpdateToAcpEvents({
        type: "tool_call",
        toolCallId: "toolcall.goose.1",
        toolName: "developer__shell",
      }),
    ).toEqual([
      { type: "acp_tool_call", toolCallId: "toolcall.goose.1", toolName: "developer__shell" },
    ]);
    expect(
      gooseUpdateToAcpEvents({
        type: "tool_call_update",
        toolCallId: "toolcall.goose.1",
        toolName: "developer__shell",
        status: "completed",
      }),
    ).toEqual([
      {
        type: "acp_tool_result",
        toolCallId: "toolcall.goose.1",
        toolName: "developer__shell",
        ok: true,
      },
    ]);
    expect(gooseUpdateToAcpEvents({ type: "prompt_stop", stopReason: "end_turn" })).toEqual([
      { type: "acp_turn_stop", stopReason: "end_turn" },
    ]);
  });

  test("progress tool updates, permission requests, and usage consume no stream event", () => {
    expect(
      gooseUpdateToAcpEvents({
        type: "tool_call_update",
        toolCallId: "toolcall.goose.1",
        toolName: "developer__shell",
        status: "in_progress",
      }),
    ).toEqual([]);
    expect(
      gooseUpdateToAcpEvents({
        type: "permission_request",
        toolCallId: "toolcall.goose.1",
        toolName: "developer__shell",
      }),
    ).toEqual([]);
    expect(
      gooseUpdateToAcpEvents({ type: "usage_update", inputTokens: 10, outputTokens: 2 }),
    ).toEqual([]);
  });

  test("gooseScriptToAcpScript synthesizes exactly one turn boundary pair", () => {
    const acp = gooseScriptToAcpScript(DEFAULT_GOOSE_SCRIPT);
    expect(acp[0]).toEqual({ type: "acp_turn_started" });
    expect(acp.at(-1)).toEqual({ type: "acp_turn_stop", stopReason: "end_turn" });
    expect(acp.filter((e) => e.type === "acp_turn_started")).toHaveLength(1);
    expect(acp.filter((e) => e.type === "acp_turn_stop")).toHaveLength(1);
  });

  test("a failed tool update projects onto acp_tool_result with a safe message", () => {
    expect(
      gooseUpdateToAcpEvents({
        type: "tool_call_update",
        toolCallId: "toolcall.goose.2",
        toolName: "developer__shell",
        status: "failed",
        messageSafe: "exit code 1",
      }),
    ).toEqual([
      {
        type: "acp_tool_result",
        toolCallId: "toolcall.goose.2",
        toolName: "developer__shell",
        ok: false,
        messageSafe: "exit code 1",
      },
    ]);
  });
});

describe("goose adapter — turn lifecycle and tool correlation", () => {
  test("the representative turn streams a contiguous turn.started -> turn.finished", async () => {
    const adapter = makeAdapter();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "fix it" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );

    expect(kinds(result.events)).toEqual([
      "turn.started",
      "reasoning.delta",
      "text.delta",
      "tool.call",
      "tool.result",
      "text.delta",
      "turn.finished",
    ]);
    // Contiguous, no gap and no duplicate; permission + usage consumed no sequence.
    expect(sequences(result.events)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.events.at(-1)).toMatchObject({ kind: "turn.finished", finishReason: "stop" });
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(6);
  });

  test("the tool.call and tool.result share the goose tool call id", async () => {
    const adapter = makeAdapter();
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* collect(control.events);
      }),
    );
    const call = events.find((e) => e.kind === "tool.call");
    const result = events.find((e) => e.kind === "tool.result");
    expect(call).toMatchObject({ toolCallId: "toolcall.goose.1", toolName: "developer__shell" });
    expect(result).toMatchObject({
      toolCallId: "toolcall.goose.1",
      toolName: "developer__shell",
      providerExecuted: true,
    });
  });

  test("a failed tool update surfaces tool.error on the neutral stream", async () => {
    const adapter = makeAdapter({
      script: [
        { type: "tool_call", toolCallId: "toolcall.goose.9", toolName: "developer__shell" },
        {
          type: "tool_call_update",
          toolCallId: "toolcall.goose.9",
          toolName: "developer__shell",
          status: "failed",
          messageSafe: "command failed",
        },
        { type: "prompt_stop", stopReason: "end_turn" },
      ],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* collect(control.events);
      }),
    );
    expect(kinds(events)).toEqual(["turn.started", "tool.call", "tool.error", "turn.finished"]);
    expect(events.find((e) => e.kind === "tool.error")).toMatchObject({
      toolName: "developer__shell",
      messageSafe: "command failed",
    });
  });

  test("a cancelled prompt maps onto finishReason cancelled", async () => {
    const adapter = makeAdapter({
      script: [
        { type: "agent_message_chunk", text: "stopping" },
        { type: "prompt_stop", stopReason: "cancelled" },
      ],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* collect(control.events);
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: "turn.finished", finishReason: "cancelled" });
  });
});

describe("goose approvals — RuntimeInteraction routing and option vocabulary", () => {
  test("a permission request produces a valid tool_approval payload", () => {
    const payload = goosePermissionToRuntimeInteractionPayload({
      type: "permission_request",
      toolCallId: "toolcall.goose.1",
      toolName: "developer__shell",
      displayText: "Allow goose to run a shell command?",
    });
    expect(decodeRuntimeInteractionPayload(payload)).toMatchObject({
      kind: "tool_approval",
      toolCallId: "toolcall.goose.1",
      toolName: "developer__shell",
      authority: {
        status: "operator_escalation_required",
        allowed: false,
        blockerRefs: ["blocker.owner_approval"],
      },
    });
  });

  test("an inactive-builtin request carries the extra blocker ref", () => {
    const payload = goosePermissionToRuntimeInteractionPayload({
      type: "permission_request",
      toolCallId: "toolcall.goose.2",
      toolName: "developer__shell",
      inactiveBuiltin: true,
    });
    expect(decodeRuntimeInteractionPayload(payload)).toMatchObject({
      kind: "tool_approval",
      authority: {
        blockerRefs: ["blocker.inactive_builtin_tool", "blocker.owner_approval"],
      },
    });
  });

  test("harness decisions round-trip through the Goose permission-option vocabulary", () => {
    expect(gooseOptionForApprovalDecision["allow-once"]).toBe("allow_once");
    expect(gooseOptionForApprovalDecision["allow-session"]).toBe("allow_always");
    expect(gooseOptionForApprovalDecision.deny).toBe("reject_once");
    expect(harnessDecisionForGooseOption("allow_always")).toBe("allow-session");
    expect(harnessDecisionForGooseOption("allow_once")).toBe("allow-once");
    expect(harnessDecisionForGooseOption("reject_once")).toBe("deny");
    expect(harnessDecisionForGooseOption("reject_always")).toBe("deny");
    // Every Goose option kind maps onto a harness decision.
    for (const kind of GOOSE_PERMISSION_OPTION_KINDS) {
      expect(["allow-once", "allow-session", "deny"]).toContain(
        harnessDecisionForGooseOption(kind),
      );
    }
  });

  test("approvals never ride the native submitToolApproval channel", async () => {
    const adapter = makeAdapter();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* control
          .submitToolApproval("toolcall.goose.1", "allow-once")
          .pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({ failureClass: "no_active_tool_call" });
  });
});

describe("goose adapter — lossless suspend/continue", () => {
  test("suspend then continue replays from cursor+1 with no gap and no duplicate", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(3)));
        const continuation = yield* session.suspendTurn();

        // A FRESH adapter (different process) resumes from the exact cursor.
        const adapter2 = makeAdapter();
        const session2 = yield* adapter2.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* collect(control2.events);
        return { phase1, continuation, phase2 };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1, 2]);
    expect(outcome.continuation.cursor).toBe(2);
    // ACP attach continuation is LOSSLESS.
    expect(outcome.continuation.lossy).toBe(false);
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(merged).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(merged).size).toBe(merged.length);
  });

  test("detach and resume re-attach the session", async () => {
    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const resumeState = yield* session.detach();

        const adapter2 = makeAdapter();
        const session2 = yield* adapter2.start({
          sessionId: "s1",
          source: SOURCE,
          resumeFrom: resumeState,
        });
        return { resumeState, isResume: session2.isResume };
      }),
    );
    expect(resumed.resumeState.harnessId).toBe("goose");
    expect(resumed.isResume).toBe(true);
  });
});

describe("goose adapter — isolated home guard", () => {
  test.each([
    "",
    "~/.config/goose",
    "/Users/owner/.config/goose",
    "/Users/owner/.local/share/goose",
    "/Users/owner/.local/share/goose/",
    "/Users/owner/.goose",
    "/Users/owner/.goose/sessions",
  ])("refuses the live-home shaped gooseHome %j", async (gooseHome) => {
    const adapter = makeAdapter({ gooseHome });
    const error = await Effect.runPromise(
      adapter.start({ sessionId: "s1", source: SOURCE }).pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.StartError",
      failureClass: "goose_home_not_isolated",
    });
  });

  test("the guard predicate matches the accepted/refused split directly", () => {
    expect(isRefusedGooseHome(ISOLATED_HOME)).toBe(false);
    expect(isRefusedGooseHome("/tmp/pylon/accounts/goose/acct-1/config")).toBe(false);
    expect(isRefusedGooseHome("~/.config/goose")).toBe(true);
    expect(isRefusedGooseHome("~/.goose")).toBe(true);
  });

  test("an isolated account home is accepted", async () => {
    const adapter = makeAdapter();
    const session = await Effect.runPromise(adapter.start({ sessionId: "s1", source: SOURCE }));
    expect(session.sessionId).toBe("s1");
  });
});

describe("goose adapter — identity and capability posture", () => {
  test("reports the goose harness identity and ACP dispatch kind", () => {
    const adapter = makeAdapter();
    expect(adapter.harnessId).toBe("goose");
    expect(adapter.harnessKind).toBe("custom");
    expect(adapter.adapterKind).toBe("agent_client_protocol");
    expect(adapter.builtinTools.map((tool) => tool.nativeName)).toEqual([
      "developer__shell",
      "developer__text_editor",
      "developer__list_windows",
    ]);
    // Approvals route through RuntimeInteraction, filtering is not native.
    expect(adapter.supportsBuiltinToolApprovals).toBe(false);
    expect(adapter.supportsBuiltinToolFiltering).toBe(false);
  });

  test("compact is supported (goose summarization) and returns void", async () => {
    const adapter = makeAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        yield* session.compact();
      }),
    );
  });

  test("capability verbs can be refused honestly through the config", async () => {
    const adapter = makeGooseHarnessAdapter({
      gooseHome: ISOLATED_HOME,
      supportsCompact: false,
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.compact().pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.CapabilityUnsupported",
      capability: "compact",
    });
  });
});

describe("goose usage and failure mapping", () => {
  test("usage maps onto the neutral KhalaRuntimeUsage; absent counters stay absent", () => {
    expect(
      gooseUsageUpdateToKhalaUsage(
        { type: "usage_update", inputTokens: 40, outputTokens: 12, totalTokens: 52 },
        "usage.goose.t1.0",
      ),
    ).toEqual({
      usageRef: "usage.goose.t1.0",
      inputTokens: 40,
      outputTokens: 12,
      totalTokens: 52,
    });
    expect(
      gooseUsageUpdateToKhalaUsage(
        { type: "usage_update", cacheReadTokens: 8, cacheWriteTokens: 3 },
        "usage.goose.t1.1",
      ),
    ).toEqual({
      usageRef: "usage.goose.t1.1",
      cacheReadInputTokens: 8,
      cacheWriteInputTokens: 3,
    });
  });

  test.each([
    ["credits_exhausted", "account_exhausted"],
    ["Provider quota reached", "account_exhausted"],
    ["429 rate limit exceeded", "account_rate_limited"],
    ["too many requests", "account_rate_limited"],
    ["401 unauthorized", "auth_required"],
    ["authentication failed", "auth_required"],
    ["stream disconnected", "unknown"],
  ] as const)("classifies %j as %s", (detail, expected) => {
    expect(gooseModelFailureClass(detail)).toBe(expected);
  });
});
