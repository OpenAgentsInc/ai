# RLM corpus v2 migration

RLM corpus v2 adds source planes, policy facts, source locators, and composite
identity. These fields change canonical bytes and digests. The SDK does not
interpret v1 bytes as v2 bytes.

## Required migration

Use `migrateRlmCorpusV1` for an inline v1 corpus. You must supply two facts:

1. Supply the correct source plane.
2. Supply the policy that authorized the corpus.

```ts
const current = migrateRlmCorpusV1(legacy, {
  sourcePlane: "repository",
  policy: {
    includeVisibilities: ["public"],
    includeRedactionClasses: ["none"],
  },
});
```

The migration computes new content and manifest digests. It does not preserve
the v1 digests. It does not infer a source plane from `sourceKind`. It does not
grant access to a visibility class or redaction class.

The `RlmCorpusInput` decoder accepts valid v1 bytes for inspection. The inline
source layer refuses these bytes with `legacy_requires_migration`. It also
rejects a v1 manifest with v2 entries and a v2 manifest with v1 entries.

## Handle migration

An application handle must implement `assertUnchanged` and
`validateSourceLocator`. Engine paths use `read` and `scan`. The compatibility
method `materializeAll` remains in v2, but the engine does not require it.

An application must resolve a stored v1 source through an explicit migration
step. A composite constructor accepts v2 child handles only. It also requires
a trusted `RlmCompositeProjection`. The projection summary and pointer index
must have digest bindings. Use the hard-capped in-memory builder only for small
fixtures.
