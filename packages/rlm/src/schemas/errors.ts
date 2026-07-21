import { Schema as S } from "effect";
import { RlmBoundedText } from "./primitives.ts";

export const RlmErrorReason = S.Literals([
  "invalid_request",
  "invalid_budget",
  "corpus_unavailable",
  "corpus_changed",
  "model_authentication",
  "model_quota_exhausted",
  "model_rate_limited",
  "model_unavailable",
  "program_contract_violation",
  "operation_contract_violation",
  "value_unavailable",
  "artifact_unavailable",
  "per_call_limit_exceeded",
  "usage_required_but_unavailable",
  "authority_not_granted",
  "invariant_violation",
]);
export type RlmErrorReason = typeof RlmErrorReason.Type;

export class RlmError extends S.TaggedErrorClass<RlmError>()("Rlm.Error", {
  reason: RlmErrorReason,
  retryable: S.Boolean,
  detailSafe: S.optionalKey(RlmBoundedText),
}) {}

export class RlmCorpusError extends S.TaggedErrorClass<RlmCorpusError>()("Rlm.CorpusError", {
  reason: S.Literals([
    "unavailable",
    "changed",
    "invalid_inline",
    "byte_ceiling",
    "invalid_range",
    "invalid_address",
  ]),
  detailSafe: S.optionalKey(RlmBoundedText),
}) {}
