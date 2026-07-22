# DSE public API

This page describes the intentional public entry points. The package exports
TypeScript source and requires Effect v4 from the converged SDK train.

## Root: `@openagentsinc/dse`

The root exports the portable contract and runtime. It does not export the
optimizer.

Key contract exports:

- `DseSignature<I, O>`, `makeSignature`, and `SignatureContract`
- `Program<I, O>`, `DseProgram<I, O>`, and `bindProgram`
- `PromptIr`, `CompiledProgram`, `CandidateArtifact`, and
  `ReleasedArtifactPointer`
- `DatasetRevision`, `DatasetSplit`, `makeDatasetRevision`, and
  `buildDatasetSplit`
- `Metric`, `EvaluationReport`, and `rewardBundle`
- `SearchPlan`, `ResourceBudget`, and `makeSearchPlan`
- promotion, activation, rollback, predict, and uncertainty receipt schemas

Key runtime exports:

- `DseModel` and `DseModelError`
- `predict`, `renderPrompt`, `DseDecodeError`, and `PredictOutcome`
- `resolveReleasedArtifact`, `rollback`, and their typed failures
- release-channel transition and resolution functions
- `predictReceiptToRuntimeEvents`, `PredictEventProjectionContext`, and
  `DsePredictUsageCounts`

## Contract: `@openagentsinc/dse/contract`

This subpath exports portable schemas, types, constructors, digest operations,
the signature registry, and the generated catalog. It imports no runtime or
optimizer operation.

## Runtime: `@openagentsinc/dse/runtime`

This subpath resolves exact released artifact bytes, runs prediction through an
injected model service, manages portable activation state, and projects predict
receipts onto `KhalaRuntimeEvent`. It does not export `compileSignature`,
`generateCandidates`, `evaluateCandidate`, or `promote`.

## Optimizer: `@openagentsinc/dse/optimizer`

This explicit subpath exports `generateCandidates`, `evaluateCandidate`,
`compileSignature`, `promote`, and `computeUncertainty`. A runtime application
must not import it.

## Test: `@openagentsinc/dse/test`

This subpath exports deterministic model layers, fixed dependencies, datasets,
metrics, and compiled-program fixtures. It has no provider or network use.

## Umbrella paths

The `@openagentsinc/ai` package provides these deliberate relays:

- `@openagentsinc/ai/program`
- `@openagentsinc/ai/program/contract`
- `@openagentsinc/ai/program/runtime`
- `@openagentsinc/ai/program/optimizer`
- `@openagentsinc/ai/program/test`

The `@openagentsinc/ai` root exposes the DSE contract and portable runtime under
the `Dse` namespace. This avoids collisions with the neutral runtime schema. The
namespace does not include optimizer exports.
