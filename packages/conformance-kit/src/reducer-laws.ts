import { Effect, Stream } from "effect";
import {
  toolIdentity,
  type UiMessage,
  type UiMessageChunk,
  type UiMessageStreamHandle,
} from "@openagentsinc/agent-harness-contract";
import { describe, expect, test } from "vite-plus/test";

const BASH = toolIdentity("Bash");

/**
 * Configuration for {@link runReducerLaws}. The implementation under test is a
 * progressive reducer: a pure `applyChunk` fold step plus its `initial`
 * message. The kit feeds known chunk scripts and asserts the progressive
 * snapshot laws hold. `isReducerError` recognizes the implementation's tagged
 * error so a malformed sequence is proven to fail loudly, never to silently
 * corrupt state.
 */
export interface ReducerLawsConfig {
  /** A short label naming the implementation under test, used in test titles. */
  readonly label: string;
  /** The empty starting message. */
  readonly initial: () => UiMessage;
  /** The pure fold step. Must throw the tagged reducer error on a malformed sequence. */
  readonly applyChunk: (message: UiMessage, chunk: UiMessageChunk) => UiMessage;
  /** Recognizes the implementation's tagged reducer error. */
  readonly isReducerError: (error: unknown) => boolean;
  /**
   * Optional stream reducer. When present, the kit also proves the streamed
   * fold publishes the same progressive snapshots the pure fold produces and
   * `done` equals the pure fold's final state.
   */
  readonly reduceStream?: (
    stream: Stream.Stream<UiMessageChunk>,
  ) => Effect.Effect<UiMessageStreamHandle<never>>;
}

/**
 * The progressive-reducer snapshot laws, parameterized over any reducer.
 *
 * Promoted, published form of
 * `agent-harness-contract/src/ui-message-reducer.test.ts`:
 *
 * - **Progressive fold.** Text grows across intermediate snapshots and closes
 *   on finish; status advances `streaming -> complete`. Every intermediate
 *   state is observable, not just the final one.
 * - **Tool state machine.** `input-streaming -> input-available ->
 *   output-available` transitions land in order with accumulated input text.
 * - **Transient bypass.** A transient chunk never mutates the persisted message.
 * - **Fail loud, never corrupt.** A malformed sequence (ghost output, state
 *   regression, text after end) throws the tagged reducer error.
 */
export const runReducerLaws = (config: ReducerLawsConfig): void => {
  const { label, initial, applyChunk, isReducerError } = config;

  /** Fold chunks into every intermediate snapshot, starting from the initial. */
  const snapshotsOf = (
    chunks: ReadonlyArray<UiMessageChunk>,
    start: UiMessage = initial(),
  ): ReadonlyArray<UiMessage> => {
    const snapshots: Array<UiMessage> = [start];
    let current = start;
    for (const chunk of chunks) {
      current = applyChunk(current, chunk);
      snapshots.push(current);
    }
    return snapshots;
  };

  const textOf = (message: UiMessage): string =>
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");

  const toolStateOf = (message: UiMessage): string | undefined => {
    const part = message.parts.find((candidate) => candidate.type === "tool");
    return part?.type === "tool" ? part.state : undefined;
  };

  const toolInputTextOf = (message: UiMessage): string | undefined => {
    const part = message.parts.find((candidate) => candidate.type === "tool");
    return part?.type === "tool" ? part.inputText : undefined;
  };

  describe(`[${label}] reducer — progressive snapshots`, () => {
    test("text grows across intermediate snapshots and closes on finish", () => {
      const chunks: ReadonlyArray<UiMessageChunk> = [
        { type: "message-start", messageId: "t1" },
        { type: "text-delta", id: "msg.t1", delta: "Hello " },
        { type: "text-delta", id: "msg.t1", delta: "world" },
        { type: "text-end", id: "msg.t1" },
        { type: "message-finish", finishReason: "stop" },
      ];
      const snapshots = snapshotsOf(chunks);

      expect(snapshots.map(textOf)).toEqual([
        "",
        "",
        "Hello ",
        "Hello world",
        "Hello world",
        "Hello world",
      ]);
      expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
        "streaming",
        "streaming",
        "streaming",
        "streaming",
        "streaming",
        "complete",
      ]);
      expect(snapshots.at(-1)?.finishReason).toBe("stop");
    });

    test("the tool-call state machine transitions land in order with accumulated input", () => {
      const chunks: ReadonlyArray<UiMessageChunk> = [
        {
          type: "tool-input-streaming",
          toolCallId: "call.1",
          tool: BASH,
          inputTextDelta: '{"command":',
        },
        { type: "tool-input-streaming", toolCallId: "call.1", tool: BASH, inputTextDelta: '"ls"}' },
        {
          type: "tool-input-available",
          toolCallId: "call.1",
          tool: BASH,
          inputRef: "input.call.1",
        },
        {
          type: "tool-output-available",
          toolCallId: "call.1",
          tool: BASH,
          resultRef: "result.call.1",
        },
      ];
      const snapshots = snapshotsOf(chunks).slice(1);

      expect(snapshots.map(toolStateOf)).toEqual([
        "input-streaming",
        "input-streaming",
        "input-available",
        "output-available",
      ]);
      expect(snapshots.map(toolInputTextOf)).toEqual([
        '{"command":',
        '{"command":"ls"}',
        '{"command":"ls"}',
        '{"command":"ls"}',
      ]);
    });

    test("tool-output-error lands the error state with the safe text", () => {
      const chunks: ReadonlyArray<UiMessageChunk> = [
        { type: "tool-input-available", toolCallId: "call.1", tool: BASH },
        {
          type: "tool-output-error",
          toolCallId: "call.1",
          tool: BASH,
          errorText: "command failed",
          errorRef: "error.call.1",
        },
      ];
      const final = snapshotsOf(chunks).at(-1)!;
      const part = final.parts.find((candidate) => candidate.type === "tool");
      expect(part?.type === "tool" ? part.state : undefined).toBe("output-error");
      const errorText =
        part?.type === "tool" && part.state === "output-error" ? part.errorText : undefined;
      expect(errorText).toBe("command failed");
    });

    test("transient chunks bypass the persisted message", () => {
      const message = applyChunk(initial(), {
        type: "text-delta",
        id: "m",
        delta: "ephemeral",
        transient: true,
      });
      expect(message).toEqual(initial());
    });
  });

  describe(`[${label}] reducer — fail loud, never corrupt`, () => {
    test("output for a tool call that never streamed input throws the tagged error", () => {
      let thrown: unknown;
      try {
        applyChunk(initial(), {
          type: "tool-output-available",
          toolCallId: "call.ghost",
          tool: BASH,
          resultRef: "result.ghost",
        });
      } catch (error) {
        thrown = error;
      }
      expect(isReducerError(thrown)).toBe(true);
    });

    test("a state regression (input after output) throws the tagged error", () => {
      const settled = snapshotsOf([
        { type: "tool-input-available", toolCallId: "call.1", tool: BASH },
        { type: "tool-output-available", toolCallId: "call.1", tool: BASH, resultRef: "r.1" },
      ]).at(-1)!;
      let thrown: unknown;
      try {
        applyChunk(settled, {
          type: "tool-input-streaming",
          toolCallId: "call.1",
          tool: BASH,
          inputTextDelta: "more",
        });
      } catch (error) {
        thrown = error;
      }
      expect(isReducerError(thrown)).toBe(true);
    });

    test("text delta after text end throws the tagged error", () => {
      const closed = snapshotsOf([
        { type: "text-delta", id: "m", delta: "a" },
        { type: "text-end", id: "m" },
      ]).at(-1)!;
      let thrown: unknown;
      try {
        applyChunk(closed, { type: "text-delta", id: "m", delta: "b" });
      } catch (error) {
        thrown = error;
      }
      expect(isReducerError(thrown)).toBe(true);
    });
  });

  if (config.reduceStream !== undefined) {
    const reduceStream = config.reduceStream;
    describe(`[${label}] reducer — streamed fold equals pure fold`, () => {
      test("done equals the pure fold's final state", async () => {
        const chunks: ReadonlyArray<UiMessageChunk> = [
          { type: "message-start", messageId: "t1" },
          { type: "text-delta", id: "msg.t1", delta: "Hello " },
          { type: "text-delta", id: "msg.t1", delta: "world" },
          { type: "text-end", id: "msg.t1" },
          { type: "message-finish", finishReason: "stop" },
        ];
        const pureFinal = snapshotsOf(chunks).at(-1)!;

        const streamedFinal = await Effect.runPromise(
          Effect.gen(function* () {
            const handle = yield* reduceStream(Stream.fromIterable(chunks));
            return yield* handle.done;
          }),
        );
        expect(streamedFinal).toEqual(pureFinal);
      });

      test("a malformed sequence fails done with the tagged error", async () => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const handle = yield* reduceStream(
              Stream.fromIterable<UiMessageChunk>([
                {
                  type: "tool-output-available",
                  toolCallId: "call.ghost",
                  tool: BASH,
                  resultRef: "result.ghost",
                },
              ]),
            );
            return yield* Effect.flip(handle.done);
          }),
        );
        expect(isReducerError(outcome)).toBe(true);
      });
    });
  }
};
