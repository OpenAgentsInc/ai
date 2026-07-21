import { Effect, Stream } from "effect";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";
import { HarnessCapabilityUnsupported } from "./capability.ts";
import { HarnessStartError } from "./adapter.ts";
import {
  CURSOR_ACP_PROTOCOL_VERSION,
  CURSOR_AGENT_DISCOVERY,
  CURSOR_BUILTIN_TOOLS,
  CURSOR_CAPABILITY_TABLE,
  CURSOR_PEER_PROFILE,
  CURSOR_REFUSED_ACP_CAPABILITIES,
  CURSOR_SUPPORTED_ACP_CAPABILITIES,
  cursorAcpApprovalTurnScript,
  cursorAcpFailureTurnScript,
  cursorFactoryCapabilityFlags,
  cursorVerbDisposition,
  isRefusedCursorAgentPath,
  makeCursorHarnessAdapter,
} from "./cursor-adapter.ts";
import type { HarnessStreamEvent } from "./stream.ts";

const SOURCE: KhalaRuntimeSource = {
  lane: "agent_client_protocol",
  adapterKind: "cursor_cli",
};

/** An injected, non-refused cursor-agent path for tests. */
const CURSOR_AGENT_PATH = "/opt/cursor/bin/cursor-agent";

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);

const kinds = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.kind);

describe("cursor adapter — pinned peer profile", () => {
  test("pins Cursor identity: custom harness kind carried by the cursor_cli adapter kind", () => {
    expect(CURSOR_PEER_PROFILE.harnessId).toBe("cursor");
    expect(CURSOR_PEER_PROFILE.harnessKind).toBe("custom");
    expect(CURSOR_PEER_PROFILE.adapterKind).toBe("cursor_cli");
    expect(CURSOR_PEER_PROFILE.acpProtocolVersion).toBe(CURSOR_ACP_PROTOCOL_VERSION);
    expect(CURSOR_ACP_PROTOCOL_VERSION).toBe(1);
  });

  test("declares the ACP capabilities it relies on and the ones it refuses", () => {
    const supported = CURSOR_SUPPORTED_ACP_CAPABILITIES.map((c) => c.capability);
    expect(supported).toContain("session.prompt");
    expect(supported).toContain("session.request_permission");
    expect(supported).toContain("session.load");

    const refused = CURSOR_REFUSED_ACP_CAPABILITIES.map((c) => c.capability);
    expect(refused).toContain("context.compact");
    expect(refused).toContain("builtin_tool_filtering");
    expect(refused).toContain("native_tool_approval_channel");

    // Every declared capability carries a note — the published profile is documented.
    for (const cap of [...CURSOR_SUPPORTED_ACP_CAPABILITIES, ...CURSOR_REFUSED_ACP_CAPABILITIES]) {
      expect(cap.note.length).toBeGreaterThan(0);
    }
  });

  test("the built adapter reflects the pinned profile", () => {
    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });
    expect(cursor.specificationVersion).toBe("agent-harness-v1");
    expect(cursor.harnessId).toBe("cursor");
    expect(cursor.harnessKind).toBe("custom");
    expect(cursor.adapterKind).toBe("cursor_cli");
    expect(cursor.builtinTools).toBe(CURSOR_BUILTIN_TOOLS);
  });
});

describe("cursor adapter — published capability table", () => {
  test("states a disposition for every governed session verb", () => {
    expect(cursorVerbDisposition("prompt_turn")).toBe("lossless");
    expect(cursorVerbDisposition("suspend_turn")).toBe("lossless");
    expect(cursorVerbDisposition("continue_turn")).toBe("degraded");
    expect(cursorVerbDisposition("detach")).toBe("lossless");
    expect(cursorVerbDisposition("compact")).toBe("refused");
    expect(cursorVerbDisposition("builtin_tool_approvals")).toBe("refused");
    expect(cursorVerbDisposition("builtin_tool_filtering")).toBe("refused");
    // Every row is documented.
    for (const entry of CURSOR_CAPABILITY_TABLE) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  test("the adapter's runtime capabilities are DERIVED from the table (no drift)", () => {
    const flags = cursorFactoryCapabilityFlags();
    expect(flags.supportsCompact).toBe(false);
    expect(flags.supportsBuiltinToolApprovals).toBe(false);
    expect(flags.supportsBuiltinToolFiltering).toBe(false);
    expect(flags.supportsSuspend).toBe(true);
    expect(flags.supportsContinue).toBe(true);
    expect(flags.supportsDetach).toBe(true);
    // A degraded continue is labeled lossy.
    expect(flags.continueIsLossy).toBe(true);

    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });
    expect(cursor.supportsBuiltinToolApprovals).toBe(false);
    expect(cursor.supportsBuiltinToolFiltering).toBe(false);
  });
});

describe("cursor adapter — executable discovery and injected path", () => {
  test("publishes discovery guidance instead of hard-coding a binary", () => {
    expect(CURSOR_AGENT_DISCOVERY.candidateBinaryNames).toContain("cursor-agent");
    expect(CURSOR_AGENT_DISCOVERY.overrideEnvVar).toBe("CURSOR_AGENT_PATH");
    expect(CURSOR_AGENT_DISCOVERY.installHint.length).toBeGreaterThan(0);
  });

  test("refuses an empty or placeholder path", () => {
    expect(isRefusedCursorAgentPath("")).toBe(true);
    expect(isRefusedCursorAgentPath("   ")).toBe(true);
    expect(isRefusedCursorAgentPath("<inject-cursor-agent-path>")).toBe(true);
    expect(isRefusedCursorAgentPath(CURSOR_AGENT_PATH)).toBe(false);
  });

  test("start fails when the injected path is refused", async () => {
    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: "" });
    const error = await Effect.runPromise(
      cursor.start({ sessionId: "s1", source: SOURCE }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(HarnessStartError);
    if (error instanceof HarnessStartError) {
      expect(error.failureClass).toBe("cursor_agent_path_required");
      expect(error.harnessId).toBe("cursor");
    }
  });

  test("start succeeds when the path is injected", async () => {
    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });
    const modelId = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        return session.modelId;
      }),
    );
    expect(modelId).toBe("cursor/acp");
  });
});

describe("cursor adapter — turn lifecycle and tool correlation", () => {
  const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });

  test("a full turn streams turn.started -> ... -> turn.finished with contiguous sequences", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "fix it" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );

    expect(result.events[0]?.kind).toBe("turn.started");
    expect(result.events.at(-1)?.kind).toBe("turn.finished");
    expect(sequences(result.events)).toEqual(result.events.map((_, index) => index));
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(result.events.length - 1);
  });

  test("tool names are normalized: read_file -> read, codebase_search stays native", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "fix it" });
        return yield* collect(control.events);
      }),
    );

    const toolCalls = events.filter((e) => e.kind === "tool.call");
    const toolResults = events.filter((e) => e.kind === "tool.result");
    // Two correlated call/result pairs.
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);

    const callNames = toolCalls.flatMap((e) => (e.kind === "tool.call" ? [e.toolName] : []));
    expect(callNames).toContain("read"); // read_file -> common vocabulary
    expect(callNames).toContain("codebase_search"); // Cursor-specific, no common name

    // Call and result correlate on the same toolCallId.
    const callIds = new Set(
      toolCalls.flatMap((e) => (e.kind === "tool.call" ? [e.toolCallId] : [])),
    );
    for (const result of toolResults) {
      if (result.kind === "tool.result") {
        expect(callIds.has(result.toolCallId)).toBe(true);
      }
    }
  });
});

describe("cursor adapter — approval routing", () => {
  test("a permission request is NOT a transcript event; the stream stays contiguous", async () => {
    const cursor = makeCursorHarnessAdapter({
      cursorAgentPath: CURSOR_AGENT_PATH,
      script: cursorAcpApprovalTurnScript,
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "run it" });
        return yield* collect(control.events);
      }),
    );

    // turn.started, tool.call, tool.result, turn.finished — the approval dropped out.
    expect(kinds(events)).toEqual(["turn.started", "tool.call", "tool.result", "turn.finished"]);
    expect(sequences(events)).toEqual([0, 1, 2, 3]);
  });

  test("native built-in approvals are refused — approvals ride RuntimeInteraction", () => {
    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });
    expect(cursor.supportsBuiltinToolApprovals).toBe(false);
  });
});

describe("cursor adapter — capability honesty at runtime", () => {
  test("compact is refused with HarnessCapabilityUnsupported", async () => {
    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        return yield* session.compact().pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HarnessCapabilityUnsupported);
    if (error instanceof HarnessCapabilityUnsupported) {
      expect(error.capability).toBe("compact");
    }
  });

  test("suspend is lossless (exact cursor) but continue is degraded (labeled lossy)", async () => {
    const cursor = makeCursorHarnessAdapter({ cursorAgentPath: CURSOR_AGENT_PATH });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "fix it" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(2)));
        const continuation = yield* session.suspendTurn();

        const session2 = yield* cursor.start({
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
    // Suspend pins the exact cursor.
    expect(outcome.continuation.cursor).toBe(1);
    // Continue is degraded -> the honest lossy label is set.
    expect(outcome.continuation.lossy).toBe(true);
    // The buffered remainder still attaches at cursor + 1 with no gap or duplicate.
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(new Set(merged).size).toBe(merged.length);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]).toBe((merged[i - 1] ?? -1) + 1);
    }
  });
});

describe("cursor adapter — error mapping", () => {
  test("a failed tool projects tool.error with the safe message and a refusal maps to content-filter", async () => {
    const cursor = makeCursorHarnessAdapter({
      cursorAgentPath: CURSOR_AGENT_PATH,
      script: cursorAcpFailureTurnScript,
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* cursor.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "patch it" });
        return yield* collect(control.events);
      }),
    );

    const toolError = events.find((e) => e.kind === "tool.error");
    expect(toolError?.kind).toBe("tool.error");
    if (toolError?.kind === "tool.error") {
      expect(toolError.messageSafe).toBe("patch did not apply");
    }

    const finished = events.at(-1);
    expect(finished?.kind).toBe("turn.finished");
    if (finished?.kind === "turn.finished") {
      expect(finished.finishReason).toBe("content-filter");
    }
  });
});
