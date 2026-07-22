# Graph corpus

`@openagentsinc/graph-corpus` is the portable derived-graph contract. Issue
#32 adds graph identity and provenance. Issue #33 adds adapter capabilities
and source-outward delete planning.

The source of truth remains an authorized source corpus. A graph element keeps
exact `RlmSourceLocator` values. It does not copy source text into provenance.
Issue #35 owns the later RLM projection and citation adapter.

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
rekey action for each attached derived artifact.

An incomplete inventory produces an incomplete plan. A supported relation that
would lose an endpoint also produces an incomplete plan. A rekey collision also
stays incomplete. The SDK recomputes a plan from the current graph and exact
inventory before execution admission. The host owns authority, execution,
persistence, and the after-state.

Execution-result and receipt schemas have separate complete, incomplete, and
failed variants. A complete result requires the actual after graph and artifact
inventory. Validation rebuilds the expected after state and refuses orphan
artifacts. A plan or receipt is not proof of owner authorization.

## Capabilities

The capability set is descriptive. It covers graph read, vector read, hybrid
query, atomic graph-vector projection, provenance delete planning, and snapshot
export. An unsupported operation returns a typed capability error. Capability
declaration does not grant authority.

## Limits

The current handle is for small in-memory snapshots. It gives no owner consent,
promotion, persistence, delete execution, ranking, archive, database, or query
authority. Later issues own those contracts.
