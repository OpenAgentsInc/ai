import { Schema as S } from "effect";
import {
  RlmBoundedText,
  RlmDigest,
  RlmNonNegativeCount,
  RlmRef,
  RlmRunRef,
  RlmValueRef,
} from "./primitives.ts";
import { RlmTerminalResult } from "./request-result.ts";

export const RlmEventBase = {
  runRef: RlmRunRef,
  eventSequence: RlmNonNegativeCount,
  atMs: RlmNonNegativeCount,
} as const;

export const RlmRunStarted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("RunStarted"),
  mode: S.Literals(["deterministic", "semantic"]),
});
export type RlmRunStarted = typeof RlmRunStarted.Type;

export const RlmCorpusResolved = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("CorpusResolved"),
  corpusRef: RlmRef,
  contentDigest: RlmDigest,
  entryCount: RlmNonNegativeCount,
});
export type RlmCorpusResolved = typeof RlmCorpusResolved.Type;

export const RlmIterationStarted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("IterationStarted"),
  depth: RlmNonNegativeCount,
  iteration: RlmNonNegativeCount,
});
export type RlmIterationStarted = typeof RlmIterationStarted.Type;

export const RlmProgramSelected = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("ProgramSelected"),
  programRef: RlmRef,
  nodeCount: RlmNonNegativeCount,
});
export type RlmProgramSelected = typeof RlmProgramSelected.Type;

export const RlmProgramNodeStarted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("ProgramNodeStarted"),
  nodeRef: RlmRef,
  kind: RlmRef,
});
export type RlmProgramNodeStarted = typeof RlmProgramNodeStarted.Type;

export const RlmProgramNodeCompleted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("ProgramNodeCompleted"),
  nodeRef: RlmRef,
  kind: RlmRef,
});
export type RlmProgramNodeCompleted = typeof RlmProgramNodeCompleted.Type;

export const RlmObservationCompleted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("ObservationCompleted"),
  observationChars: RlmNonNegativeCount,
  detailSafe: S.optionalKey(RlmBoundedText),
});
export type RlmObservationCompleted = typeof RlmObservationCompleted.Type;

export const RlmValuePublished = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("ValuePublished"),
  valueRef: RlmValueRef,
  digest: RlmDigest,
  encodedBytes: RlmNonNegativeCount,
});
export type RlmValuePublished = typeof RlmValuePublished.Type;

export const RlmMapStarted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("MapStarted"),
  nodeRef: RlmRef,
  kind: S.Literals(["ModelMap", "RlmMap"]),
  itemCount: RlmNonNegativeCount,
});
export type RlmMapStarted = typeof RlmMapStarted.Type;

export const RlmMapCompleted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("MapCompleted"),
  nodeRef: RlmRef,
  kind: S.Literals(["ModelMap", "RlmMap"]),
  itemCount: RlmNonNegativeCount,
});
export type RlmMapCompleted = typeof RlmMapCompleted.Type;

export const RlmModelCallCompleted = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("ModelCallCompleted"),
  callRef: RlmRef,
  role: S.Literals(["root", "leaf"]),
  inputTokens: S.optionalKey(RlmNonNegativeCount),
  outputTokens: S.optionalKey(RlmNonNegativeCount),
  /** Refs of the operation(s) that triggered this model call (root run ref or program node ref). */
  causalityRefs: S.optionalKey(S.Array(RlmRef)),
  /** True when the model response carried exact input and output token usage. */
  usageExact: S.optionalKey(S.Boolean),
});
export type RlmModelCallCompleted = typeof RlmModelCallCompleted.Type;

export const RlmTerminalEvent = S.Struct({
  ...RlmEventBase,
  _tag: S.tag("Terminal"),
  result: RlmTerminalResult,
});
export type RlmTerminalEvent = typeof RlmTerminalEvent.Type;

export const RlmEvent = S.Union([
  RlmRunStarted,
  RlmCorpusResolved,
  RlmIterationStarted,
  RlmProgramSelected,
  RlmProgramNodeStarted,
  RlmProgramNodeCompleted,
  RlmObservationCompleted,
  RlmValuePublished,
  RlmMapStarted,
  RlmMapCompleted,
  RlmModelCallCompleted,
  RlmTerminalEvent,
]);
export type RlmEvent = typeof RlmEvent.Type;
