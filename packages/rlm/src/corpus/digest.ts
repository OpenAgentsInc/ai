import { createHash } from "node:crypto";
import type { RlmCorpusComposition, RlmCorpusEntry, RlmCorpusManifest } from "../schemas/corpus.ts";
import type { RlmDigest } from "../schemas/primitives.ts";

/** Stable JSON for digests. It sorts object keys and removes undefined values. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

export const sha256Hex = (input: string): RlmDigest =>
  createHash("sha256").update(input, "utf8").digest("hex");

/** Content digest for a materialized v2 corpus. The digest does not include builtAt. */
export const computeContentDigest = (input: {
  readonly scopeRef: string;
  readonly ordering: RlmCorpusManifest["ordering"];
  readonly entries: ReadonlyArray<RlmCorpusEntry>;
}): RlmDigest =>
  sha256Hex(
    canonicalJson({
      schemaId: "openagents.ai.rlm_corpus_content.v2",
      scopeRef: input.scopeRef,
      ordering: input.ordering,
      entries: input.entries.map((entry) => ({
        ordinal: entry.ordinal,
        entryRef: entry.entryRef,
        scopeRef: entry.scopeRef,
        sourcePlane: entry.sourcePlane,
        sourceKind: entry.sourceKind,
        sourceAddress: entry.sourceAddress,
        sourceOrigin: entry.sourceOrigin,
        supportingSources: entry.supportingSources,
        text: entry.text,
        visibility: entry.visibility,
        redactionClass: entry.redactionClass,
      })),
    }),
  );

/** Composite content identity does not require child text materialization. */
export const computeCompositeContentDigest = (input: {
  readonly scopeRef: string;
  readonly composition: RlmCorpusComposition;
}): RlmDigest =>
  sha256Hex(
    canonicalJson({
      schemaId: "openagents.ai.rlm_composite_content.v1",
      scopeRef: input.scopeRef,
      children: input.composition.children,
      policy: input.composition.policy,
      orderingRule: input.composition.orderingRule,
    }),
  );

/** Manifest digest includes policy, coverage, exclusions, and composition facts. */
export const computeManifestDigest = (input: {
  readonly contentDigest: RlmDigest;
  readonly coverage: RlmCorpusManifest["coverage"];
  readonly policy: RlmCorpusManifest["policy"];
  readonly scopeRef: string;
  readonly ordering: RlmCorpusManifest["ordering"];
  readonly composition?: RlmCorpusComposition;
}): RlmDigest =>
  sha256Hex(
    canonicalJson({
      schemaId: "openagents.ai.rlm_corpus_manifest.v2",
      contentDigest: input.contentDigest,
      coverage: input.coverage,
      policy: input.policy,
      scopeRef: input.scopeRef,
      ordering: input.ordering,
      composition: input.composition,
    }),
  );

export const excerptDigest = (excerpt: string): RlmDigest => sha256Hex(excerpt);
