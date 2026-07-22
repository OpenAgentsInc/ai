# DSE normative contract

**Status:** normative for the current public package

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY state
requirements in this document.

## 1. Program identity

1. A model Program MUST bind one `DseSignature<I, O>` to one
   `CandidateArtifact`.
2. The signature ID on the signature, artifact, and compiled program MUST be
   equal.
3. A consumer MUST treat artifact bytes as immutable.
4. A changed covered field MUST produce a different artifact digest and
   candidate ID.
5. `RlmProgram` MUST remain a separate name for a run-scoped symbolic query
   plan.

## 2. Signature and decode

1. A signature MUST provide Effect Schema input and output codecs.
2. Effect Schema decode MUST be the only output validity authority.
3. A model response MUST NOT become a typed result before decode succeeds.
4. Repair MUST be bounded by `DecodePolicy.maxRepairs`.
5. A repair attempt and its count MUST be visible in the predict receipt.
6. A failed final decode MUST return `DseDecodeError`.

## 3. Datasets and evaluation

1. A dataset revision MUST be content-addressed over its ordered examples.
2. A split MUST contain non-empty train, validation, and holdout sets.
3. Holdout examples MUST NOT occur in train or validation.
4. Validation examples MUST NOT occur in train.
5. Search MUST score candidates on validation.
6. Search MUST score only the selected winner on holdout.
7. Resource savings MUST NOT raise a reward above its quality score.
8. An evaluation report MUST record its usage truth. Unknown usage MUST NOT be
   encoded as zero.

## 4. Compile and runtime authority

1. Candidate generation MUST be deterministic, deduplicated, and capped.
2. Compile MUST enforce the admitted candidate and rollout caps.
3. Compile MUST emit an immutable proposal. It MUST NOT activate that proposal.
4. The runtime root and `/runtime` subpath MUST NOT export compile or promotion
   operations.
5. The `/optimizer` subpath MUST be an explicit import.
6. Runtime resolution MUST verify the artifact reference, digest, signature,
   and promotion record before it returns a program.
7. The package MUST NOT select credentials, providers, deployment targets, or
   application release policy.

## 5. Promotion and activation

1. A producer MUST NOT admit its own promotion request.
2. A review MUST match the promotion, candidate, and holdout report identities.
3. The holdout delta MUST meet the request floor.
4. A release channel MUST preserve a content-addressed baseline.
5. Shadow mode MUST serve the baseline.
6. Canary mode MUST have a bounded plan.
7. Each activation or rollback transition MUST emit a receipt.

## 6. Neutral runtime events

1. DSE MUST NOT define a second runtime-event union.
2. `predictReceiptToRuntimeEvents` MUST return decoded
   `KhalaRuntimeEvent` values.
3. The projection MUST use contiguous caller-owned sequence numbers.
4. The projection MUST emit step start, usage, and step finish events.
5. Usage truth MUST remain visible in a safe metadata reference.
6. When usage truth is `unknown`, the projection MUST reject numeric counts and
   MUST NOT fabricate zero values.

## 7. Portability

The DSE package MUST NOT import a provider SDK, provider credential, Desktop
runtime, cloud client, deployment client, or Node host API. The consumer MUST
inject the `DseModel` service and enact any release decision.
