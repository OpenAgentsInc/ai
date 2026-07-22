import { Effect, Schema as S, Stream } from "effect";
import {
  RuntimeInteractionPayload,
  type KhalaRuntimeSource,
} from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import {
  CODEX_EXEC_CONTINUE_PROMPT,
  classifyCodexFailureClass,
  codexApprovalToRuntimeInteractionPayload,
  codexEventToKhalaEvents,
  codexToolCallId,
  CodexTransportError,
  makeCodexHarnessAdapter,
  type CodexProjectionContext,
} from "./codex-adapter.ts";
import {
  codexAppServerTurnScript,
  codexExecTurnScript,
  makeScriptedCodexAppServerTransport,
  makeScriptedCodexExecSpawner,
} from "./codex-adapter-fixtures.ts";
import type { HarnessStreamEvent } from "./stream.ts";

const SOURCE: KhalaRuntimeSource = { lane: "codex_app_server", adapterKind: "codex" };

const ISOLATED_HOME = "/tmp/pylon-home/accounts/codex/account-1";
const BINARY = "/usr/local/bin/codex";

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);
const kinds = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.kind);

const decodeRuntimeInteractionPayload = S.decodeUnknownSync(RuntimeInteractionPayload);

const makeCtx = (): CodexProjectionContext => {
  let seq = 0;
  return {
    source: SOURCE,
    threadId: "s1",
    turnId: "t1",
    nextSequence: () => seq++,
    toolIdentities: new Map(),
    deltaStreamedItems: new Set(),
    pendingApprovals: new Map(),
    usageBox: { value: undefined },
    threadBox: { value: undefined },
  };
};

const makeAppServerAdapter = (options?: {
  readonly transportOptions?: Parameters<typeof makeScriptedCodexAppServerTransport>[0];
}) => {
  const scripted = makeScriptedCodexAppServerTransport(options?.transportOptions);
  const adapter = makeCodexHarnessAdapter({
    mode: "app-server",
    codexBinaryPath: BINARY,
    codexHome: ISOLATED_HOME,
    workingDirectory: "/tmp/workspace",
    model: "gpt-5.6-sol",
    transport: scripted.transport,
  });
  return { adapter, scripted };
};

const makeExecAdapter = (options?: {
  readonly spawnerOptions?: Parameters<typeof makeScriptedCodexExecSpawner>[0];
}) => {
  const scripted = makeScriptedCodexExecSpawner(options?.spawnerOptions);
  const adapter = makeCodexHarnessAdapter({
    mode: "exec",
    codexBinaryPath: BINARY,
    codexHome: ISOLATED_HOME,
    workingDirectory: "/tmp/workspace",
    model: "gpt-5.6-sol",
    spawner: scripted.spawner,
  });
  return { adapter, scripted };
};

describe("codex projection — neutral event mapping", () => {
  test("the representative app-server turn projects onto a contiguous stream", () => {
    const ctx = makeCtx();
    const events = codexAppServerTurnScript.flatMap((event) => codexEventToKhalaEvents(event, ctx));

    expect(kinds(events)).toEqual([
      "turn.started",
      "reasoning.delta",
      "text.delta",
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
      "file.change",
      "text.delta",
      "turn.finished",
    ]);
    // Sequences are contiguous with no gap and no duplicate; the approval
    // request and token-usage update consumed no sequence.
    expect(sequences(events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // token_usage.updated carried the exact usage onto turn.finished.
    expect(events.at(-1)).toMatchObject({
      kind: "turn.finished",
      finishReason: "stop",
      usage: {
        inputTokens: 40,
        outputTokens: 12,
        reasoningTokens: 5,
        cacheReadInputTokens: 10,
        totalTokens: 57,
      },
    });
  });

  test("the exec turn carries inline usage and captures the thread id", () => {
    const ctx = makeCtx();
    const events = codexExecTurnScript.flatMap((event) => codexEventToKhalaEvents(event, ctx));

    expect(kinds(events)).toEqual([
      "turn.started",
      "reasoning.delta",
      "tool.call",
      "tool.result",
      "text.delta",
      "turn.finished",
    ]);
    expect(sequences(events)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ctx.threadBox.value).toBe("thread_exec_1");
    expect(events.at(-1)).toMatchObject({
      kind: "turn.finished",
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 3, totalTokens: 31 },
    });
  });

  test("an exec completion-only command synthesizes a correlated call/result pair", () => {
    const ctx = makeCtx();
    const events = codexEventToKhalaEvents(
      {
        type: "item.completed",
        item: {
          itemType: "command_execution",
          id: "call_9",
          commandDisplay: "ls",
          status: "completed",
          exitCode: 0,
        },
      },
      ctx,
    );
    expect(kinds(events)).toEqual(["tool.call", "tool.result"]);
    // Both events carry the SAME toolCallId — the correlation contract.
    expect(events[0]).toMatchObject({ toolCallId: codexToolCallId("call_9"), toolName: "bash" });
    expect(events[1]).toMatchObject({
      toolCallId: codexToolCallId("call_9"),
      toolName: "bash",
      providerExecuted: true,
    });
  });

  test("a failed command projects tool.error with a bounded safe message", () => {
    const ctx = makeCtx();
    const events = codexEventToKhalaEvents(
      {
        type: "item.completed",
        item: {
          itemType: "command_execution",
          id: "call_2",
          commandDisplay: "false",
          status: "failed",
          exitCode: 1,
        },
      },
      ctx,
    );
    expect(kinds(events)).toEqual(["tool.call", "tool.error"]);
    expect(events[1]).toMatchObject({
      kind: "tool.error",
      toolName: "bash",
      messageSafe: "Codex bash exited with code 1",
    });
  });

  test("tool names normalize onto the shared common vocabulary", () => {
    const ctx = makeCtx();
    const patch = codexEventToKhalaEvents(
      {
        type: "item.completed",
        item: {
          itemType: "file_change",
          id: "p1",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "add" }],
        },
      },
      ctx,
    );
    // apply_patch -> common "edit"; the change also lands as file.change.
    expect(patch[0]).toMatchObject({ kind: "tool.call", toolName: "edit" });
    expect(patch[2]).toMatchObject({
      kind: "file.change",
      fileChange: { op: "created", pathRef: "path.src-a.ts" },
    });

    const search = codexEventToKhalaEvents(
      { type: "item.completed", item: { itemType: "web_search", id: "w1", status: "completed" } },
      ctx,
    );
    expect(search[0]).toMatchObject({ kind: "tool.call", toolName: "webSearch" });

    const mcp = codexEventToKhalaEvents(
      {
        type: "item.completed",
        item: {
          itemType: "mcp_tool_call",
          id: "m1",
          serverName: "openagents",
          toolName: "fleet_status",
          status: "completed",
        },
      },
      ctx,
    );
    // An MCP tool has no common equivalent; the composed native name is kept.
    expect(mcp[0]).toMatchObject({ kind: "tool.call", toolName: "openagents.fleet_status" });
  });

  test("delta-streamed text is not echoed again by the completed item", () => {
    const ctx = makeCtx();
    const delta = codexEventToKhalaEvents(
      { type: "agent_message.delta", itemId: "m1", delta: "Hello" },
      ctx,
    );
    expect(delta).toHaveLength(1);
    const completed = codexEventToKhalaEvents(
      { type: "item.completed", item: { itemType: "agent_message", id: "m1", text: "Hello" } },
      ctx,
    );
    expect(completed).toEqual([]);
  });

  test("retryable errors project to nothing; terminal errors finish the turn", () => {
    const ctx = makeCtx();
    expect(
      codexEventToKhalaEvents({ type: "error", messageSafe: "transient", willRetry: true }, ctx),
    ).toEqual([]);
    const terminal = codexEventToKhalaEvents(
      { type: "turn.failed", messageSafe: "stream error" },
      ctx,
    );
    expect(terminal[0]).toMatchObject({ kind: "turn.finished", finishReason: "error" });
  });

  test("an interrupted turn projects finishReason interrupted", () => {
    const ctx = makeCtx();
    const events = codexEventToKhalaEvents({ type: "turn.completed", status: "interrupted" }, ctx);
    expect(events[0]).toMatchObject({ kind: "turn.finished", finishReason: "interrupted" });
  });
});

describe("codex approvals — RuntimeInteraction routing", () => {
  test("an approval request produces a valid tool_approval RuntimeInteractionPayload", () => {
    const payload = codexApprovalToRuntimeInteractionPayload({
      type: "approval.requested",
      requestId: "rpc_1",
      callId: "call_1",
      toolKind: "exec_command",
    });
    const decoded = decodeRuntimeInteractionPayload(payload);
    expect(decoded).toMatchObject({
      kind: "tool_approval",
      toolName: "bash",
      toolCallId: codexToolCallId("call_1"),
      authority: {
        status: "operator_escalation_required",
        allowed: false,
        blockerRefs: ["blocker.owner_approval"],
      },
    });
  });

  test("an apply_patch approval maps onto the shared edit vocabulary", () => {
    const payload = codexApprovalToRuntimeInteractionPayload({
      type: "approval.requested",
      requestId: "rpc_2",
      callId: "patch_1",
      toolKind: "apply_patch",
    });
    expect(decodeRuntimeInteractionPayload(payload)).toMatchObject({
      kind: "tool_approval",
      toolName: "edit",
    });
  });

  test("app-server submitToolApproval answers the pending JSON-RPC request", async () => {
    const { adapter, scripted } = makeAppServerAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        yield* control.submitToolApproval(codexToolCallId("call_1"), "allow-once");
      }),
    );
    expect(scripted.approvalResponses).toEqual([{ requestId: "rpc_41", decision: "approved" }]);
  });

  test("approval decisions map onto the app-server ReviewDecision vocabulary", async () => {
    const { adapter, scripted } = makeAppServerAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        yield* control.submitToolApproval(codexToolCallId("call_1"), "deny");
      }),
    );
    expect(scripted.approvalResponses).toEqual([{ requestId: "rpc_41", decision: "denied" }]);
  });

  test("an unknown toolCallId fails with no_active_tool_call", async () => {
    const { adapter } = makeAppServerAdapter();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* control
          .submitToolApproval("toolcall.codex.nope", "allow-once")
          .pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({ failureClass: "no_active_tool_call" });
  });

  test("exec mode refuses approvals with a typed capability error", async () => {
    const { adapter } = makeExecAdapter();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        return yield* control
          .submitToolApproval(codexToolCallId("call_1"), "allow-once")
          .pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.CapabilityUnsupported",
      capability: "builtin_tool_approvals",
    });
  });
});

describe("codex app-server mode — turn lifecycle and lossless suspend/continue", () => {
  test("a full turn streams turn.started -> ... -> turn.finished with contiguous sequences", async () => {
    const { adapter, scripted } = makeAppServerAdapter();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );

    expect(result.events[0]?.kind).toBe("turn.started");
    expect(result.events.at(-1)?.kind).toBe("turn.finished");
    expect(sequences(result.events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(9);
    // The transport saw one thread start and one turn with the prompt.
    expect(scripted.startThreadCalls).toHaveLength(1);
    expect(scripted.startThreadCalls[0]).toMatchObject({ codexHome: ISOLATED_HOME });
    expect(scripted.runTurnCalls).toEqual([{ threadId: "thread_app_1", prompt: "hi" }]);
  });

  test("suspend then continue replays from cursor+1 with no gap and no duplicate", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { adapter } = makeAppServerAdapter();

        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(3)));
        const continuation = yield* session.suspendTurn();

        // A FRESH session (different process) resumes from the exact cursor.
        const { adapter: adapter2 } = makeAppServerAdapter();
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
    // App-server continuation is LOSSLESS.
    expect(outcome.continuation.lossy).toBe(false);
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(merged).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(merged).size).toBe(merged.length);
  });

  test("detach exports the Codex thread id and resume re-attaches to it", async () => {
    const { adapter, scripted } = makeAppServerAdapter();
    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const resumeState = yield* session.detach();

        const { adapter: adapter2, scripted: scripted2 } = makeAppServerAdapter();
        const session2 = yield* adapter2.start({
          sessionId: "s1",
          source: SOURCE,
          resumeFrom: resumeState,
        });
        return { resumeState, session2, scripted2 };
      }),
    );
    expect(resumed.resumeState.data).toEqual({ threadId: "thread_app_1" });
    expect(resumed.session2.isResume).toBe(true);
    // thread/resume was requested with the exported thread id.
    expect(resumed.scripted2.startThreadCalls[0]).toMatchObject({
      resumeThreadId: "thread_app_1",
    });
    expect(scripted.startThreadCalls).toHaveLength(1);
  });

  test("interrupt routes turn/interrupt to the transport with both identities", async () => {
    const { adapter, scripted } = makeAppServerAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* control.interrupt();
      }),
    );
    expect(scripted.interrupts).toEqual([{ threadId: "thread_app_1", turnId: "t1" }]);
  });

  test("a transport failure surfaces its operator-facing failure class", async () => {
    const { adapter } = makeAppServerAdapter({
      transportOptions: {
        runTurnFailure: new CodexTransportError({
          failureClass: "account_exhausted",
          detail: "usage limit reached",
        }),
      },
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.promptTurn({ turnId: "t1", prompt: "hi" }).pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.TurnError",
      failureClass: "account_exhausted",
      detail: "usage limit reached",
    });
  });
});

describe("codex exec mode — degraded suspend/continue and thread resume", () => {
  test("turns spawn per turn and resume through the captured thread id", async () => {
    const { adapter, scripted } = makeExecAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control1 = yield* session.promptTurn({ turnId: "t1", prompt: "first" });
        yield* collect(control1.events);
        const control2 = yield* session.promptTurn({ turnId: "t2", prompt: "second" });
        yield* collect(control2.events);
      }),
    );
    expect(scripted.spawns).toHaveLength(2);
    // First turn: fresh spawn with the injected isolated config, no resume.
    expect(scripted.spawns[0]).toMatchObject({
      codexBinaryPath: BINARY,
      codexHome: ISOLATED_HOME,
      workingDirectory: "/tmp/workspace",
      model: "gpt-5.6-sol",
      prompt: "first",
    });
    expect(scripted.spawns[0]?.resumeThreadId).toBeUndefined();
    // Second turn resumes the thread captured from thread.started.
    expect(scripted.spawns[1]).toMatchObject({
      prompt: "second",
      resumeThreadId: "thread_exec_1",
    });
  });

  test("session instructions apply once, on the first turn of a fresh session", async () => {
    const { adapter, scripted } = makeExecAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const c1 = yield* session.promptTurn({
          turnId: "t1",
          prompt: "first",
          instructions: "Be terse.",
        });
        yield* collect(c1.events);
        const c2 = yield* session.promptTurn({
          turnId: "t2",
          prompt: "second",
          instructions: "Be terse.",
        });
        yield* collect(c2.events);
      }),
    );
    expect(scripted.spawns[0]?.prompt).toBe("Be terse.\n\nfirst");
    expect(scripted.spawns[1]?.prompt).toBe("second");
  });

  test("suspend is honestly lossy and continue re-drives the thread as a recomputed tail", async () => {
    const rerunScript = [
      {
        type: "item.completed",
        item: { itemType: "agent_message", id: "item_m2", text: "Resumed and finished." },
      },
      {
        type: "turn.completed",
        status: "completed",
        usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      },
    ] as const;
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { adapter } = makeExecAdapter();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(2)));
        const continuation = yield* session.suspendTurn();

        // A FRESH session in a new process re-drives the turn via exec resume.
        const { adapter: adapter2, scripted: scripted2 } = makeExecAdapter({
          spawnerOptions: { spawnScripts: [rerunScript] },
        });
        const session2 = yield* adapter2.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* collect(control2.events);
        return { phase1, continuation, phase2, spawns: scripted2.spawns };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1]);
    expect(outcome.continuation.cursor).toBe(1);
    // Exec continuation is an HONEST DEGRADED RERUN.
    expect(outcome.continuation.lossy).toBe(true);
    expect(outcome.continuation.data).toMatchObject({ threadId: "thread_exec_1" });
    // The continuation resumed the SAME Codex thread with the continue prompt.
    expect(outcome.spawns).toEqual([
      expect.objectContaining({
        resumeThreadId: "thread_exec_1",
        prompt: CODEX_EXEC_CONTINUE_PROMPT,
      }),
    ]);
    // The recomputed tail attaches at cursor + 1 with contiguous sequences.
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    expect(sequences(outcome.phase2)).toEqual([2, 3]);
    expect(kinds(outcome.phase2)).toEqual(["text.delta", "turn.finished"]);
  });

  test("a spawner failure surfaces its operator-facing failure class", async () => {
    const { adapter } = makeExecAdapter({
      spawnerOptions: {
        failure: new CodexTransportError({
          failureClass: "account_rate_limited",
          detail: "429 too many requests",
        }),
      },
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.promptTurn({ turnId: "t1", prompt: "hi" }).pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.TurnError",
      failureClass: "account_rate_limited",
    });
  });

  test("mid-turn user messages are refused honestly in exec mode", async () => {
    const { adapter } = makeExecAdapter();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        return yield* control.submitUserMessage("also do this").pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({ failureClass: "user_message_injection_unsupported" });
  });
});

describe("codex adapter — CODEX_HOME selection", () => {
  test.each(["", "~/.codex", "/Users/owner/.codex", "/home/user/.codex/"])(
    "default-home shaped codexHome %j selects owner-local mode (CODEX_HOME unset)",
    async (codexHome) => {
      const { transport, startThreadCalls } = makeScriptedCodexAppServerTransport();
      const adapter = makeCodexHarnessAdapter({
        mode: "app-server",
        codexBinaryPath: BINARY,
        codexHome,
        transport,
      });
      const session = await Effect.runPromise(adapter.start({ sessionId: "s1", source: SOURCE }));
      expect(session.sessionId).toBe("s1");
      expect(startThreadCalls[0]?.codexHome).toBeUndefined();
    },
  );

  test("omitted codexHome selects owner-local mode", async () => {
    const { transport, startThreadCalls } = makeScriptedCodexAppServerTransport();
    const adapter = makeCodexHarnessAdapter({
      mode: "app-server",
      codexBinaryPath: BINARY,
      transport,
    });
    const session = await Effect.runPromise(adapter.start({ sessionId: "s1", source: SOURCE }));
    expect(session.sessionId).toBe("s1");
    expect(startThreadCalls[0]?.codexHome).toBeUndefined();
  });

  test("an isolated account home is passed through unchanged", async () => {
    const { adapter } = makeExecAdapter();
    const session = await Effect.runPromise(adapter.start({ sessionId: "s1", source: SOURCE }));
    expect(session.sessionId).toBe("s1");
  });
});

describe("codex adapter — identity and capability posture", () => {
  test("both modes report the codex harness/adapter kind and built-in tools", () => {
    const { adapter: appServer } = makeAppServerAdapter();
    const { adapter: exec } = makeExecAdapter();
    for (const adapter of [appServer, exec]) {
      expect(adapter.harnessId).toBe("codex");
      expect(adapter.harnessKind).toBe("codex");
      expect(adapter.adapterKind).toBe("codex");
      expect(adapter.builtinTools.map((tool) => tool.nativeName)).toEqual([
        "shell",
        "apply_patch",
        "web_search",
      ]);
      expect(adapter.supportsBuiltinToolFiltering).toBe(false);
    }
    // Approvals are honest per mode: native in app-server, refused in exec.
    expect(appServer.supportsBuiltinToolApprovals).toBe(true);
    expect(exec.supportsBuiltinToolApprovals).toBe(false);
  });

  test("compact is refused with a typed capability error in both modes", async () => {
    for (const { adapter } of [makeAppServerAdapter(), makeExecAdapter()]) {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
          return yield* session.compact().pipe(Effect.flip);
        }),
      );
      expect(error).toMatchObject({ capability: "compact" });
    }
  });

  test("app-server steer routes through the optional turn/steer seam", async () => {
    const { adapter, scripted } = makeAppServerAdapter({
      transportOptions: { withSteer: true },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* control.submitUserMessage("also check the tests");
      }),
    );
    expect(scripted.steered).toEqual([{ threadId: "thread_app_1", text: "also check the tests" }]);
  });

  test("stop shuts the supervised app-server down and exports resume state", async () => {
    const { adapter, scripted } = makeAppServerAdapter();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.stop();
      }),
    );
    expect(state.data).toEqual({ threadId: "thread_app_1" });
    expect(scripted.shutdowns.count).toBe(1);
  });
});

describe("codex failure classification (ported keyword rules)", () => {
  test.each([
    ["401 unauthorized", "account_reconnect_required"],
    ["denied by policy", "policy_denied"],
    ["usage limit reached, purchase more credits", "account_exhausted"],
    ["429 too many requests", "account_rate_limited"],
    ["stream disconnected", "execution_failed"],
  ] as const)("classifies %j as %s", (detail, expected) => {
    expect(classifyCodexFailureClass(detail)).toBe(expected);
  });
});
