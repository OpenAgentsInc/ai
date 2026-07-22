import { describe, expect, test } from "vite-plus/test";

import { PREDICT_RECEIPT_SCHEMA_LITERAL, PredictReceipt } from "../contract/artifact.js";
import { predictReceiptToRuntimeEvents } from "./events.js";
import { Schema as S } from "effect";

const receipt = (usageTruth: "exact" | "estimated" | "unknown") =>
  S.decodeUnknownSync(PredictReceipt)({
    schema: PREDICT_RECEIPT_SCHEMA_LITERAL,
    receiptId: `receipt:${"a".repeat(64)}`,
    signatureId: "Example/Answer.v1",
    candidateId: `cand:${"b".repeat(64)}`,
    promptDigest: "c".repeat(64),
    outputDigest: "d".repeat(64),
    decodeOutcome: "decoded",
    repairCount: 0,
    usageTruth,
    outputChars: 12,
    observedAt: "2026-07-21T12:00:00.000Z",
  });

const context = {
  eventIdPrefix: "dse.predict.1",
  turnId: "turn.1",
  threadId: "thread.1",
  stepId: "dse.predict",
  firstSequence: 10,
  source: { lane: "ai_sdk_core" as const },
  visibility: "private" as const,
  redactionClass: "private_ref" as const,
  causalityRefs: ["request.1"],
};

describe("DSE neutral runtime-event projection", () => {
  test("projects a contiguous lifecycle and observed exact usage", () => {
    const events = predictReceiptToRuntimeEvents({
      receipt: receipt("exact"),
      context,
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
    });

    expect(events.map((event) => event.kind)).toEqual([
      "step.started",
      "usage.recorded",
      "step.finished",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([10, 11, 12]);
    const usageEvent = events[1];
    expect(usageEvent?.kind).toBe("usage.recorded");
    if (usageEvent?.kind !== "usage.recorded") throw new Error("missing usage event");
    expect(usageEvent).toMatchObject({
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      providerMetadata: { metadataRefs: ["dse.usage_truth.exact", "dse.decode_outcome.decoded"] },
    });
  });

  test("keeps unknown usage explicit and never fabricates zero counts", () => {
    const events = predictReceiptToRuntimeEvents({ receipt: receipt("unknown"), context });
    const usageEvent = events[1];
    expect(usageEvent?.kind).toBe("usage.recorded");
    if (usageEvent?.kind !== "usage.recorded") throw new Error("missing usage event");
    expect(usageEvent).toMatchObject({ usage: { usageRef: "dse.predict.1.usage" } });
    expect(usageEvent.providerMetadata?.metadataRefs).toContain("dse.usage_truth.unknown");
    expect(usageEvent).not.toHaveProperty("usage.inputTokens");
    expect(usageEvent).not.toHaveProperty("usage.outputTokens");
    expect(usageEvent).not.toHaveProperty("usage.totalTokens");
  });

  test("rejects numeric counts when usage truth is unknown", () => {
    expect(() =>
      predictReceiptToRuntimeEvents({
        receipt: receipt("unknown"),
        context,
        usage: { totalTokens: 0 },
      }),
    ).toThrow("unknown usage cannot carry numeric token counts");
  });
});
