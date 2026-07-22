import { Effect, Schema as S, Stream } from "effect";
import {
  RuntimeInteractionPayload,
  type KhalaRuntimeSource,
  type RuntimeInteractionDecision,
} from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import { HarnessStartError } from "./adapter.ts";
import { HarnessCapabilityUnsupported } from "./capability.ts";
import {
  CLAUDE_CODE_CONTINUATION_PROMPT,
  type ClaudeCodeMessage,
  type ClaudeCodeProjectionContext,
  type ClaudeCodeQuery,
  type ClaudeCodeQueryParams,
  claudeCodeFinishReason,
  claudeCodeMessageToKhalaEvents,
  claudeCodePermissionToRuntimeInteractionPayload,
  claudeCodeQuestionToRuntimeInteractionPayload,
  claudeCodeUsage,
  classifyClaudeCodeFailure,
  isLiveClaudeHome,
  makeClaudeCodeCanUseTool,
  makeClaudeCodeHarnessAdapter,
} from "./claude-code-adapter.ts";
import { HarnessTurnError } from "./session.ts";
import type { HarnessStreamEvent } from "./stream.ts";

// Claude Code is the owner-local Claude lane; the adapter reports adapterKind
// "claude_code" on the claude_pylon lane.
const SOURCE: KhalaRuntimeSource = { lane: "claude_pylon", adapterKind: "claude_code" };

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);
const kinds = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.kind);

const makeCtx = (): ClaudeCodeProjectionContext => {
  let seq = 0;
  return {
    source: SOURCE,
    threadId: "s1",
    turnId: "t1",
    nextSequence: () => seq++,
    toolNames: new Map<string, string>(),
    streamed: { text: false, thinking: false },
  };
};

const INIT: ClaudeCodeMessage = {
  type: "system",
  subtype: "init",
  session_id: "sess_claude_1",
  model: "claude-fable-5",
};

const streamText = (text: string): ClaudeCodeMessage => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

const streamThinking = (thinking: string): ClaudeCodeMessage => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
});

const RESULT: ClaudeCodeMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "sess_claude_1",
  usage: {
    input_tokens: 20,
    output_tokens: 8,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  },
};

// A representative SDK stream: init (identity, no event), thinking + text
// deltas, the complete assistant message (text deduped, tool_use projected),
// the tool result, and the terminal result with exact usage.
const REPRESENTATIVE_SCRIPT: ReadonlyArray<ClaudeCodeMessage> = [
  INIT,
  streamThinking("plan"),
  streamText("Hello "),
  streamText("world"),
  {
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        { type: "text", text: "Hello world" },
        { type: "tool_use", id: "toolu_1", name: "Bash" },
      ],
    },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } },
  RESULT,
];

/** Scripted query seam: records every call, replays the per-call script. */
const makeScriptedQuery = (scripts: ReadonlyArray<ReadonlyArray<ClaudeCodeMessage>>) => {
  const calls: Array<ClaudeCodeQueryParams> = [];
  const query: ClaudeCodeQuery = (params) => {
    const script = scripts[Math.min(calls.length, scripts.length - 1)] ?? [];
    calls.push(params);
    return (async function* () {
      for (const message of script) {
        yield message;
      }
    })();
  };
  return { calls, query };
};

const decodeRuntimeInteractionPayload = S.decodeUnknownSync(RuntimeInteractionPayload);

const makeInteractionSeam = (
  decide: (payload: RuntimeInteractionPayload) => RuntimeInteractionDecision,
) => {
  const payloads: Array<RuntimeInteractionPayload> = [];
  return {
    payloads,
    seam: {
      requestInteraction: (payload: RuntimeInteractionPayload) => {
        payloads.push(payload);
        return Promise.resolve(decide(payload));
      },
    },
  };
};

describe("claude-code projection — SDK messages map to a contiguous KhalaRuntimeEvent stream", () => {
  test("the representative stream projects with stream-delta authority and tool correlation", () => {
    const ctx = makeCtx();
    const events = REPRESENTATIVE_SCRIPT.flatMap((message) =>
      claudeCodeMessageToKhalaEvents(message, ctx),
    );

    // init emits nothing; the assistant text block is deduped because stream
    // deltas already carried the text (desktop-runtime authority order).
    expect(kinds(events)).toEqual([
      "reasoning.delta",
      "text.delta",
      "text.delta",
      "tool.call",
      "tool.result",
      "turn.finished",
    ]);
    expect(sequences(events)).toEqual([0, 1, 2, 3, 4, 5]);

    const call = events[3];
    if (call?.kind === "tool.call") {
      // Claude PascalCase `Bash` normalizes onto the common `bash`.
      expect(call.toolName).toBe("bash");
      expect(call.toolCallId).toBe("toolu_1");
    }
    const result = events[4];
    if (result?.kind === "tool.result") {
      // Correlated from the earlier tool_use through ctx.toolNames.
      expect(result.toolName).toBe("bash");
      expect(result.providerExecuted).toBe(true);
    }
  });

  test("complete assistant blocks are the fallback when no partial deltas streamed", () => {
    const ctx = makeCtx();
    const events = claudeCodeMessageToKhalaEvents(
      {
        type: "assistant",
        message: {
          id: "msg_9",
          content: [
            { type: "thinking", thinking: "quietly" },
            { type: "text", text: "Full reply." },
          ],
        },
      },
      ctx,
    );
    expect(kinds(events)).toEqual(["reasoning.delta", "text.delta"]);
    const delta = events[1];
    if (delta?.kind === "text.delta") {
      expect(delta.messageId).toBe("msg_9");
      expect(delta.text).toBe("Full reply.");
    }
  });

  test("a failed tool_result projects tool.error with the correlated tool name", () => {
    const ctx = makeCtx();
    claudeCodeMessageToKhalaEvents(
      {
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_9", name: "Edit" }] },
      },
      ctx,
    );
    const [event] = claudeCodeMessageToKhalaEvents(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: true }] },
      },
      ctx,
    );
    expect(event?.kind).toBe("tool.error");
    if (event?.kind === "tool.error") {
      expect(event.toolName).toBe("edit");
      expect(event.messageSafe).toBe("Claude Code tool reported failure");
    }
  });

  test("the result message projects turn.finished with exact usage", () => {
    const ctx = makeCtx();
    const [event] = claudeCodeMessageToKhalaEvents(RESULT, ctx);
    expect(event?.kind).toBe("turn.finished");
    if (event?.kind === "turn.finished") {
      expect(event.finishReason).toBe("stop");
      expect(event.usage?.inputTokens).toBe(20);
      expect(event.usage?.outputTokens).toBe(8);
      expect(event.usage?.cacheReadInputTokens).toBe(2);
      expect(event.usage?.cacheWriteInputTokens).toBe(1);
      expect(event.usage?.totalTokens).toBe(31);
    }
  });

  test("finish reasons and failure classes follow the ported desktop ladder", () => {
    expect(claudeCodeFinishReason("success", false)).toBe("stop");
    expect(claudeCodeFinishReason("error_max_turns", false)).toBe("length");
    expect(claudeCodeFinishReason("error_during_execution", false)).toBe("error");
    expect(claudeCodeFinishReason("success", true)).toBe("error");

    expect(classifyClaudeCodeFailure("OAuth session expired.")).toBe("account_reconnect_required");
    expect(classifyClaudeCodeFailure("Claude AI usage limit reached")).toBe("budget_exceeded");
    expect(classifyClaudeCodeFailure("something else broke")).toBe("session_failed");
  });

  test("zero or missing usage never fabricates a usage record", () => {
    expect(claudeCodeUsage(undefined, "usage.t")).toBeUndefined();
    expect(claudeCodeUsage({ input_tokens: 0, output_tokens: 0 }, "usage.t")).toBeUndefined();
  });
});

describe("claude-code permission — canUseTool routes through RuntimeInteraction", () => {
  test("a tool permission request produces a valid tool_approval payload", () => {
    const payload = claudeCodePermissionToRuntimeInteractionPayload({
      toolCallId: "toolcall.t1.1",
      toolName: "Bash",
    });
    const decoded = decodeRuntimeInteractionPayload(payload);
    expect(decoded.kind).toBe("tool_approval");
    if (decoded.kind === "tool_approval") {
      expect(decoded.toolName).toBe("bash");
      expect(decoded.authority.status).toBe("operator_escalation_required");
      expect(decoded.authority.allowed).toBe(false);
      expect(decoded.authority.blockerRefs).toContain("blocker.owner_approval");
    }
  });

  test("AskUserQuestion input parses onto a valid provider_question payload", () => {
    const parsed = claudeCodeQuestionToRuntimeInteractionPayload(
      {
        questions: [
          {
            question: "Which color?",
            header: "Color",
            options: [{ label: "Red" }, { label: "Blue", description: "the calm one" }],
            multiSelect: false,
          },
        ],
      },
      "t1.1",
    );
    expect(parsed).toBeDefined();
    const decoded = decodeRuntimeInteractionPayload(parsed?.payload);
    expect(decoded.kind).toBe("provider_question");
    if (decoded.kind === "provider_question") {
      expect(decoded.displayTitle).toBe("Color");
      expect(decoded.questions[0]?.displayText).toBe("Which color?");
      expect(decoded.questions[0]?.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    }
    // Answers must key back to the SDK's exact question text.
    expect(
      parsed?.originalQuestionByRef.get(
        decoded.kind === "provider_question" ? (decoded.questions[0]?.questionRef ?? "") : "",
      ),
    ).toBe("Which color?");
  });

  test("malformed AskUserQuestion input is refused (undefined), not guessed", () => {
    expect(claudeCodeQuestionToRuntimeInteractionPayload({}, "t1.1")).toBeUndefined();
    expect(
      claudeCodeQuestionToRuntimeInteractionPayload(
        { questions: [{ question: "No options?", options: [] }] },
        "t1.1",
      ),
    ).toBeUndefined();
  });

  test("default mode routes a tool call through the seam and maps approve/deny", async () => {
    const approving = makeInteractionSeam(() => ({ kind: "tool_approval", outcome: "approve" }));
    const allow = await makeClaudeCodeCanUseTool({
      permissionMode: "default",
      interaction: approving.seam,
      refSeed: "t1",
    })("Bash", { command: "ls" });
    expect(allow.behavior).toBe("allow");
    if (allow.behavior === "allow") expect(allow.updatedInput).toEqual({ command: "ls" });
    // The recorded request is a canonical tool_approval payload.
    expect(decodeRuntimeInteractionPayload(approving.payloads[0]).kind).toBe("tool_approval");

    const denying = makeInteractionSeam(() => ({ kind: "tool_approval", outcome: "deny" }));
    const deny = await makeClaudeCodeCanUseTool({
      permissionMode: "default",
      interaction: denying.seam,
    })("Bash", { command: "rm" });
    expect(deny.behavior).toBe("deny");
  });

  test("AskUserQuestion answers ride back as allow + updatedInput.answers keyed by original text", async () => {
    const answering = makeInteractionSeam((payload) =>
      payload.kind === "provider_question"
        ? {
            kind: "provider_question",
            answers: payload.questions.map((question) => ({
              questionRef: question.questionRef,
              optionRefs: question.options.slice(0, 2).map((option) => option.optionRef),
            })),
          }
        : { kind: "tool_approval", outcome: "deny" },
    );
    const canUse = makeClaudeCodeCanUseTool({
      permissionMode: "allow-all",
      interaction: answering.seam,
      refSeed: "t1",
    });
    const input = {
      questions: [
        {
          question: "Which colors?",
          options: [{ label: "Red" }, { label: "Blue" }],
          multiSelect: true,
        },
      ],
    };
    const result = await canUse("AskUserQuestion", input);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      // Multi-select labels comma-joined, keyed by the ORIGINAL question text
      // (the SDK-documented answer mechanism ported from the desktop runtime).
      expect(result.updatedInput.answers).toEqual({ "Which colors?": "Red, Blue" });
    }
  });

  test("permission gating fails closed", async () => {
    // default mode with no seam: deny.
    const unwired = await makeClaudeCodeCanUseTool({ permissionMode: "default" })("Bash", {});
    expect(unwired.behavior).toBe("deny");
    // reject-all denies everything, question tool included.
    const rejected = await makeClaudeCodeCanUseTool({ permissionMode: "reject-all" })(
      "AskUserQuestion",
      { questions: [{ question: "Q?", options: [{ label: "A" }] }] },
    );
    expect(rejected.behavior).toBe("deny");
    // allow-all approves ordinary tools without a seam (owner-local danger profile).
    const allowed = await makeClaudeCodeCanUseTool({ permissionMode: "allow-all" })("Bash", {});
    expect(allowed.behavior).toBe("allow");
    // a throwing seam is a deny, never a silent allow.
    const throwing = makeClaudeCodeCanUseTool({
      permissionMode: "default",
      interaction: { requestInteraction: () => Promise.reject(new Error("seam down")) },
    });
    expect((await throwing("Bash", {})).behavior).toBe("deny");
  });
});

describe("claude-code adapter — identity, isolation, and turn semantics", () => {
  test("the adapter reports the claude_code harness/adapter kind honestly", () => {
    const { query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    expect(adapter.harnessId).toBe("claude-code");
    expect(adapter.harnessKind).toBe("claude_code");
    expect(adapter.adapterKind).toBe("claude_code");
    expect(adapter.specificationVersion).toBe("agent-harness-v1");
    // Approvals route through RuntimeInteraction; filtering is SDK-native.
    expect(adapter.supportsBuiltinToolApprovals).toBe(false);
    expect(adapter.supportsBuiltinToolFiltering).toBe(true);
    expect(adapter.lifecycleStateSchema).toBeDefined();
    expect(adapter.builtinTools.map((tool) => tool.nativeName)).toContain("Bash");
  });

  test("a live-home or omitted configDir selects owner-local mode (no CLAUDE_CONFIG_DIR)", async () => {
    expect(isLiveClaudeHome("/Users/owner/.claude")).toBe(true);
    expect(isLiveClaudeHome("/custom/root/.claude", "/custom/root")).toBe(true);
    expect(isLiveClaudeHome("/tmp/claude-homes/s1")).toBe(false);

    const { calls, query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/Users/owner/.claude" });
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        yield* control.done;
      }),
    );
    expect(calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();

    const omitted = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const omittedAdapter = makeClaudeCodeHarnessAdapter({ query: omitted.query });
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* omittedAdapter.start({ sessionId: "s2", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        yield* control.done;
      }),
    );
    expect(omitted.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("a full turn streams turn.started -> ... -> turn.finished with contiguous sequences", async () => {
    const { calls, query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const adapter = makeClaudeCodeHarnessAdapter({
      query,
      configDir: "/tmp/claude-homes/s1",
      cwd: "/tmp/workspaces/s1",
      model: "claude-fable-5",
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done, modelId: session.modelId };
      }),
    );

    expect(result.events[0]?.kind).toBe("turn.started");
    expect(result.events.at(-1)?.kind).toBe("turn.finished");
    expect(sequences(result.events)).toEqual(result.events.map((_, index) => index));
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(result.events.length - 1);
    // Exact usage from the SDK result message rides the turn summary.
    expect(result.done.usage?.totalTokens).toBe(31);
    expect(result.modelId).toBe("claude-fable-5");

    // Isolation posture: the injected home is exported as CLAUDE_CONFIG_DIR,
    // settings stay isolated, and permission routing stays on canUseTool.
    const options = calls[0]?.options;
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-homes/s1");
    expect(options?.settingSources).toEqual([]);
    expect(options?.permissionMode).toBe("default");
    expect(options?.canUseTool).toBeDefined();
    expect(options?.cwd).toBe("/tmp/workspaces/s1");
    expect(options?.model).toBe("claude-fable-5");
    expect(options?.resume).toBeUndefined();
  });

  test("builtin tool filtering passes through as SDK allowedTools/disallowedTools", async () => {
    const { calls, query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          builtinToolFiltering: { activeTools: ["Bash", "Read"], inactiveTools: ["WebSearch"] },
        });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        return yield* collect(control.events);
      }),
    );
    expect(calls[0]?.options.allowedTools).toEqual(["Bash", "Read"]);
    expect(calls[0]?.options.disallowedTools).toEqual(["WebSearch"]);
  });

  test("instructions apply once per fresh session and the next turn resumes the SDK session", async () => {
    const { calls, query } = makeScriptedQuery([
      REPRESENTATIVE_SCRIPT,
      [INIT, streamText("again"), RESULT],
    ]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const first = yield* session.promptTurn({
          turnId: "t1",
          prompt: "hi",
          instructions: "Be terse.",
        });
        yield* collect(first.events);
        const second = yield* session.promptTurn({
          turnId: "t2",
          prompt: "more",
          instructions: "Be terse.",
        });
        yield* collect(second.events);
      }),
    );

    // Turn 1: fresh session, instructions prepended once, no resume.
    expect(calls[0]?.prompt).toBe("Be terse.\n\nhi");
    expect(calls[0]?.options.resume).toBeUndefined();
    // Turn 2: session continuity via the persisted init session id; the
    // framework re-supplied the same instructions and they were NOT re-applied.
    expect(calls[1]?.prompt).toBe("more");
    expect(calls[1]?.options.resume).toBe("sess_claude_1");
  });

  test("suspend aborts in-flight and continue re-drives with resume as an honest lossy rerun", async () => {
    const { calls, query } = makeScriptedQuery([
      REPRESENTATIVE_SCRIPT,
      [INIT, streamText("resumed "), streamText("tail"), RESULT],
    ]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        // Phase 1: pull only the first two events, then suspend mid-turn.
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(2)));
        const continuation = yield* session.suspendTurn();

        // Phase 2: a FRESH session (different process) re-drives from the
        // persisted SDK session id.
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
    expect(outcome.continuation.cursor).toBe(1);
    // The degraded rerun is declared honestly: ALWAYS lossy, never a lossless
    // attach claim.
    expect(outcome.continuation.lossy).toBe(true);
    expect(outcome.continuation.turnId).toBe("t1");
    // Suspend aborted the in-flight SDK turn.
    expect(calls[0]?.options.abortController?.signal.aborted).toBe(true);

    // The re-drive resumed the persisted SDK session with the rerun prompt.
    expect(calls[1]?.options.resume).toBe("sess_claude_1");
    expect(calls[1]?.prompt).toBe(CLAUDE_CODE_CONTINUATION_PROMPT);

    // The recomputed tail attaches at cursor + 1 — no gap, no duplicate.
    expect(outcome.phase2[0]?.kind).toBe("turn.started");
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(new Set(merged).size).toBe(merged.length);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]).toBe((merged[i - 1] ?? -1) + 1);
    }
  });

  test("detach persists the SDK session id and a resumed session re-drives without instructions", async () => {
    const { calls, query } = makeScriptedQuery([
      REPRESENTATIVE_SCRIPT,
      [INIT, streamText("back"), RESULT],
    ]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    const resumeState = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        return yield* session.detach();
      }),
    );
    expect(resumeState.harnessId).toBe("claude-code");
    expect(resumeState.data).toEqual({ claudeSessionId: "sess_claude_1" });

    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          resumeFrom: resumeState,
        });
        expect(session.isResume).toBe(true);
        const control = yield* session.promptTurn({
          turnId: "t2",
          prompt: "continue",
          instructions: "Be terse.",
        });
        yield* collect(control.events);
      }),
    );
    // The resumed session passes resume and never re-applies instructions.
    expect(calls[1]?.options.resume).toBe("sess_claude_1");
    expect(calls[1]?.prompt).toBe("continue");
  });

  test("cross-adapter resume state is refused typed", async () => {
    const { query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    const error = await Effect.runPromise(
      adapter
        .start({
          sessionId: "s1",
          source: SOURCE,
          resumeFrom: { harnessId: "codex", sessionId: "s1", data: {} },
        })
        .pipe(Effect.flip),
    );
    expect(error.failureClass).toBe("cross_adapter_resume_state");
  });

  test("an SDK iteration failure maps to a typed HarnessTurnError with the ported class", async () => {
    const query: ClaudeCodeQuery = () =>
      (async function* () {
        yield INIT;
        throw new Error("OAuth session expired. Run claude login.");
      })();
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        return yield* collect(control.events).pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HarnessTurnError);
    if (error instanceof HarnessTurnError) {
      expect(error.failureClass).toBe("account_reconnect_required");
      expect(error.turnId).toBe("t1");
    }
  });

  test("compact is refused fail-closed with a typed capability error", async () => {
    const { query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const adapter = makeClaudeCodeHarnessAdapter({ query, configDir: "/tmp/claude-homes/s1" });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.compact().pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HarnessCapabilityUnsupported);
    expect(error.capability).toBe("compact");
  });
});

describe("claude code adapter — host query overrides (#9167 slice 2)", () => {
  test("queryOverrides merge last and win over adapter-assembled options", async () => {
    const { calls, query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const hostCanUseTool = async () => ({ behavior: "allow" as const, updatedInput: {} });
    const adapter = makeClaudeCodeHarnessAdapter({
      query,
      configDir: "/tmp/claude-homes/s1",
      model: "claude-haiku-4-5-20251001",
      queryOverrides: {
        maxTurns: 25,
        pathToClaudeCodeExecutable: "/bundle/claude",
        mcpServers: { delegate: { command: "node" } },
        skills: ["review"],
        canUseTool: hostCanUseTool,
        permissionMode: "default",
      },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        yield* control.done;
      }),
    );
    const options = calls[0]?.options as Record<string, unknown>;
    expect(options.maxTurns).toBe(25);
    expect(options.pathToClaudeCodeExecutable).toBe("/bundle/claude");
    expect(options.skills).toEqual(["review"]);
    expect(options.canUseTool).toBe(hostCanUseTool);
    // Adapter-assembled fields the host did not override stay intact.
    expect(options.model).toBe("claude-haiku-4-5-20251001");
    expect(options.includePartialMessages).toBe(true);
  });
});

describe("claude code adapter — raw-message observer (#9167 slice 3)", () => {
  test("onRawMessage fires for every SDK message without altering the neutral stream", async () => {
    const { query } = makeScriptedQuery([REPRESENTATIVE_SCRIPT]);
    const seen: string[] = [];
    const adapter = makeClaudeCodeHarnessAdapter({
      query,
      configDir: "/tmp/claude-homes/s1",
      model: "claude-haiku-4-5-20251001",
      onRawMessage: (message) => seen.push(message.type),
    });
    const neutral = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* collect(control.events);
        yield* control.done;
        return events;
      }),
    );
    // The observer saw the raw system/assistant/result messages.
    expect(seen).toContain("system");
    expect(seen).toContain("result");
    // The neutral stream is unchanged: it still opens turn.started and closes
    // turn.finished around the core kinds.
    expect(neutral[0].kind).toBe("turn.started");
    expect(neutral[neutral.length - 1].kind).toBe("turn.finished");
  });
});
