import { Effect, Stream } from "effect";
import type {
  KhalaRuntimeSource,
  RuntimeInteractionPayload,
} from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import {
  makePiHarnessAdapter,
  PI_BUILTIN_TOOL_NAMES,
  piEventToKhalaEvents,
  piFailureClassForPromptError,
  type PiCreateSessionOptions,
  type PiProjectionContext,
  type PiSessionEvent,
  type PiSessionFactory,
  type PiSessionStats,
  type PiSessionSurface,
  piToolApprovalInteractionPayload,
} from "./pi-adapter.ts";
import type { HarnessStreamEvent } from "./stream.ts";

// Pi is an in-process host adapter: the runtime lives inside the OpenAgents
// host process, so its events ride the native in-process lane.
const SOURCE: KhalaRuntimeSource = { lane: "ai_sdk_core", adapterKind: "openagents_native" };

const ISOLATED_AGENT_DIR = "/tmp/pylon/accounts/pi/acct-1/agent";

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);
const kinds = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.kind);

// ---------------------------------------------------------------------------
// Scripted fixture seam: a fake Pi session factory that emulates the audited
// Pi lifecycle — subscribe listeners, a prompt loop that gates every tool call
// through `beforeToolCall`, custom-tool execution through the bridged
// definitions, abort semantics, and the JSONL session-file resume artifact.
// ---------------------------------------------------------------------------

type ScriptStep =
  | { readonly kind: "emit"; readonly event: PiSessionEvent }
  | { readonly kind: "hostTool"; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: "builtinTool"; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: "gate" };

const textDelta = (delta: string): PiSessionEvent => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});

const thinkingDelta = (delta: string): PiSessionEvent => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta },
});

const doneEvent = (reason: "stop" | "length" | "toolUse"): PiSessionEvent => ({
  type: "message_update",
  assistantMessageEvent: { type: "done", reason },
});

interface FakePi {
  readonly factory: PiSessionFactory;
  readonly created: Array<PiCreateSessionOptions>;
  readonly prompts: Array<string>;
  readonly steered: Array<string>;
  readonly compacted: Array<string | undefined>;
  aborts: number;
  disposed: number;
}

const makeFakePi = (
  options: {
    readonly script?: (promptText: string) => ReadonlyArray<ScriptStep>;
    readonly promptFailure?: unknown;
    readonly sessionFile?: string;
    readonly stats?: PiSessionStats;
  } = {},
): FakePi => {
  const created: Array<PiCreateSessionOptions> = [];
  const prompts: Array<string> = [];
  const steered: Array<string> = [];
  const compacted: Array<string | undefined> = [];
  const script =
    options.script ??
    (() => [
      { kind: "emit", event: textDelta("Hello ") } as const,
      { kind: "emit", event: textDelta("world") } as const,
      { kind: "emit", event: doneEvent("stop") } as const,
    ]);

  const fake: FakePi = {
    created,
    prompts,
    steered,
    compacted,
    aborts: 0,
    disposed: 0,
    factory: async (createOptions) => {
      created.push(createOptions);
      const listeners = new Set<(event: PiSessionEvent) => void>();
      let aborted = false;
      let releaseGate: (() => void) | undefined;
      const emit = (event: PiSessionEvent): void => {
        for (const listener of listeners) listener(event);
      };
      const surface: PiSessionSurface = {
        ...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        prompt: async (text) => {
          prompts.push(text);
          if (options.promptFailure !== undefined) throw options.promptFailure;
          aborted = false;
          emit({ type: "agent_start" });
          for (const step of script(text)) {
            if (aborted) break;
            if (step.kind === "emit") {
              emit(step.event);
              continue;
            }
            if (step.kind === "gate") {
              await new Promise<void>((resolve) => {
                releaseGate = resolve;
              });
              continue;
            }
            const decision = (await created
              .at(-1)!
              .beforeToolCall?.({ toolCallId: step.toolCallId, toolName: step.toolName })) ?? {
              allow: true,
            };
            if (aborted) break;
            emit({
              type: "tool_execution_start",
              toolCallId: step.toolCallId,
              toolName: step.toolName,
            });
            if (!decision.allow) {
              emit({
                type: "tool_execution_end",
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                isError: true,
                messageSafe: decision.reason,
              });
              continue;
            }
            if (step.kind === "hostTool") {
              const tool = created.at(-1)!.customTools?.find((t) => t.name === step.toolName);
              const result = await tool!.execute(step.toolCallId, {});
              emit({
                type: "tool_execution_end",
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                isError: result.isError === true,
              });
            } else {
              emit({
                type: "tool_execution_end",
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                isError: false,
              });
            }
          }
          if (aborted) {
            emit({
              type: "message_update",
              assistantMessageEvent: { type: "error", reason: "aborted" },
            });
          }
          emit({ type: "agent_end" });
        },
        steer: async (text) => {
          steered.push(text);
        },
        abort: async () => {
          aborted = true;
          fake.aborts += 1;
          releaseGate?.();
        },
        compact: async (customInstructions) => {
          compacted.push(customInstructions);
        },
        getSessionStats: () => options.stats,
        dispose: () => {
          fake.disposed += 1;
        },
      };
      return surface;
    },
  };
  return fake;
};

const makeAdapter = (
  fake: FakePi,
  extra: {
    readonly agentDir?: string;
    readonly locateSessionFile?: (sessionId: string) => string | undefined;
    readonly onApprovalRequest?: (payload: RuntimeInteractionPayload) => void;
  } = {},
) =>
  makePiHarnessAdapter({
    createSession: fake.factory,
    agentDir: extra.agentDir ?? ISOLATED_AGENT_DIR,
    ...(extra.locateSessionFile === undefined
      ? {}
      : { locateSessionFile: extra.locateSessionFile }),
    ...(extra.onApprovalRequest === undefined
      ? {}
      : { onApprovalRequest: extra.onApprovalRequest }),
  });

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

const makeCtx = (): PiProjectionContext => {
  let seq = 0;
  return {
    source: SOURCE,
    threadId: "s1",
    turnId: "t1",
    nextSequence: () => seq++,
    toolNames: new Map<string, string>(),
    hostToolNames: new Set<string>(),
    stopReason: undefined,
  };
};

describe("pi projection — neutral event mapping", () => {
  test("text and thinking deltas project onto text.delta / reasoning.delta", () => {
    const ctx = makeCtx();
    const text = piEventToKhalaEvents(textDelta("hi"), ctx);
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ kind: "text.delta", text: "hi" });
    const thinking = piEventToKhalaEvents(thinkingDelta("plan"), ctx);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ kind: "reasoning.delta", text: "plan" });
  });

  test("text_end / thinking_end project onto the completed events", () => {
    const ctx = makeCtx();
    const textEnd = piEventToKhalaEvents(
      { type: "message_update", assistantMessageEvent: { type: "text_end" } },
      ctx,
    );
    expect(textEnd[0]).toMatchObject({ kind: "text.completed" });
    const thinkingEnd = piEventToKhalaEvents(
      { type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
      ctx,
    );
    expect(thinkingEnd[0]).toMatchObject({ kind: "reasoning.completed" });
  });

  test("the nested done event records the stop reason and emits nothing", () => {
    const ctx = makeCtx();
    expect(piEventToKhalaEvents(doneEvent("toolUse"), ctx)).toEqual([]);
    expect(ctx.stopReason).toBe("toolUse");
    // agent_end then carries the mapped finish reason.
    const finished = piEventToKhalaEvents({ type: "agent_end" }, ctx);
    expect(finished.at(-1)).toMatchObject({ kind: "turn.finished", finishReason: "tool-calls" });
  });

  test("tool execution start/end correlate ids and normalize find to glob", () => {
    const ctx = makeCtx();
    const call = piEventToKhalaEvents(
      { type: "tool_execution_start", toolCallId: "c1", toolName: "find" },
      ctx,
    );
    expect(call[0]).toMatchObject({
      kind: "tool.call",
      toolCallId: "c1",
      toolName: "glob",
      authority: { status: "allowed", allowed: true },
    });
    // The end event correlates the tool name recorded at start.
    const end = piEventToKhalaEvents(
      { type: "tool_execution_end", toolCallId: "c1", toolName: "find", isError: false },
      ctx,
    );
    expect(end[0]).toMatchObject({
      kind: "tool.result",
      toolCallId: "c1",
      toolName: "glob",
      providerExecuted: true,
    });
  });

  test("a failed tool execution projects onto tool.error with the safe message", () => {
    const ctx = makeCtx();
    piEventToKhalaEvents({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash" }, ctx);
    const end = piEventToKhalaEvents(
      {
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "bash",
        isError: true,
        messageSafe: "command failed",
      },
      ctx,
    );
    expect(end[0]).toMatchObject({
      kind: "tool.error",
      toolName: "bash",
      messageSafe: "command failed",
    });
  });

  test("host-bridged tools project with providerExecuted false", () => {
    const ctx: PiProjectionContext = { ...makeCtx(), hostToolNames: new Set(["history_recall"]) };
    const call = piEventToKhalaEvents(
      { type: "tool_execution_start", toolCallId: "c3", toolName: "history_recall" },
      ctx,
    );
    expect(call[0]).toMatchObject({ kind: "tool.call", toolName: "history_recall" });
    const end = piEventToKhalaEvents(
      { type: "tool_execution_end", toolCallId: "c3", toolName: "history_recall", isError: false },
      ctx,
    );
    expect(end[0]).toMatchObject({ kind: "tool.result", providerExecuted: false });
  });

  test("agent_end synthesizes usage.recorded from session stats before turn.finished", () => {
    const ctx: PiProjectionContext = {
      ...makeCtx(),
      sessionStats: () => ({ tokens: { input: 20, output: 8, cacheRead: 3, cacheWrite: 1 } }),
    };
    ctx.stopReason = "stop";
    const events = piEventToKhalaEvents({ type: "agent_end" }, ctx);
    expect(kinds(events)).toEqual(["usage.recorded", "turn.finished"]);
    expect(events[0]).toMatchObject({
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 1,
        totalTokens: 28,
      },
    });
    expect(events[1]).toMatchObject({ kind: "turn.finished", finishReason: "stop" });
  });

  test("ignored and unknown Pi kinds project to no neutral event", () => {
    const ctx = makeCtx();
    expect(piEventToKhalaEvents({ type: "turn_start" }, ctx)).toEqual([]);
    expect(piEventToKhalaEvents({ type: "tool_execution_update" }, ctx)).toEqual([]);
    // Pi has no wire schema: a future unknown kind must never fail the stream.
    expect(
      piEventToKhalaEvents({ type: "session_info_changed" } as unknown as PiSessionEvent, ctx),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Turn lifecycle through the adapter
// ---------------------------------------------------------------------------

describe("pi adapter — turn lifecycle", () => {
  test("a full turn streams turn.started -> deltas -> usage -> turn.finished contiguously", async () => {
    const fake = makeFakePi({
      script: () => [
        { kind: "emit", event: thinkingDelta("plan") },
        { kind: "emit", event: textDelta("Hello ") },
        { kind: "emit", event: textDelta("world") },
        { kind: "emit", event: doneEvent("stop") },
      ],
      stats: { tokens: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0 } },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );

    expect(kinds(result.events)).toEqual([
      "turn.started",
      "reasoning.delta",
      "text.delta",
      "text.delta",
      "usage.recorded",
      "turn.finished",
    ]);
    expect(sequences(result.events)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(5);
    expect(result.done.usage).toMatchObject({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    expect(fake.prompts).toEqual(["hi"]);
  });

  test("instructions prepend exactly once on a fresh session", async () => {
    const fake = makeFakePi();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const first = yield* session.promptTurn({
          turnId: "t1",
          prompt: "hi",
          instructions: "SYSTEM",
        });
        yield* collect(first.events);
        const second = yield* session.promptTurn({
          turnId: "t2",
          prompt: "again",
          instructions: "SYSTEM",
        });
        yield* collect(second.events);
      }),
    );
    expect(fake.prompts).toEqual(["SYSTEM\n\nhi", "again"]);
  });

  test("submitUserMessage steers the running Pi session", async () => {
    const fake = makeFakePi();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        yield* control.submitUserMessage("also check the tests");
        yield* collect(control.events);
      }),
    );
    expect(fake.steered).toEqual(["also check the tests"]);
  });

  test("compact passes through to the native Pi compaction", async () => {
    const fake = makeFakePi();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "go" });
        yield* collect(control.events);
        yield* session.compact("keep the decisions");
      }),
    );
    expect(fake.compacted).toEqual(["keep the decisions"]);
  });
});

// ---------------------------------------------------------------------------
// Host tools and approvals
// ---------------------------------------------------------------------------

describe("pi adapter — host tools and approvals", () => {
  test("host tools bridge through customTools and resolve via submitToolResult", async () => {
    const fake = makeFakePi({
      script: () => [
        { kind: "hostTool", toolCallId: "call-1", toolName: "history_recall" },
        { kind: "emit", event: textDelta("done") },
        { kind: "emit", event: doneEvent("stop") },
      ],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({
          turnId: "t1",
          prompt: "recall",
          tools: [
            {
              name: "history_recall",
              description: "recall history",
              inputJsonSchema: { type: "object" },
            },
          ],
        });
        // React to the tool.call from inside the single stream consumer.
        return yield* collect(
          control.events.pipe(
            Stream.tap((event) =>
              event.kind === "tool.call"
                ? control.submitToolResult({
                    toolCallId: event.toolCallId,
                    output: { spans: [] },
                  })
                : Effect.void,
            ),
          ),
        );
      }),
    );

    expect(kinds(events)).toEqual([
      "turn.started",
      "tool.call",
      "tool.result",
      "text.delta",
      "turn.finished",
    ]);
    const call = events[1];
    expect(call).toMatchObject({ kind: "tool.call", toolName: "history_recall" });
    // The bridged Pi custom tool carries the wire spec verbatim.
    const bridged = fake.created[0]?.customTools?.[0];
    expect(bridged?.name).toBe("history_recall");
    expect(bridged?.parameters).toEqual({ type: "object" });
    expect(events[2]).toMatchObject({ kind: "tool.result", providerExecuted: false });
  });

  test("default permission mode parks built-in calls on the RuntimeInteraction seam", async () => {
    const payloads: Array<RuntimeInteractionPayload> = [];
    const fake = makeFakePi({
      script: () => [
        { kind: "builtinTool", toolCallId: "call-2", toolName: "bash" },
        { kind: "emit", event: doneEvent("stop") },
      ],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake, { onApprovalRequest: (p) => payloads.push(p) });
        const session = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          permissionMode: "default",
        });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "run it" });
        // The gate parked the call and surfaced a canonical approval payload.
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          kind: "tool_approval",
          toolCallId: "call-2",
          toolName: "bash",
          authority: { status: "operator_escalation_required", allowed: false },
        });
        yield* control.submitToolApproval("call-2", "allow-once");
        return yield* collect(control.events);
      }),
    );
    expect(kinds(events)).toEqual(["turn.started", "tool.call", "tool.result", "turn.finished"]);
  });

  test("reject-all denies built-ins through the approval path and projects tool.error", async () => {
    const payloads: Array<RuntimeInteractionPayload> = [];
    const fake = makeFakePi({
      script: () => [
        { kind: "builtinTool", toolCallId: "call-3", toolName: "bash" },
        { kind: "emit", event: doneEvent("stop") },
      ],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake, { onApprovalRequest: (p) => payloads.push(p) });
        const session = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          permissionMode: "reject-all",
        });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "run it" });
        return yield* collect(control.events);
      }),
    );
    expect(payloads).toHaveLength(1);
    expect(kinds(events)).toEqual(["turn.started", "tool.call", "tool.error", "turn.finished"]);
  });

  test("built-in filtering is native: the allowlist reaches the Pi factory and inactive calls auto-deny", async () => {
    const payloads: Array<RuntimeInteractionPayload> = [];
    const fake = makeFakePi({
      script: () => [
        { kind: "builtinTool", toolCallId: "call-4", toolName: "bash" },
        { kind: "emit", event: doneEvent("stop") },
      ],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake, { onApprovalRequest: (p) => payloads.push(p) });
        const session = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          builtinToolFiltering: { inactiveTools: ["bash"] },
        });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "run it" });
        return yield* collect(control.events);
      }),
    );
    // Native filtering: bash is excluded from the Pi `tools` allowlist.
    expect(fake.created[0]?.activeTools).toEqual(
      PI_BUILTIN_TOOL_NAMES.filter((name) => name !== "bash"),
    );
    // Drift guard: the call still refuses through the audited approval path.
    expect(payloads[0]).toMatchObject({
      kind: "tool_approval",
      authority: { blockerRefs: ["blocker.inactive_builtin_tool", "blocker.owner_approval"] },
    });
    expect(kinds(events)).toEqual(["turn.started", "tool.call", "tool.error", "turn.finished"]);
  });

  test("the approval payload builder normalizes tool names onto the common vocabulary", () => {
    const payload = piToolApprovalInteractionPayload({ toolCallId: "c9", toolName: "find" });
    expect(payload).toMatchObject({ kind: "tool_approval", toolName: "glob" });
  });
});

// ---------------------------------------------------------------------------
// Resume via the JSONL session tree
// ---------------------------------------------------------------------------

describe("pi adapter — resume via the JSONL session tree", () => {
  test("stop returns the session file and a fresh start reopens it", async () => {
    const fake1 = makeFakePi({ sessionFile: "sessions/s1.jsonl" });
    const fake2 = makeFakePi({ sessionFile: "sessions/s1.jsonl" });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter1 = makeAdapter(fake1);
        const session1 = yield* adapter1.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session1.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        const resume = yield* session1.stop();

        // A different process resumes from the persisted journal.
        const adapter2 = makeAdapter(fake2);
        const session2 = yield* adapter2.start({
          sessionId: "s1",
          source: SOURCE,
          resumeFrom: resume,
        });
        const control2 = yield* session2.promptTurn({
          turnId: "t2",
          prompt: "continue",
          instructions: "SYSTEM",
        });
        yield* collect(control2.events);
        return { resume, isResume: session2.isResume };
      }),
    );

    expect(outcome.resume).toMatchObject({
      harnessId: "pi",
      sessionId: "s1",
      data: { sessionFile: "sessions/s1.jsonl" },
    });
    expect(fake1.disposed).toBe(1);
    expect(outcome.isResume).toBe(true);
    // The restored session reopened the exact JSONL session-tree file...
    expect(fake2.created[0]?.sessionFile).toBe("sessions/s1.jsonl");
    // ...and instructions never re-apply on a resumed session.
    expect(fake2.prompts).toEqual(["continue"]);
  });

  test("the injected session locator resolves the journal when resume data lacks a file", async () => {
    const fake = makeFakePi();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake, {
          locateSessionFile: (sessionId) => `located/${sessionId}.jsonl`,
        });
        const session = yield* adapter.start({
          sessionId: "s7",
          source: SOURCE,
          resumeFrom: { harnessId: "pi", sessionId: "s7", data: {} },
        });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
      }),
    );
    expect(fake.created[0]?.sessionFile).toBe("located/s7.jsonl");
  });
});

// ---------------------------------------------------------------------------
// Suspend / continue: the honest degraded rerun
// ---------------------------------------------------------------------------

describe("pi adapter — suspend/continue rerun honesty", () => {
  test("suspend aborts the live turn and continuation re-drives from the journal, declared lossy", async () => {
    const fake1 = makeFakePi({
      sessionFile: "sessions/s1.jsonl",
      script: () => [
        { kind: "emit", event: textDelta("partial ") },
        { kind: "gate" },
        { kind: "emit", event: textDelta("never delivered") },
        { kind: "emit", event: doneEvent("stop") },
      ],
    });
    const fake2 = makeFakePi({
      sessionFile: "sessions/s1.jsonl",
      script: () => [
        { kind: "emit", event: textDelta("recomputed ") },
        { kind: "emit", event: textDelta("tail") },
        { kind: "emit", event: doneEvent("stop") },
      ],
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        // Phase 1: pull the delivered prefix, then suspend mid-turn.
        const adapter1 = makeAdapter(fake1);
        const session1 = yield* adapter1.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session1.promptTurn({ turnId: "t1", prompt: "do the work" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(2)));
        const continuation = yield* session1.suspendTurn();

        // Phase 2: a FRESH process restores the journal and re-drives.
        const adapter2 = makeAdapter(fake2);
        const session2 = yield* adapter2.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* collect(control2.events);
        const done2 = yield* control2.done;
        return { phase1, continuation, phase2, done2 };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1]);
    expect(fake1.aborts).toBe(1);

    // The continuation is HONEST about the rerun: lossy, cursor-pinned, and
    // carrying the journal ref plus the prompt to re-drive.
    expect(outcome.continuation.lossy).toBe(true);
    expect(outcome.continuation.cursor).toBe(1);
    expect(outcome.continuation.turnId).toBe("t1");
    expect(outcome.continuation.data).toMatchObject({
      turnId: "t1",
      promptText: "do the work",
      sessionFile: "sessions/s1.jsonl",
    });

    // The re-driven turn reopened the journal and re-ran the SAME prompt.
    expect(fake2.created[0]?.sessionFile).toBe("sessions/s1.jsonl");
    expect(fake2.prompts).toEqual(["do the work"]);

    // The recomputed tail attaches at cursor + 1 with no gap and no duplicate
    // sequence — while its CONTENT is recomputed, not replayed.
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(merged).toEqual([...merged].sort((a, b) => a - b));
    expect(new Set(merged).size).toBe(merged.length);
    expect(outcome.phase2.at(0)).toMatchObject({ kind: "turn.started" });
    expect(outcome.done2.finishReason).toBe("stop");
  });

  test("continueTurn without a suspended turn fails with no_turn_to_continue", async () => {
    const fake = makeFakePi();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.continueTurn({}).pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.TurnError",
      failureClass: "no_turn_to_continue",
    });
  });
});

// ---------------------------------------------------------------------------
// Error mapping and isolation guards
// ---------------------------------------------------------------------------

describe("pi adapter — error mapping", () => {
  test("a rejected prompt fails the stream and done with the shared failure class", async () => {
    const fake = makeFakePi({
      promptFailure: { reasonTag: "RateLimitError", messageSafe: "provider rate limited" },
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const streamError = yield* collect(control.events).pipe(Effect.flip);
        const doneError = yield* control.done.pipe(Effect.flip);
        return { streamError, doneError };
      }),
    );
    expect(outcome.streamError).toMatchObject({
      _tag: "AgentHarness.TurnError",
      failureClass: "account_rate_limited",
      detail: "provider rate limited",
    });
    expect(outcome.doneError).toMatchObject({ failureClass: "account_rate_limited" });
  });

  test("prompt failures classify through the shared model-failure vocabulary", () => {
    expect(piFailureClassForPromptError({ reasonTag: "RateLimitError" })).toBe(
      "account_rate_limited",
    );
    expect(piFailureClassForPromptError({ reasonTag: "QuotaExhaustedError" })).toBe(
      "account_exhausted",
    );
    expect(piFailureClassForPromptError({ reasonTag: "AuthenticationError" })).toBe(
      "auth_required",
    );
    // Untagged and unrecognized failures are honestly unknown.
    expect(piFailureClassForPromptError(new Error("boom"))).toBe("unknown");
    expect(piFailureClassForPromptError({ reasonTag: "SomethingNew" })).toBe("unknown");
  });

  test("an aborted turn finishes with the interrupted reason", async () => {
    const fake = makeFakePi({
      script: () => [{ kind: "emit", event: textDelta("partial") }, { kind: "gate" }],
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* control.interrupt();
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );
    expect(outcome.events.at(-1)).toMatchObject({
      kind: "turn.finished",
      finishReason: "interrupted",
    });
    expect(outcome.done.finishReason).toBe("interrupted");
  });

  test("start refuses the owner's live ~/.pi agent directory", async () => {
    const fake = makeFakePi();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake, { agentDir: "/Users/owner/.pi/agent" });
        return yield* adapter.start({ sessionId: "s1", source: SOURCE }).pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({
      _tag: "AgentHarness.StartError",
      failureClass: "unsafe_agent_dir",
    });
    expect(fake.created).toHaveLength(0);
  });

  test("a changed host-tool signature rebuilds the Pi session over the same journal", async () => {
    const fake = makeFakePi({ sessionFile: "sessions/s1.jsonl" });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeAdapter(fake);
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const first = yield* session.promptTurn({ turnId: "t1", prompt: "one" });
        yield* collect(first.events);
        const second = yield* session.promptTurn({
          turnId: "t2",
          prompt: "two",
          tools: [{ name: "history_recall", description: "recall", inputJsonSchema: {} }],
        });
        yield* collect(second.events);
      }),
    );
    expect(fake.created).toHaveLength(2);
    expect(fake.disposed).toBe(1);
    // The rebuilt session restores the SAME JSONL journal.
    expect(fake.created[1]?.sessionFile).toBe("sessions/s1.jsonl");
    expect(fake.created[1]?.customTools?.map((t) => t.name)).toEqual(["history_recall"]);
  });
});

// ---------------------------------------------------------------------------
// Identity and capability posture
// ---------------------------------------------------------------------------

describe("pi adapter — identity and capability posture", () => {
  test("the adapter reports the pi identity and honest capability table", () => {
    const adapter = makeAdapter(makeFakePi());
    expect(adapter.specificationVersion).toBe("agent-harness-v1");
    expect(adapter.harnessId).toBe("pi");
    expect(adapter.harnessKind).toBe("custom");
    expect(adapter.adapterKind).toBe("openagents_native");
    // Approvals are emulated (beforeToolCall gate), filtering is native.
    expect(adapter.supportsBuiltinToolApprovals).toBe(true);
    expect(adapter.supportsBuiltinToolFiltering).toBe(true);
    // Resume state is re-importable, so the lifecycle schema is present.
    expect(adapter.lifecycleStateSchema).toBeDefined();
    // No bootstrap: the owner-local lane imports the library in-process.
    expect(adapter.getBootstrap).toBeUndefined();
  });

  test("the built-in tool table carries the native seven with common names", () => {
    const adapter = makeAdapter(makeFakePi());
    expect(adapter.builtinTools.map((tool) => tool.nativeName)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    const find = adapter.builtinTools.find((tool) => tool.nativeName === "find");
    expect(find?.commonName).toBe("glob");
    const ls = adapter.builtinTools.find((tool) => tool.nativeName === "ls");
    expect(ls?.commonName).toBeUndefined();
  });
});
