import { describe, expect, test } from "vite-plus/test";
import { buildInlineCorpusInput } from "../corpus/handle.ts";
import { computeContentDigest, canonicalJson } from "../corpus/digest.ts";

describe("RLM corpus digests", () => {
  test("builtAt does not affect digests", () => {
    const a = buildInlineCorpusInput({
      corpusRef: "c1",
      scopeRef: "s",
      entries: [
        {
          scopeRef: "s",
          sourceKind: "k",
          sourceAddress: { addressSchemaId: "a", encodedAddress: "1" },
          text: "hello",
          visibility: "public",
          redactionClass: "none",
        },
      ],
    });
    const m1 = { ...a.manifest, builtAt: "2020-01-01T00:00:00.000Z" };
    const m2 = { ...a.manifest, builtAt: "2030-01-01T00:00:00.000Z" };
    expect(m1.contentDigest).toBe(m2.contentDigest);
    expect(a.manifest.contentDigest).toBe(
      computeContentDigest({
        scopeRef: a.manifest.scopeRef,
        ordering: a.manifest.ordering,
        entries: a.entries,
      }),
    );
  });

  test("canonicalJson sorts keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});
