# `@openagentsinc/graph-corpus`

This package builds an immutable derived graph from authorized source refs. It
does not read source text. It does not call a model or a database.

The package supplies:

- Effect Schemas for mentions, canonical entities, relations, source
  memberships, merge evidence, embedding projection descriptors, snapshots,
  and manifests;
- versioned and branded graph refs;
- deterministic SHA-256 element, graph, and manifest identities;
- separate deterministic-parser and model-derivation provenance;
- a small in-memory snapshot handle; and
- descriptive adapter capabilities with typed unsupported-operation errors;
- a pure, source-outward delete planner with complete artifact accounting;
- digest-bound host execution-result and receipt contracts; and
- an immutable RLM v2 projection with exact graph and original source
  locators; and
- bounded graph lookup, traversal, source expansion, and safe text search; and
- deterministic fixed-point feedback snapshots and bounded ranking evidence.

```ts
import {
  buildGraphCorpus,
  makeCanonicalEntity,
  makeGraphMention,
} from "@openagentsinc/graph-corpus";

const mention = makeGraphMention({
  identityNamespace: "people",
  canonicalKey: "person:42:mention:1",
  identityScopeRef: "account:7",
  source: exactRlmSourceLocator,
  derivation: {
    _tag: "Deterministic",
    parserRef: "contacts.v1",
    parserVersion: "1.0.0",
  },
});

const entity = makeCanonicalEntity({
  identityNamespace: "people",
  canonicalKey: "person:42",
  identityScopeRef: "account:7",
  mentions: [mention],
  derivation: mention.derivation,
});

const built = await Effect.runPromise(
  buildGraphCorpus({
    graphRef: "contacts.graph",
    scopeRef: "account:7",
    policy,
    mentions: [mention],
    entities: [entity],
    relations: [],
  }),
);
```

Identity does not use a display name alone. It binds the graph schema,
canonicalization version, element kind, identity namespace, canonical key,
scope, and exact supporting source locators. Input array order does not change
the graph digest.

## Delete planning

`planGraphSourceDeletion` accepts one exact `RlmSourceLocator`, one immutable
graph snapshot and manifest, and one digest-bound artifact inventory. Each
vector, summary, and ranking plane has an explicit coverage claim. The plan
lists source-membership removals, removable elements, retained-element rekeys,
merge changes, and separate vector, summary, and ranking-ref actions. It keeps
other source support on shared elements.

An incomplete inventory produces an incomplete plan. A relation that keeps
source support but loses an endpoint also produces an incomplete plan. Use
`requireExecutableGraphDeletePlan` to reject incomplete or stale plans before
a host applies them. A plan describes intended work only. It does not grant
authority and it does not prove that deletion occurred.

The host can record work with `GraphDeleteExecutionResult` and
`GraphDeleteReceipt`. A complete result requires the actual after graph and
artifact inventory. The validator rebuilds the expected after state and checks
all action refs and digests. Only a complete plan can produce a result or
receipt. An incomplete plan can produce a separate
`GraphDeletePreExecutionRefusal`. The refusal has no completed actions and no
after-state digest. This package does not execute the plan.

## Adapter capabilities

`GraphAdapterCapabilities` declares observed support for graph read, RLM v2
projection, vector read, hybrid query, atomic graph-vector projection,
provenance delete planning, and snapshot export.
`requireGraphAdapterCapability` returns a typed error for an operation that the
adapter does not declare. A capability value does not grant host authority.

## RLM v2 graph projection

`makeGraphRlmProjection` adapts one verified graph snapshot to one RLM v2
corpus. The graph and RLM identities are separate. Each RLM entry has a graph
element address that binds the graph ref, scope, graph digest, and manifest
digest. Each entry also keeps its complete set of original RLM source
locators.

The caller must supply the `rlm_v2_projection` capability and a complete
classification projection. The classification gives one visibility and one
redaction class for each readable graph element. Its digest binds it to the
graph and to the complete identity, policy, and coverage of each supporting
leaf corpus. The classification must be the most restrictive visibility and
redaction class in the supporting source set. The adapter rejects a missing
element, a duplicate element, a composite support handle, a policy widening,
or a stale digest.

`makeGraphRlmCorpusSource` resolves only registered, exact graph source refs.
The projected handle checks the graph, classification, and authorized
supporting corpora before each read. This check makes graph citations and their
original supporting locators valid through the RLM citation interface.

The graph operators require all six limits: depth, visited elements, returned
elements, source addresses, characters per result, and total observation
characters. Each result is `Complete` or `Truncated`. A truncated result lists
each limit that it hit. Text search reads only canonical identity keys and
relation kinds. It does not read source text.

Vector and hybrid search are optional callbacks. They require exact adapter
capabilities, a current complete vector inventory, and a complete retrieval
binding. The retrieval binding joins each vector artifact and owner to one
explicit embedding descriptor, schema, and dimension. Requests and responses
bind all graph, inventory, retrieval, descriptor, and limit values. Scores use
fixed-point micro-units. The adapter rejects stale inventories, incomplete
bindings, oversized responses, and result refs that are not in the current
graph.

This adapter uses the graph package's hard-capped in-memory snapshot. Projection
is eager. Source resolution does not scan or materialize the RLM corpus and does
not call an optional search adapter. This package does not claim out-of-core
graph support.

## Ranking feedback

`makeGraphFeedbackObservation` binds feedback to one exact graph element and
one complete RLM operation identity. `makeGraphRankingSnapshot` creates a
separate immutable snapshot from feedback and optional confidence evidence.
It uses fixed-point micro-units. It does not change graph content, graph
identity, provenance, embedding descriptors, or vector bytes.

`rankGraphOperationResult` applies ranking state only to a complete operation
result. With a ranking snapshot, it orders candidates by feedback, confidence,
operation-local relevance, and element ref. Without a snapshot, it returns an
explicit `Unranked` result and keeps the operation order. A truncated result
also stays `Unranked` and keeps its cap evidence. Missing features, confidence,
and relevance stay explicit. The operation does not remove candidates.

The ranking API accepts a separate `GraphRankingOperationBinding` for all six
graph operations. Text bindings contain the exact normalized text query.
Vector bindings contain a descriptor ref and a vector digest, not vector
bytes. The caller must also supply a trusted `expectedOperationDigest`.
`verifyGraphRankingOperationResult` checks this expected identity and
reconstructs the #35 operation receipt. It also checks the current graph, the
projected RLM corpus, source support, counters, limits, and deterministic result
membership. Vector and hybrid verification requires the complete vector
artifact inventory and retrieval inventory. The operation binding includes
their digests, and the #35 operation receipt binds them. The query binding
produces a separate domain-specific query digest for ranking evidence. Content
digests prove integrity. They do not grant authority or prove who approved an
operation.

Used-element evidence contains exact graph and RLM identity, query, operation,
result, and limit digests, ordered element refs, exact bounded graph addresses,
exact supporting source locators, and fixed-point scores. It does not copy
source text or canonical keys. Use
`validateGraphUsedElementEvidence` to reject stale or substituted evidence.
Use `rankingArtifactsFromSnapshot` with the current graph and exact RLM
projection context to add validated ranking artifacts to a delete-planning
inventory.

The embedding descriptor identifies fields and dimensions only. This package
does not store vectors. Natural-language graph queries, Cypher, model calls,
storage, delete execution, and product wiring are outside this package.
