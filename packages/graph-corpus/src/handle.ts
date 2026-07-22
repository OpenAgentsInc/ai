import { Effect } from "effect";

import {
  buildGraphCorpus,
  GraphCorpusError,
  verifyBuiltGraphCorpus,
  type BuiltGraphCorpus,
} from "./builder.ts";
import type {
  GraphCanonicalEntity,
  GraphManifest,
  GraphMention,
  GraphRelation,
  GraphSnapshot,
} from "./schemas.ts";

export type GraphReadableElement = GraphMention | GraphCanonicalEntity | GraphRelation;

export interface GraphSnapshotHandle {
  readonly snapshot: GraphSnapshot;
  readonly manifest: GraphManifest;
  readonly assertUnchanged: () => Effect.Effect<void, GraphCorpusError>;
  readonly readElement: (
    elementRef: string,
  ) => Effect.Effect<GraphReadableElement, GraphCorpusError>;
  readonly readMentions: () => Effect.Effect<ReadonlyArray<GraphMention>, GraphCorpusError>;
  readonly readEntities: () => Effect.Effect<ReadonlyArray<GraphCanonicalEntity>, GraphCorpusError>;
  readonly readRelations: () => Effect.Effect<ReadonlyArray<GraphRelation>, GraphCorpusError>;
}

/** Make an immutable small-snapshot handle. This function does not grant source authority. */
export const makeInMemoryGraphSnapshotHandle = Effect.fn("GraphCorpus.makeInMemoryHandle")(
  function* (built: BuiltGraphCorpus) {
    yield* verifyBuiltGraphCorpus(built);
    const acquired = yield* buildGraphCorpus({
      graphRef: built.snapshot.graphRef,
      scopeRef: built.snapshot.scopeRef,
      policy: built.manifest.policy,
      mentions: structuredClone(built.snapshot.mentions),
      entities: structuredClone(built.snapshot.entities),
      relations: structuredClone(built.snapshot.relations),
      merges: structuredClone(built.snapshot.merges),
      embeddingProjections: structuredClone(built.snapshot.embeddingProjections),
    });
    const elements = new Map<string, GraphReadableElement>([
      ...acquired.snapshot.mentions.map((item) => [item.elementRef, item] as const),
      ...acquired.snapshot.entities.map((item) => [item.elementRef, item] as const),
      ...acquired.snapshot.relations.map((item) => [item.elementRef, item] as const),
    ]);
    const assertUnchanged = () => verifyBuiltGraphCorpus(acquired);
    return {
      snapshot: acquired.snapshot,
      manifest: acquired.manifest,
      assertUnchanged,
      readElement: (elementRef) =>
        assertUnchanged().pipe(
          Effect.flatMap(() => {
            const element = elements.get(elementRef);
            return element === undefined
              ? Effect.fail(
                  new GraphCorpusError({
                    reason: "not_found",
                    detailSafe: "graph element is not in the snapshot",
                  }),
                )
              : Effect.succeed(element);
          }),
        ),
      readMentions: () => assertUnchanged().pipe(Effect.as(acquired.snapshot.mentions)),
      readEntities: () => assertUnchanged().pipe(Effect.as(acquired.snapshot.entities)),
      readRelations: () => assertUnchanged().pipe(Effect.as(acquired.snapshot.relations)),
    } satisfies GraphSnapshotHandle;
  },
);
