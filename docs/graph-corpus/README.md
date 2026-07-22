# Graph corpus

`@openagentsinc/graph-corpus` is the portable derived-graph contract. Issue
#32 adds graph identity and provenance. Issue #33 adds adapter capabilities
and source-outward delete planning.

The source of truth remains an authorized source corpus. A graph element keeps
exact `RlmSourceLocator` values. It does not copy source text into provenance.
Issue #35 adds the RLM projection and citation adapter. Issue #36 adds a
separate ranking snapshot and used-element evidence.

## Identity

An element identity includes the graph schema, canonicalization version,
element kind, identity namespace, canonical key, identity scope, and canonical
source membership set. Thus, equal names in different namespaces or scopes do
not collide.

The graph digest includes decoded graph elements, derivation provenance,
policy, canonical ordering, merges, and embedding projection descriptors. It
does not include time or ranking state.

## Provenance

A deterministic derivation identifies its parser and version. A model
derivation identifies its extractor kind, DSE signature, compiled-program
digest, extraction-input digest, decode outcome, and usage receipt. The package
does not make the model call.

## Delete planning

The pure delete planner starts with one exact `RlmSourceLocator`. It binds the
plan to the graph digest, manifest digest, and derived-artifact inventory
digest. Each artifact plane has an explicit complete or incomplete coverage
claim. It separates source-membership removals, removable graph elements,
retained-element rekeys, merge changes, vectors, summaries, and ranking refs.

The planner keeps the remaining source support on a shared element. Because
source memberships are part of graph identity, the plan gives the old and new
refs for each retained entity or relation that changes. It also gives an owner
rekey action for each attached derived artifact. A rekey makes each old
artifact obsolete. The action is `RebuildRequired`, and the after inventory
does not contain the old artifact digest. A later host rebuild can add a new
artifact with a new digest.

An incomplete inventory produces an incomplete plan. A supported relation that
would lose an endpoint also produces an incomplete plan. A rekey collision also
stays incomplete. The SDK recomputes a plan from the current graph and exact
inventory before execution admission. The host owns authority, execution,
persistence, and the after-state.

Only a complete plan can produce an execution result and receipt. The complete
result requires the actual after graph and artifact inventory. Validation
rebuilds the expected after state and refuses orphan artifacts. An incomplete
plan can produce a separate `FailedBeforeExecution` refusal. The refusal has no
completed actions, after state, or receipt. A plan or receipt is not proof of
owner authorization.

## Capabilities

The capability set is descriptive. It covers graph read, vector read, hybrid
query, atomic graph-vector projection, provenance delete planning, and snapshot
export. An unsupported operation returns a typed capability error. Capability
declaration does not grant authority.

## Limits

The current handle is for small in-memory snapshots. The RLM adapter supplies
bounded lookup, neighbor, source-expansion, text, vector, and hybrid
operations. Vector and hybrid operations bind the descriptor ref into the
operation digest. They also bind the complete vector artifact inventory digest
and retrieval inventory digest. They require both complete inventories.

The ranking contract accepts one exact operation binding and a separately
supplied `expectedOperationDigest`. The verifier checks this trusted expected
identity, reconstructs deterministic operation results, and checks each result
against the current projected corpus. Vector and hybrid verification also
requires the complete artifact and retrieval inventories. Ranking changes a
separate snapshot. It does not change graph truth or remove a result.

Content hashes prove integrity. They do not grant authority or prove who
approved an operation. The package gives no owner consent, promotion,
persistence, delete execution, archive, database, or product-query authority.
