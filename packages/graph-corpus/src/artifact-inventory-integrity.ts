import { type BuiltGraphCorpus } from "./builder.ts";
import { canonicalJson, compareCanonicalText, sha256Hex } from "./canonical.ts";
import { type GraphArtifactInventory } from "./deletion.ts";
import { graphDigest } from "./schemas.ts";

export interface GraphArtifactInventoryIntegrityFailure {
  readonly reason: "invalid_inventory" | "inventory_changed";
  readonly detailSafe: string;
}

const digest = (value: unknown) => graphDigest(sha256Hex(canonicalJson(value)));
const byRef = <A>(values: ReadonlyArray<A>, ref: (value: A) => string): ReadonlyArray<A> =>
  [...values].sort((left, right) => compareCanonicalText(ref(left), ref(right)));

/** Internal pure validation for one schema-decoded #33 artifact inventory. */
export const checkGraphArtifactInventoryIntegrity = (
  built: BuiltGraphCorpus,
  decoded: GraphArtifactInventory,
): GraphArtifactInventoryIntegrityFailure | undefined => {
  const { inventoryDigest, ...withoutDigest } = decoded;
  if (digest(withoutDigest) !== inventoryDigest)
    return {
      reason: "inventory_changed",
      detailSafe: "The artifact inventory digest does not match its content.",
    };
  if (
    decoded.graphRef !== built.snapshot.graphRef ||
    decoded.scopeRef !== built.snapshot.scopeRef ||
    decoded.graphDigest !== built.snapshot.graphDigest ||
    decoded.manifestDigest !== built.manifest.manifestDigest
  )
    return {
      reason: "inventory_changed",
      detailSafe: "The artifact inventory is bound to a different graph.",
    };
  const incompletePlanes = Object.entries(decoded.coverage).filter(
    ([, coverage]) => coverage._tag === "Incomplete",
  );
  if (
    (decoded._tag === "Complete" && incompletePlanes.length > 0) ||
    (decoded._tag === "Incomplete" && incompletePlanes.length === 0) ||
    incompletePlanes.some(
      ([plane, coverage]) =>
        coverage._tag === "Incomplete" &&
        (coverage.gaps.length === 0 ||
          coverage.gaps.some((gap) =>
            plane === "vectors"
              ? gap.artifactKind !== "vector"
              : plane === "summaries"
                ? gap.artifactKind !== "summary"
                : gap.artifactKind !== "ranking_ref",
          )),
    )
  )
    return {
      reason: "invalid_inventory",
      detailSafe: "Artifact-plane coverage is incomplete or inconsistent.",
    };
  const arraysAreCanonical =
    canonicalJson(decoded.vectors) ===
      canonicalJson(byRef(decoded.vectors, (item) => item.artifactRef)) &&
    canonicalJson(decoded.summaries) ===
      canonicalJson(byRef(decoded.summaries, (item) => item.artifactRef)) &&
    canonicalJson(decoded.rankingRefs) ===
      canonicalJson(byRef(decoded.rankingRefs, (item) => item.artifactRef)) &&
    Object.values(decoded.coverage).every(
      (coverage) =>
        coverage._tag === "Complete" ||
        canonicalJson(coverage.gaps) ===
          canonicalJson(byRef(coverage.gaps, (item) => canonicalJson(item))),
    );
  if (!arraysAreCanonical)
    return {
      reason: "invalid_inventory",
      detailSafe: "The artifact inventory is not in canonical order.",
    };
  const allArtifacts = [...decoded.vectors, ...decoded.summaries, ...decoded.rankingRefs];
  if (new Set(allArtifacts.map((item) => item.artifactRef)).size !== allArtifacts.length)
    return {
      reason: "invalid_inventory",
      detailSafe: "The artifact inventory contains a duplicate artifact ref.",
    };
  const elementRefs = new Set([
    ...built.snapshot.mentions.map((item) => item.elementRef),
    ...built.snapshot.entities.map((item) => item.elementRef),
    ...built.snapshot.relations.map((item) => item.elementRef),
  ]);
  if (allArtifacts.some((item) => !elementRefs.has(item.ownerElementRef)))
    return {
      reason: "invalid_inventory",
      detailSafe: "A declared artifact owner is not in the graph snapshot.",
    };
  return undefined;
};
