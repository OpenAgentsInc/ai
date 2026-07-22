import { Effect, Schema as S } from "effect";

export const GRAPH_ADAPTER_CAPABILITIES_SCHEMA_ID =
  "openagents.ai.graph_adapter_capabilities.v1" as const;

export const GraphAdapterCapability = S.Literals([
  "graph_read",
  "rlm_v2_projection",
  "vector_read",
  "hybrid_query",
  "atomic_graph_vector_projection",
  "provenance_delete_planning",
  "snapshot_export",
]);
export type GraphAdapterCapability = typeof GraphAdapterCapability.Type;

export const GraphAdapterCapabilities = S.Struct({
  schemaId: S.Literal(GRAPH_ADAPTER_CAPABILITIES_SCHEMA_ID),
  supported: S.Array(GraphAdapterCapability),
});
export type GraphAdapterCapabilities = typeof GraphAdapterCapabilities.Type;

export class GraphAdapterCapabilityError extends S.TaggedErrorClass<GraphAdapterCapabilityError>()(
  "GraphCorpus.AdapterCapabilityError",
  {
    reason: S.Literal("unsupported_operation"),
    capability: GraphAdapterCapability,
    detailSafe: S.optionalKey(S.String.check(S.isMaxLength(512))),
  },
) {}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const decodeCapabilities = S.decodeUnknownSync(GraphAdapterCapabilities);

/** Describe observed adapter support. This value grants no operation authority. */
export const makeGraphAdapterCapabilities = (
  supported: ReadonlyArray<GraphAdapterCapability>,
): GraphAdapterCapabilities =>
  decodeCapabilities({
    schemaId: GRAPH_ADAPTER_CAPABILITIES_SCHEMA_ID,
    supported: [...new Set(supported)].sort(compareText),
  });

/** Refuse an operation unless the adapter explicitly declares it. */
export const requireGraphAdapterCapability = (
  capabilities: GraphAdapterCapabilities,
  capability: GraphAdapterCapability,
): Effect.Effect<void, GraphAdapterCapabilityError> =>
  capabilities.supported.includes(capability)
    ? Effect.void
    : Effect.fail(
        new GraphAdapterCapabilityError({
          reason: "unsupported_operation",
          capability,
          detailSafe: "The graph adapter does not declare this operation.",
        }),
      );
