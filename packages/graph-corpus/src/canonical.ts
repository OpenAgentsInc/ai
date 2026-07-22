import { createHash } from "node:crypto";
import type { RlmSourceLocator } from "@openagentsinc/rlm/schemas";

import {
  GRAPH_CANONICALIZATION_ID,
  GRAPH_MANIFEST_SCHEMA_ID,
  GRAPH_SCHEMA_ID,
  graphDigest,
  graphElementRef,
  graphScopeRef,
  type GraphDerivation,
  type GraphDigest,
  type GraphElementKind,
  type GraphIdentity,
  type GraphManifest,
  type GraphCorpusPolicy,
  type GraphSnapshot,
  type GraphSourceMembership,
} from "./schemas.ts";

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

export const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const locatorKey = (locator: RlmSourceLocator): string => canonicalJson(locator);

export const canonicalSourceMemberships = (
  memberships: ReadonlyArray<GraphSourceMembership>,
): ReadonlyArray<GraphSourceMembership> => {
  const byLocator = new Map(memberships.map((item) => [locatorKey(item.source), item]));
  return [...byLocator.values()].sort((left, right) =>
    compareCanonicalText(locatorKey(left.source), locatorKey(right.source)),
  );
};

export const canonicalGraphPolicy = (policy: GraphCorpusPolicy): GraphCorpusPolicy => ({
  includeVisibilities: [...new Set(policy.includeVisibilities)].sort(compareCanonicalText),
  includeRedactionClasses: [...new Set(policy.includeRedactionClasses)].sort(compareCanonicalText),
});

export interface GraphIdentityInput {
  readonly elementKind: GraphElementKind;
  readonly identityNamespace: string;
  readonly canonicalKey: string;
  readonly scopeRef?: string;
}

export const graphIdentity = (input: GraphIdentityInput): GraphIdentity => ({
  schemaId: GRAPH_SCHEMA_ID,
  canonicalizationId: GRAPH_CANONICALIZATION_ID,
  elementKind: input.elementKind,
  identityNamespace: input.identityNamespace as GraphIdentity["identityNamespace"],
  canonicalKey: input.canonicalKey,
  identityScope:
    input.scopeRef === undefined
      ? { _tag: "Global" }
      : { _tag: "Scoped", scopeRef: graphScopeRef(input.scopeRef) },
});

export const deriveGraphElementRef = (input: {
  readonly identity: GraphIdentity;
  readonly memberships: ReadonlyArray<GraphSourceMembership>;
}): ReturnType<typeof graphElementRef> =>
  graphElementRef(
    `graph.${input.identity.elementKind}.${sha256Hex(
      canonicalJson({
        schemaId: GRAPH_SCHEMA_ID,
        canonicalizationId: GRAPH_CANONICALIZATION_ID,
        identity: input.identity,
        memberships: canonicalSourceMemberships(input.memberships),
      }),
    )}`,
  );

export const derivationBytes = (derivation: GraphDerivation): string => canonicalJson(derivation);

const snapshotContent = (snapshot: Omit<GraphSnapshot, "graphDigest">): unknown => ({
  schemaId: GRAPH_SCHEMA_ID,
  canonicalizationId: GRAPH_CANONICALIZATION_ID,
  graphRef: snapshot.graphRef,
  scopeRef: snapshot.scopeRef,
  policy: canonicalGraphPolicy(snapshot.policy),
  mentions: snapshot.mentions,
  entities: snapshot.entities,
  relations: snapshot.relations,
  merges: snapshot.merges,
  embeddingProjections: snapshot.embeddingProjections,
});

export const computeGraphDigest = (snapshot: Omit<GraphSnapshot, "graphDigest">): GraphDigest =>
  graphDigest(sha256Hex(canonicalJson(snapshotContent(snapshot))));

export const computeGraphManifestDigest = (
  manifest: Omit<GraphManifest, "manifestDigest">,
): GraphDigest =>
  graphDigest(
    sha256Hex(
      canonicalJson({
        schemaId: GRAPH_MANIFEST_SCHEMA_ID,
        canonicalizationId: GRAPH_CANONICALIZATION_ID,
        graphRef: manifest.graphRef,
        scopeRef: manifest.scopeRef,
        graphDigest: manifest.graphDigest,
        policy: canonicalGraphPolicy(manifest.policy),
        coverage: manifest.coverage,
      }),
    ),
  );
