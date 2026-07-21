import { Effect, Stream } from "effect";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import type { AgentHarness, HarnessStartOptions } from "./adapter.ts";
import { HarnessCapabilityUnsupported } from "./capability.ts";
import type { HarnessHostToolSpec } from "./host-tool.ts";
import { makeHarnessAgent } from "./harness-agent.ts";
import { makeReferenceAdapter } from "./reference-adapter.ts";
import type { HarnessPromptTurnOptions } from "./session.ts";
import type { HarnessSkill } from "./skill.ts";
import type { UiMessageChunk } from "./ui-message-chunk.ts";

const SOURCE: KhalaRuntimeSource = { lane: "test_fixture" };

/**
 * A recording wrapper over any adapter: it captures the {@link HarnessStartOptions}
 * `start` receives and the {@link HarnessPromptTurnOptions} `promptTurn` receives,
 * then delegates to the wrapped adapter. Used to prove the facade threads
 * skills/host-tools/permission settings through without altering them.
 */
const recordingAdapter = (
  base: AgentHarness,
): {
  readonly adapter: AgentHarness;
  readonly starts: Array<HarnessStartOptions>;
  readonly prompts: Array<HarnessPromptTurnOptions>;
} => {
  const starts: Array<HarnessStartOptions> = [];
  const prompts: Array<HarnessPromptTurnOptions> = [];
  const adapter: AgentHarness = {
    ...base,
    start: (options) => {
      starts.push(options);
      return base.start(options).pipe(
        Effect.map((session) => ({
          ...session,
          promptTurn: (turnOptions) => {
            prompts.push(turnOptions);
            return session.promptTurn(turnOptions);
          },
        })),
      );
    },
  };
  return { adapter, starts, prompts };
};

const chunkTypes = (chunks: ReadonlyArray<UiMessageChunk>): ReadonlyArray<string> =>
  chunks.map((chunk) => chunk.type);

describe("makeHarnessAgent — generate coalescing", () => {
  test("generate assembles the neutral event stream into a coalesced result", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeReferenceAdapter({ scriptWords: ["Hello ", "world"] });
        const agent = makeHarnessAgent(adapter, { source: SOURCE });
        return yield* agent.generate({ prompt: "hi", turnId: "t1", sessionId: "s1" });
      }),
    );

    expect(result.turnId).toBe("t1");
    expect(result.text).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
    // turn.started + 2 text.delta + turn.finished = sequences 0..3.
    expect(result.lastCursor).toBe(3);
    expect(result.message.status).toBe("complete");
  });

  test("a bare-string prompt is accepted and generates ids when absent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeReferenceAdapter({ harnessId: "ref", scriptWords: ["one ", "two"] });
        const agent = makeHarnessAgent(adapter, { source: SOURCE });
        return yield* agent.generate("hi");
      }),
    );
    expect(result.text).toBe("one two");
    expect(result.turnId).toMatch(/^ref-/);
  });
});

describe("makeHarnessAgent — stream chunk delivery via the existing projection", () => {
  test("stream delivers the projected UI chunks and resolves the coalesced result", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeReferenceAdapter({ scriptWords: ["Hello ", "world"] });
        const agent = makeHarnessAgent(adapter, { source: SOURCE });
        const { stream, result } = yield* agent.stream({
          prompt: "hi",
          turnId: "t1",
          sessionId: "s1",
        });
        const chunks = yield* Stream.runCollect(stream);
        const coalesced = yield* result;
        return { chunks, coalesced };
      }),
    );

    expect(chunkTypes(outcome.chunks)).toEqual([
      "message-start",
      "text-delta",
      "text-delta",
      "message-finish",
    ]);
    const deltas = outcome.chunks
      .filter(
        (chunk): chunk is Extract<UiMessageChunk, { type: "text-delta" }> =>
          chunk.type === "text-delta",
      )
      .map((chunk) => chunk.delta);
    expect(deltas).toEqual(["Hello ", "world"]);
    // The tee's coalesced result matches the streamed content exactly once.
    expect(outcome.coalesced.text).toBe("Hello world");
    expect(outcome.coalesced.finishReason).toBe("stop");
  });
});

describe("makeHarnessAgent — session create/resume over the session verbs", () => {
  test("create drives promptTurn; resume drives continueTurn from suspend state", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeReferenceAdapter({ scriptWords: ["Hello ", "world"] });
        const agent = makeHarnessAgent(adapter, { source: SOURCE });

        // Create → promptTurn. Drive only the first two events, then suspend the
        // live turn through the raw session verb the facade exposes as passthrough.
        const created = yield* agent.createSession({ sessionId: "s1" });
        const control = yield* created.session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* Stream.runCollect(control.events.pipe(Stream.take(2)));
        const continuation = yield* created.session.suspendTurn();

        // Resume → continueTurn on a fresh session, coalescing the remainder.
        const resumed = yield* agent.resumeSession(continuation, { sessionId: "s1" });
        const resumedResult = yield* resumed.resumeGenerate();

        return { phase1, continuation, resumedResult };
      }),
    );

    expect(outcome.phase1.map((event) => event.sequence)).toEqual([0, 1]);
    expect(outcome.continuation.cursor).toBe(1);
    // The remainder after "Hello " is exactly "world" — no gap, no duplicate.
    expect(outcome.resumedResult.text).toBe("world");
    expect(outcome.resumedResult.finishReason).toBe("stop");
    expect(outcome.resumedResult.lastCursor).toBe(3);
  });
});

describe("makeHarnessAgent — settings passthrough (no added authority)", () => {
  test("skills / permission mode reach start; instructions / host tools reach promptTurn", async () => {
    const skill: HarnessSkill = { name: "demo", description: "demo skill", content: "body" };
    const tool: HarnessHostToolSpec = {
      name: "echo",
      description: "echo input",
      inputJsonSchema: { type: "object" },
    };

    const recorded = await Effect.runPromise(
      Effect.gen(function* () {
        const recording = recordingAdapter(makeReferenceAdapter());
        const agent = makeHarnessAgent(recording.adapter, {
          source: SOURCE,
          skills: [skill],
          permissionMode: "allow-all",
          instructions: "be terse",
          tools: [tool],
        });
        yield* agent.generate({ prompt: "hi", turnId: "t1", sessionId: "s1" });
        return { starts: recording.starts, prompts: recording.prompts };
      }),
    );

    expect(recorded.starts).toHaveLength(1);
    expect(recorded.starts[0]?.sessionId).toBe("s1");
    expect(recorded.starts[0]?.source).toEqual(SOURCE);
    expect(recorded.starts[0]?.skills).toEqual([skill]);
    expect(recorded.starts[0]?.permissionMode).toBe("allow-all");
    // No filtering was configured — the facade must not synthesize one.
    expect(recorded.starts[0]?.builtinToolFiltering).toBeUndefined();

    expect(recorded.prompts).toHaveLength(1);
    expect(recorded.prompts[0]?.prompt).toBe("hi");
    expect(recorded.prompts[0]?.instructions).toBe("be terse");
    expect(recorded.prompts[0]?.tools).toEqual([tool]);
  });

  test("per-turn input overrides the agent-level instructions and host tools", async () => {
    const agentTool: HarnessHostToolSpec = {
      name: "agent-tool",
      description: "default",
      inputJsonSchema: { type: "object" },
    };
    const turnTool: HarnessHostToolSpec = {
      name: "turn-tool",
      description: "override",
      inputJsonSchema: { type: "object" },
    };

    const prompts = await Effect.runPromise(
      Effect.gen(function* () {
        const recording = recordingAdapter(makeReferenceAdapter());
        const agent = makeHarnessAgent(recording.adapter, {
          source: SOURCE,
          instructions: "agent default",
          tools: [agentTool],
        });
        yield* agent.generate({
          prompt: "hi",
          turnId: "t1",
          sessionId: "s1",
          instructions: "turn override",
          tools: [turnTool],
        });
        return recording.prompts;
      }),
    );

    expect(prompts[0]?.instructions).toBe("turn override");
    expect(prompts[0]?.tools).toEqual([turnTool]);
  });
});

describe("makeHarnessAgent — capability gaps are not papered over", () => {
  test("resumeStream surfaces HarnessCapabilityUnsupported when the adapter cannot continue", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeReferenceAdapter({ supportsContinue: false });
        const agent = makeHarnessAgent(adapter, { source: SOURCE });
        const session = yield* agent.createSession({ sessionId: "s1" });
        return yield* session.resumeStream().pipe(Effect.flip);
      }),
    );

    expect(error).toBeInstanceOf(HarnessCapabilityUnsupported);
    expect((error as HarnessCapabilityUnsupported).capability).toBe("continue_turn");
  });

  test("the raw session passthrough still fails closed on an unsupported verb", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeReferenceAdapter({ supportsSuspend: false });
        const agent = makeHarnessAgent(adapter, { source: SOURCE });
        const session = yield* agent.createSession({ sessionId: "s1" });
        return yield* session.session.suspendTurn().pipe(Effect.flip);
      }),
    );

    expect(error).toBeInstanceOf(HarnessCapabilityUnsupported);
    expect((error as HarnessCapabilityUnsupported).capability).toBe("suspend_turn");
  });
});
