import { Schema as S } from "effect";
import {
  decodeKhalaRuntimeEvent,
  KhalaRuntimeEventSchemaLiteral,
  type AgentRuntimeRedactionClass,
  type AgentRuntimeVisibility,
  type KhalaRuntimeCausalityRef,
  type KhalaRuntimeEvent,
  type KhalaRuntimeSafeRef,
  type KhalaRuntimeSource,
  type KhalaRuntimeThreadId,
  type KhalaRuntimeTurnId,
} from "@openagentsinc/agent-runtime-schema";

import type { PredictReceipt } from "../contract/index.js";

/** Optional observed counts. Missing counts stay missing and never become zero. */
export const DsePredictUsageCounts = S.Struct({
  inputTokens: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
  outputTokens: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
  reasoningTokens: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
  cacheReadInputTokens: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
  cacheWriteInputTokens: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
  totalTokens: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
});
export type DsePredictUsageCounts = typeof DsePredictUsageCounts.Type;

export interface PredictEventProjectionContext {
  readonly eventIdPrefix: KhalaRuntimeSafeRef;
  readonly turnId: KhalaRuntimeTurnId;
  readonly threadId: KhalaRuntimeThreadId;
  readonly stepId: KhalaRuntimeSafeRef;
  readonly firstSequence: number;
  readonly source: KhalaRuntimeSource;
  readonly visibility: AgentRuntimeVisibility;
  readonly redactionClass: AgentRuntimeRedactionClass;
  readonly causalityRefs: ReadonlyArray<KhalaRuntimeCausalityRef>;
  readonly syncScopeRef?: KhalaRuntimeSafeRef;
}

const decodeUsageCounts = S.decodeUnknownSync(DsePredictUsageCounts);

/**
 * Project a completed DSE prediction onto the existing neutral event union.
 *
 * The adapter emits a contiguous step-start, usage, and step-finish sequence.
 * It does not create a DSE event vocabulary. Usage truth is an explicit safe
 * metadata reference. When truth is unknown, numeric counts are prohibited and
 * the neutral usage event contains no fabricated zero values.
 */
export const predictReceiptToRuntimeEvents = (args: {
  readonly receipt: PredictReceipt;
  readonly context: PredictEventProjectionContext;
  readonly usage?: DsePredictUsageCounts;
}): ReadonlyArray<KhalaRuntimeEvent> => {
  if (
    args.receipt.usageTruth === "unknown" &&
    args.usage !== undefined &&
    Object.keys(args.usage).length > 0
  ) {
    throw new RangeError("DSE unknown usage cannot carry numeric token counts");
  }
  const usage = args.usage === undefined ? {} : decodeUsageCounts(args.usage);
  const { context, receipt } = args;
  const base = {
    schema: KhalaRuntimeEventSchemaLiteral,
    turnId: context.turnId,
    threadId: context.threadId,
    observedAt: receipt.observedAt,
    source: context.source,
    visibility: context.visibility,
    redactionClass: context.redactionClass,
    causalityRefs: context.causalityRefs,
    ...(context.syncScopeRef === undefined ? {} : { syncScopeRef: context.syncScopeRef }),
  } as const;
  const providerMetadata = {
    metadataRefs: [
      `dse.usage_truth.${receipt.usageTruth}`,
      `dse.decode_outcome.${receipt.decodeOutcome}`,
    ],
  } as const;

  return [
    decodeKhalaRuntimeEvent({
      ...base,
      kind: "step.started",
      eventId: `${context.eventIdPrefix}.started`,
      sequence: context.firstSequence,
      stepId: context.stepId,
    }),
    decodeKhalaRuntimeEvent({
      ...base,
      kind: "usage.recorded",
      eventId: `${context.eventIdPrefix}.usage`,
      sequence: context.firstSequence + 1,
      usage: {
        usageRef: `${context.eventIdPrefix}.usage`,
        ...usage,
      },
      providerMetadata,
    }),
    decodeKhalaRuntimeEvent({
      ...base,
      kind: "step.finished",
      eventId: `${context.eventIdPrefix}.finished`,
      sequence: context.firstSequence + 2,
      stepId: context.stepId,
      finishReason: "stop",
      usage: {
        usageRef: `${context.eventIdPrefix}.usage`,
        ...usage,
      },
      providerMetadata,
    }),
  ];
};
