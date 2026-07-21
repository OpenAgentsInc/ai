import { describe, expect, test } from "vite-plus/test";
import { decodeAgentRuntimeEvent } from "@openagentsinc/agent-runtime-schema";
import {
  buildKhalaAiSdkCoreStreamTextOptions,
  collectKhalaAiSdkCoreEventsFromStream,
  reduceAgentRuntimeEventsAsKhalaTranscript,
  reduceKhalaRuntimeTranscript,
  runKhalaAiSdkCoreRuntime,
} from "./index.js";

const iso = "2026-07-05T00:00:00.000Z";

async function* streamOf(parts: ReadonlyArray<unknown>): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

const provider = {
  headers: { "x-openagents-provider": "fixture" },
  modelRef: "model.fixture.low_risk",
  providerOptions: { compatibility: "strict_false" },
  providerRef: "openai",
  promptCache: { cacheControl: "ephemeral", cacheKey: "prompt-cache.fixture" },
  reasoning: { effort: "low", enabled: true, maxTokens: 128 },
  schemaLowering: "json_schema",
  strictToolSchemas: false,
} as const;

describe("Khala AI SDK Core runtime adapter", () => {
  test("calls streamText and maps streamed text, finish, usage, and provider metadata into Khala runtime events", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const result = await runKhalaAiSdkCoreRuntime({
      model: "fixture-model",
      observedAt: () => iso,
      prompt: "Say hello.",
      provider,
      streamText: (options) => {
        capturedOptions = options;
        return {
          stream: streamOf([
            { type: "start" },
            { type: "text-delta", id: "message.fixture", text: "Hello " },
            { type: "text-delta", id: "message.fixture", text: "world" },
            {
              type: "finish-step",
              finishReason: "stop",
              providerMetadata: { trace: "private-provider-payload" },
              usage: {
                inputTokens: 3,
                outputTokens: 2,
                totalTokens: 5,
              },
            },
            {
              type: "finish",
              finishReason: "stop",
              totalUsage: {
                inputTokens: 3,
                outputTokens: 2,
                totalTokens: 5,
              },
            },
          ]),
        };
      },
      threadId: "thread.ai_sdk_core.fixture",
      turnId: "turn.ai_sdk_core.fixture",
    });

    expect(capturedOptions?.model).toBe("fixture-model");
    expect(capturedOptions?.prompt).toBe("Say hello.");
    expect(capturedOptions?.headers).toEqual({
      "x-openagents-provider": "fixture",
    });
    expect(capturedOptions?.providerOptions).toMatchObject({
      openai: {
        compatibility: "strict_false",
        promptCache: {
          cacheControl: "ephemeral",
          cacheKey: "prompt-cache.fixture",
        },
        reasoning: { effort: "low", enabled: true, maxTokens: 128 },
        schemaLowering: "json_schema",
        strictToolSchemas: false,
      },
    });

    expect(result.events.map((event) => event.kind)).toEqual([
      "turn.started",
      "text.delta",
      "text.delta",
      "step.finished",
      "turn.finished",
    ]);
    expect(result.events.every((event) => event.source.lane === "ai_sdk_core")).toBe(true);
    expect(result.events.every((event) => event.visibility === "private")).toBe(true);
    const projection = reduceKhalaRuntimeTranscript(result.events);
    expect(projection.textByMessageId["message.fixture"]).toBe("Hello world");
    const usageEvent = result.events.find((event) => event.kind === "turn.finished");
    expect(usageEvent?.kind).toBe("turn.finished");
    if (usageEvent?.kind === "turn.finished") {
      expect(usageEvent.usage?.totalTokens).toBe(5);
    }
    const providerEvent = result.events.find((event) => event.kind === "step.finished");
    expect(providerEvent?.kind).toBe("step.finished");
    if (providerEvent?.kind === "step.finished") {
      expect(providerEvent.providerMetadata?.metadataRefs[0]).toMatch(/^metadata\./);
    }
  });

  test("provider transform merges caller options without requiring an AI SDK Core fork", () => {
    const options = buildKhalaAiSdkCoreStreamTextOptions({
      headers: { "x-request": "one" },
      model: "fixture-model",
      prompt: "hello",
      provider,
      providerOptions: {
        openai: { existing: true },
        telemetry: { enabled: false },
      },
      tools: { echo: { description: "provided by test" } },
    });

    expect(options).toMatchObject({
      headers: {
        "x-openagents-provider": "fixture",
        "x-request": "one",
      },
      providerOptions: {
        openai: {
          compatibility: "strict_false",
          existing: true,
          promptCache: provider.promptCache,
          reasoning: provider.reasoning,
          schemaLowering: "json_schema",
          strictToolSchemas: false,
        },
        telemetry: { enabled: false },
      },
      tools: { echo: { description: "provided by test" } },
    });
  });

  test("raw provider chunks become private refs and never public transcript state", async () => {
    const secretRaw = {
      providerPayload: {
        path: "/Users/alice/.config/private-token",
        token: "sk-secret",
      },
    };
    const seenPrivateParts: unknown[] = [];
    const result = await collectKhalaAiSdkCoreEventsFromStream({
      onPrivateRawPart: ({ part }) => {
        seenPrivateParts.push(part);
      },
      observedAt: () => iso,
      stream: streamOf([{ rawValue: secretRaw, type: "raw" }]),
      threadId: "thread.ai_sdk_core.raw",
      turnId: "turn.ai_sdk_core.raw",
    });

    expect(seenPrivateParts).toEqual([{ rawValue: secretRaw, type: "raw" }]);
    expect(result.rawSidecars).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.kind).toBe("raw.sidecar_ref");
    expect(result.events[0]!.visibility).toBe("private");
    expect(JSON.stringify(result.events)).not.toContain("/Users/alice");
    expect(JSON.stringify(result.events)).not.toContain("sk-secret");
    expect(JSON.stringify(result.rawSidecars)).not.toContain("sk-secret");
  });

  test("AI SDK Core and existing AgentRuntimeEvent paths share the Khala runtime transcript consumer", async () => {
    const ai = await collectKhalaAiSdkCoreEventsFromStream({
      observedAt: () => iso,
      stream: streamOf([{ type: "text-delta", id: "message.shared", text: "AI SDK text" }]),
      threadId: "thread.shared",
      turnId: "turn.shared",
    });

    const pylonProjection = reduceAgentRuntimeEventsAsKhalaTranscript({
      events: [
        decodeAgentRuntimeEvent({
          tag: "model.text_delta",
          blockerRefs: [],
          eventId: "event.public.agent_runtime.shared",
          generatedAt: iso,
          part: { kind: "text", text: "Pylon text" },
          redactionClass: "public_ref",
          refs: [],
          runId: "run.shared",
          sequence: 1,
          stepRef: "message.shared",
          visibility: "public",
        }),
      ],
      source: { lane: "codex_app_server", surface: "server" },
      threadId: "thread.shared",
      turnId: "turn.shared",
    });
    const aiProjection = reduceKhalaRuntimeTranscript(ai.events);

    expect(aiProjection.textByMessageId["message.shared"]).toBe("AI SDK text");
    expect(pylonProjection.textByMessageId["message.shared"]).toBe("Pylon text");
  });
});
