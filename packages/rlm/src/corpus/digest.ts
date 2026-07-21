import { createHash } from "node:crypto";
import type { RlmCorpusEntry, RlmCorpusManifest } from "../schemas/corpus.ts";
import type { RlmDigest } from "../schemas/primitives.ts";

/** Stable JSON for digests — sorted object keys, no undefined. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
};

export const sha256Hex = (input: string): RlmDigest =>
  createHash("sha256").update(input, "utf8").digest("hex");

/** Content digest: admitted entry bytes + ordering + scope. Ignores builtAt. */
export const computeContentDigest = (input: {
  readonly scopeRef: string;
  readonly ordering: RlmCorpusManifest["ordering"];
  readonly entries: ReadonlyArray<RlmCorpusEntry>;
}): RlmDigest => {
  const payload = {
    scopeRef: input.scopeRef,
    ordering: input.ordering,
    entries: input.entries.map((e) => ({
      ordinal: e.ordinal,
      entryRef: e.entryRef,
      scopeRef: e.scopeRef,
      sourceKind: e.sourceKind,
      sourceAddress: e.sourceAddress,
      text: e.text,
      visibility: e.visibility,
      redactionClass: e.redactionClass,
      // observedAt intentionally excluded from content digest stability
    })),
  };
  return sha256Hex(canonicalJson(payload));
};

/** Manifest digest includes coverage/exclusions honesty facts. */
export const computeManifestDigest = (input: {
  readonly contentDigest: RlmDigest;
  readonly coverage: RlmCorpusManifest["coverage"];
  readonly scopeRef: string;
  readonly ordering: RlmCorpusManifest["ordering"];
}): RlmDigest =>
  sha256Hex(
    canonicalJson({
      contentDigest: input.contentDigest,
      coverage: input.coverage,
      scopeRef: input.scopeRef,
      ordering: input.ordering,
    }),
  );

export const excerptDigest = (excerpt: string): RlmDigest => sha256Hex(excerpt);
