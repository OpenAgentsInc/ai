# DSE — Declarative Self-Improving Effect

**Status:** implemented public SDK contract

DSE is the canonical model-program abstraction in the OpenAgents AI SDK. A
Program binds one typed `DseSignature<I, O>` to one immutable, content-addressed
candidate artifact. `RlmProgram` keeps its explicit name because it is a
run-scoped symbolic query plan, not a compiled model program.

DSE turns a prompt into a typed and evaluated artifact. It uses Effect Schema
as the output validity authority. It keeps dataset revisions and evaluation
splits immutable. It bounds candidate search and repair. It records prediction,
promotion, activation, and rollback receipts.

The package is portable. It imports no provider SDK, app policy, credential,
deployment client, or host API. A consumer injects the model port and owns all
provider, release, and activation authority.

## Read next

- [Normative contract](./SPEC.md)
- [Public API](./PUBLIC-API.md)
- [Package README](../../packages/dse/README.md)
- [SDK roadmap](../ROADMAP.md#phase-2--dse-programs-the-dspy-of-effect)

## Package boundaries

- `@openagentsinc/dse` exports the contract and portable runtime.
- `@openagentsinc/dse/contract` exports schemas and pure contract operations.
- `@openagentsinc/dse/runtime` exports prediction, resolution, activation, and
  neutral runtime-event projection. It has no compile authority.
- `@openagentsinc/dse/optimizer` exports bounded offline compilation,
  evaluation, search, uncertainty, and promotion. It is an explicit import.
- `@openagentsinc/dse/test` exports deterministic test fixtures.

The `@openagentsinc/ai/program*` subpaths relay these boundaries. The umbrella
root does not re-export optimizer authority.

## Origin and extraction

The first implementation came from
`OpenAgentsInc/openagents@d13d816c448a60c1f8546bbd296d9ec2ca659c7e` under
`packages/dse`. The AI SDK now owns the package implementation. OpenAgents must
consume a published SDK train and remove its duplicate package in a separate
consumer change.
