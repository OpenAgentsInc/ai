import { Schema as S } from "effect";

/** Non-empty safe ref token (wire identity). */
export const RlmRef = S.NonEmptyString;
export type RlmRef = typeof RlmRef.Type;

export const RlmCorpusRef = RlmRef;
export type RlmCorpusRef = typeof RlmCorpusRef.Type;

export const RlmRunRef = RlmRef;
export type RlmRunRef = typeof RlmRunRef.Type;

export const RlmValueRef = RlmRef;
export type RlmValueRef = typeof RlmValueRef.Type;

export const RlmNodeRef = RlmRef;
export type RlmNodeRef = typeof RlmNodeRef.Type;

export const RlmEntryRef = RlmRef;
export type RlmEntryRef = typeof RlmEntryRef.Type;

export const RlmScopeRef = RlmRef;
export type RlmScopeRef = typeof RlmScopeRef.Type;

export const RlmSchemaRef = RlmRef;
export type RlmSchemaRef = typeof RlmSchemaRef.Type;

export const RlmStrategyRef = RlmRef;
export type RlmStrategyRef = typeof RlmStrategyRef.Type;

/** Hex digest (sha-256 recommended). */
export const RlmDigest = S.NonEmptyString;
export type RlmDigest = typeof RlmDigest.Type;

export const RlmCorpusDigest = RlmDigest;
export type RlmCorpusDigest = typeof RlmCorpusDigest.Type;

export const RlmManifestDigest = RlmDigest;
export type RlmManifestDigest = typeof RlmManifestDigest.Type;

/** Non-negative integer count. */
export const RlmNonNegativeCount = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0));
export type RlmNonNegativeCount = typeof RlmNonNegativeCount.Type;

/** Positive integer count. */
export const RlmPositiveCount = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1));
export type RlmPositiveCount = typeof RlmPositiveCount.Type;

export const RlmDepth = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0));
export type RlmDepth = typeof RlmDepth.Type;

export const RlmPositiveMilliseconds = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1));
export type RlmPositiveMilliseconds = typeof RlmPositiveMilliseconds.Type;

export const RlmOrdinal = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0));
export type RlmOrdinal = typeof RlmOrdinal.Type;

/** Bounded model-facing text. */
export const RlmBoundedText = S.String;
export type RlmBoundedText = typeof RlmBoundedText.Type;

export const RlmBoundedOutput = S.String;
export type RlmBoundedOutput = typeof RlmBoundedOutput.Type;

export const RlmVisibility = S.Literals(["public", "operator", "private"]);
export type RlmVisibility = typeof RlmVisibility.Type;

export const RlmRedactionClass = S.Literals(["none", "private_ref", "redacted", "secret"]);
export type RlmRedactionClass = typeof RlmRedactionClass.Type;
