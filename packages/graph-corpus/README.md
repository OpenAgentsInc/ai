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
- exact RLM source locators without an RLM projection or query adapter.

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

`GraphAdapterCapabilities` declares observed support for graph read, vector
read, hybrid query, atomic graph-vector projection, provenance delete
planning, and snapshot export. `requireGraphAdapterCapability` returns a typed
error for an operation that the adapter does not declare. A capability value
does not grant host authority.

The embedding descriptor identifies fields and dimensions only. Issue #35 owns
the later RLM projection. This package does not store vectors. Delete execution,
ranking mutation, archive, query, extraction, model, and database operations
are outside this package.
