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

The embedding descriptor identifies fields and dimensions only. Issue #35 owns
the later RLM projection. This package
does not store vectors. Ranking, deletion, archive, query, extraction, model,
and database operations are outside this package.
