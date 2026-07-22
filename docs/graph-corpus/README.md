# Graph corpus

`@openagentsinc/graph-corpus` is the portable derived-graph contract. Issue
#32 adds the first implementation.

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

## Limits

The current handle is for small in-memory snapshots. It gives no owner consent,
promotion, persistence, deletion, ranking, archive, database, or query
authority. Later issues own those contracts.
