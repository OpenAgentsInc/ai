import { Effect } from "effect";
import {
  buildInlineCorpusInput,
  citationFromEntry,
  makeInlineCorpusHandle,
  validateCitations,
  RlmCorpusError,
} from "@openagentsinc/rlm";
import type {
  buildGraphCorpus,
  makeGraphAdapterCapabilities,
  makeGraphMention,
  makeGraphRlmClassificationProjection,
  makeGraphRlmProjection,
  makeInMemoryGraphSnapshotHandle,
} from "@openagentsinc/graph-corpus";
import { describe, expect, test } from "vite-plus/test";

import { graphConformanceDerivation, graphConformancePolicy } from "./graph-fixtures.ts";

export interface GraphRlmLawsConfig {
  readonly label: string;
  readonly buildGraphCorpus: typeof buildGraphCorpus;
  readonly makeGraphMention: typeof makeGraphMention;
  readonly makeInMemoryGraphSnapshotHandle: typeof makeInMemoryGraphSnapshotHandle;
  readonly makeGraphRlmClassificationProjection: typeof makeGraphRlmClassificationProjection;
  readonly makeGraphAdapterCapabilities: typeof makeGraphAdapterCapabilities;
  readonly makeGraphRlmProjection: typeof makeGraphRlmProjection;
}

const limits = {
  maxDepth: 2,
  maxVisitedElements: 10,
  maxReturnedElements: 10,
  maxSourceAddresses: 10,
  maxCharactersPerResult: 2_048,
  maxObservationCharacters: 10_000,
} as const;

/** Laws for graph-to-RLM projection, exact citations, freshness, and bounds. */
export const runGraphRlmLaws = (implementation: GraphRlmLawsConfig): void => {
  const fixture = async () => {
    const original = await Effect.runPromise(
      makeInlineCorpusHandle(
        buildInlineCorpusInput({
          corpusRef: "corpus.graph-rlm.conformance",
          scopeRef: "tenant.a",
          policy: graphConformancePolicy,
          entries: ["a", "b"].map((entryRef) => ({
            entryRef,
            scopeRef: "tenant.a",
            sourcePlane: "repository",
            sourceKind: "conformance_fixture",
            sourceAddress: {
              addressSchemaId: "conformance.path.v1",
              encodedAddress: `fixture:${entryRef}`,
            },
            text: `Alex source ${entryRef}.`,
            visibility: "private",
            redactionClass: "none",
          })),
        }),
      ),
    );
    const sources = await Promise.all(
      ["a", "b"].map((entryRef) =>
        Effect.runPromise(
          original
            .validateSourceAddress({
              addressSchemaId: "conformance.path.v1",
              encodedAddress: `fixture:${entryRef}`,
            })
            .pipe(Effect.map(({ origin }) => origin)),
        ),
      ),
    );
    const mentions = sources.map((source, index) =>
      implementation.makeGraphMention({
        identityNamespace: "people",
        canonicalKey: `alex:${index}`,
        identityScopeRef: "tenant.a",
        source,
        derivation: graphConformanceDerivation,
      }),
    );
    const mention = mentions[0]!;
    const built = await Effect.runPromise(
      implementation.buildGraphCorpus({
        graphRef: "graph.rlm.conformance",
        scopeRef: "tenant.a",
        policy: graphConformancePolicy,
        mentions,
        entities: [],
        relations: [],
      }),
    );
    const handle = await Effect.runPromise(implementation.makeInMemoryGraphSnapshotHandle(built));
    const classification = implementation.makeGraphRlmClassificationProjection(
      handle,
      mentions.map(({ elementRef }) => ({
        elementRef,
        visibility: "private" as const,
        redactionClass: "none" as const,
      })),
      [original],
    );
    return { original, source: sources[0]!, mention, mentions, built, handle, classification };
  };

  describe(`[${implementation.label}] graph RLM`, () => {
    test("projection preserves exact source citations and bounded lookup", async () => {
      const value = await fixture();
      const projection = await Effect.runPromise(
        implementation.makeGraphRlmProjection({
          handle: value.handle,
          capabilities: implementation.makeGraphAdapterCapabilities([
            "graph_read",
            "rlm_v2_projection",
          ]),
          classification: value.classification,
          corpusRef: "rlm.graph.conformance",
          supportingCorpora: [value.original],
        }),
      );
      const entries = await Effect.runPromise(projection.corpus.materializeAll());
      expect(entries).toHaveLength(2);
      expect(entries[0]?.supportingSources).toEqual([value.source]);
      const citation = citationFromEntry(projection.corpus, entries[0]!);
      expect(
        (await Effect.runPromise(validateCitations(projection.corpus, [citation]))).invalid,
      ).toEqual([]);
      const result = await Effect.runPromise(
        projection.operators.lookup(value.mention.elementRef, limits),
      );
      expect(result).toMatchObject({ _tag: "Complete", visitedElements: 1 });
      const capped = await Effect.runPromise(
        projection.operators.searchText("alex", { ...limits, maxReturnedElements: 1 }),
      );
      expect(capped).toMatchObject({ _tag: "Truncated", hitCaps: ["max_returned_elements"] });
    });

    test("missing capability and stale classification fail closed", async () => {
      const value = await fixture();
      const unsupported = await Effect.runPromise(
        implementation
          .makeGraphRlmProjection({
            handle: value.handle,
            capabilities: implementation.makeGraphAdapterCapabilities(["graph_read"]),
            classification: value.classification,
            corpusRef: "rlm.graph.unsupported",
            supportingCorpora: [value.original],
          })
          .pipe(Effect.flip),
      );
      expect(unsupported).toMatchObject({
        reason: "unsupported_operation",
        capability: "rlm_v2_projection",
      });
      const incomplete = implementation.makeGraphRlmClassificationProjection(
        value.handle,
        [],
        [value.original],
      );
      const stale = await Effect.runPromise(
        implementation
          .makeGraphRlmProjection({
            handle: value.handle,
            capabilities: implementation.makeGraphAdapterCapabilities([
              "graph_read",
              "rlm_v2_projection",
            ]),
            classification: incomplete,
            corpusRef: "rlm.graph.stale",
            supportingCorpora: [value.original],
          })
          .pipe(Effect.flip),
      );
      expect(stale).toMatchObject({ _tag: "GraphCorpus.RlmError", reason: "invalid_projection" });

      const widened = implementation.makeGraphRlmClassificationProjection(
        value.handle,
        [{ elementRef: value.mention.elementRef, visibility: "public", redactionClass: "none" }],
        [value.original],
      );
      const policyError = await Effect.runPromise(
        implementation
          .makeGraphRlmProjection({
            handle: value.handle,
            capabilities: implementation.makeGraphAdapterCapabilities([
              "graph_read",
              "rlm_v2_projection",
            ]),
            classification: widened,
            corpusRef: "rlm.graph.policy-widened",
            supportingCorpora: [value.original],
          })
          .pipe(Effect.flip),
      );
      expect(policyError.reason).toBe("invalid_projection");
    });

    test("a supporting corpus that changes after construction fails closed", async () => {
      const value = await fixture();
      let changed = false;
      const supporting = {
        ...value.original,
        assertUnchanged: () =>
          changed
            ? Effect.fail(new RlmCorpusError({ reason: "changed" }))
            : value.original.assertUnchanged(),
      };
      const classification = implementation.makeGraphRlmClassificationProjection(
        value.handle,
        value.mentions.map(({ elementRef }) => ({
          elementRef,
          visibility: "private" as const,
          redactionClass: "none" as const,
        })),
        [supporting],
      );
      const projection = await Effect.runPromise(
        implementation.makeGraphRlmProjection({
          handle: value.handle,
          capabilities: implementation.makeGraphAdapterCapabilities([
            "graph_read",
            "rlm_v2_projection",
          ]),
          classification,
          corpusRef: "rlm.graph.changing",
          supportingCorpora: [supporting],
        }),
      );
      changed = true;
      const error = await Effect.runPromise(
        projection.operators.lookup(value.mention.elementRef, limits).pipe(Effect.flip),
      );
      expect(error).toMatchObject({
        _tag: "GraphCorpus.RlmError",
        reason: "projection_changed",
      });
    });
  });
};
