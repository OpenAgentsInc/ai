import { Effect, Schema as S } from "effect";
import {
  COMPILED_PROGRAM_SCHEMA_LITERAL,
  CompiledProgram,
  GRAPH_EXTRACTION_CORPUS_SCHEMA_ID,
  GraphExtractionCorpus,
  GraphExtractionLimits,
  GraphExtractionError,
  graphExtractionSignature,
  type GraphExtractionCandidates,
  type applyGraphExtractionCandidates,
  type planGraphExtractionBatches,
  type runDeterministicGraphExtraction,
  type runGraphExtraction,
  type validateGraphExtractionRunReceipt,
  type GraphExtractionRuntimeDeps,
} from "@openagentsinc/dse";
import type { RlmSourceLocator } from "@openagentsinc/rlm/schemas";
import { describe, expect, test } from "vite-plus/test";

import { graphPromptInjectionFixture } from "./graph-fixtures.ts";

export interface DseExtractionLawsConfig {
  readonly label: string;
  readonly planGraphExtractionBatches: typeof planGraphExtractionBatches;
  readonly runGraphExtraction: typeof runGraphExtraction;
  readonly runDeterministicGraphExtraction: typeof runDeterministicGraphExtraction;
  readonly validateGraphExtractionRunReceipt: typeof validateGraphExtractionRunReceipt;
  readonly applyGraphExtractionCandidates: typeof applyGraphExtractionCandidates;
}

const source = (entryKey: string): RlmSourceLocator => ({
  sourcePlane: "repository",
  sourceKind: "conformance_fixture",
  sourceAddress: { addressSchemaId: "conformance.path.v1", encodedAddress: `src/${entryKey}.ts` },
  corpusRef: "corpus.extraction.conformance",
  contentDigest: "a".repeat(64) as RlmSourceLocator["contentDigest"],
  entryRef: entryKey as RlmSourceLocator["entryRef"],
});

const corpus = S.decodeUnknownSync(GraphExtractionCorpus)({
  schemaId: GRAPH_EXTRACTION_CORPUS_SCHEMA_ID,
  corpusRef: "corpus.extraction.conformance",
  contentDigest: "a".repeat(64),
  manifestDigest: "b".repeat(64),
  entries: [
    { entryKey: "a", source: source("a"), text: graphPromptInjectionFixture },
    { entryKey: "b", source: source("b"), text: "Alex builds portable agents." },
  ],
});

const limits = S.decodeUnknownSync(GraphExtractionLimits)({
  maxEntries: 10,
  maxCharacters: 10_000,
  maxInputTokens: 10_000,
  maxOutputTokens: 10_000,
  maxOutputCharacters: 20_000,
  maxModelCalls: 10,
  maxWallClockMs: 10_000,
  maxConcurrency: 1,
  maxEntriesPerBatch: 10,
  maxCharactersPerBatch: 10_000,
  maxInputTokensPerBatch: 10_000,
});

const candidates: GraphExtractionCandidates = {
  mentions: [
    {
      candidateKey: "m1",
      identityNamespace: "people",
      canonicalKey: "alex:a",
      supportEntryKey: "a",
      confidence: 0.9,
    },
    {
      candidateKey: "m2",
      identityNamespace: "people",
      canonicalKey: "alex:b",
      supportEntryKey: "b",
      confidence: 0.8,
    },
  ],
  entities: [
    {
      candidateKey: "e1",
      identityNamespace: "people",
      canonicalKey: "alex",
      mentionCandidateKeys: ["m1", "m2"],
      confidence: 0.95,
    },
  ],
  relations: [],
  merges: [
    {
      candidateKey: "merge1",
      entityCandidateKey: "e1",
      mentionCandidateKeys: ["m1", "m2"],
      confidence: 0.9,
    },
  ],
};

const deps = (): GraphExtractionRuntimeDeps => ({
  countTokens: (text) => text.length,
  monotonicMs: () => 0,
  now: () => "2026-07-22T00:00:00Z",
  assertCorpusUnchanged: () => Effect.succeed("freshness.conformance"),
});

/** Laws for bounded DSE graph extraction and application. */
export const runDseExtractionLaws = (implementation: DseExtractionLawsConfig): void => {
  describe(`[${implementation.label}] DSE graph extraction`, () => {
    test("deterministic extraction is stable, receipted, and applicable", async () => {
      const extractor = {
        parserRef: "parser.conformance.v1",
        parserVersion: "1.0.0",
        extract: () => Effect.succeed(candidates),
      };
      const args = { corpus, extractor, limits, deps: deps() };
      const left = await Effect.runPromise(implementation.runDeterministicGraphExtraction(args));
      const right = await Effect.runPromise(implementation.runDeterministicGraphExtraction(args));
      expect(right).toEqual(left);
      expect(left.receipt).toMatchObject({ modelCalls: 0, concurrencyHighWaterMark: 0 });
      await expect(
        Effect.runPromise(
          implementation.validateGraphExtractionRunReceipt(left.receipt, {
            corpus,
            limits,
            countTokens: deps().countTokens,
            assertCorpusUnchanged: deps().assertCorpusUnchanged,
            result: left,
          }),
        ),
      ).resolves.toBeUndefined();
      const built = await Effect.runPromise(
        implementation.applyGraphExtractionCandidates({
          run: left,
          execution: {
            corpus,
            limits,
            countTokens: deps().countTokens,
            assertCorpusUnchanged: deps().assertCorpusUnchanged,
          },
          graphRef: "graph.extraction.conformance",
          scopeRef: "tenant.a",
          policy: { includeVisibilities: ["private"], includeRedactionClasses: ["none"] },
        }),
      );
      expect(built.snapshot).toMatchObject({
        mentions: { length: 2 },
        entities: { length: 1 },
        merges: { length: 1 },
      });
    });

    test("caps are named and partial output cannot be applied", async () => {
      const capped = S.decodeUnknownSync(GraphExtractionLimits)({ ...limits, maxEntries: 1 });
      const plan = implementation.planGraphExtractionBatches({
        corpus,
        limits: capped,
        countTokens: deps().countTokens,
      });
      expect(plan.reasons).toContain("entry_cap");
      const run = await Effect.runPromise(
        implementation.runDeterministicGraphExtraction({
          corpus,
          extractor: {
            parserRef: "parser.conformance.v1",
            parserVersion: "1.0.0",
            extract: () =>
              Effect.succeed({ mentions: [], entities: [], relations: [], merges: [] }),
          },
          limits: capped,
          deps: deps(),
        }),
      );
      expect(run.status).toBe("Partial");
      const error = await Effect.runPromise(
        implementation
          .applyGraphExtractionCandidates({
            run,
            execution: {
              corpus,
              limits: capped,
              countTokens: deps().countTokens,
              assertCorpusUnchanged: deps().assertCorpusUnchanged,
            },
            graphRef: "graph.extraction.partial",
            scopeRef: "tenant.a",
            policy: { includeVisibilities: ["private"], includeRedactionClasses: ["none"] },
          })
          .pipe(Effect.flip),
      );
      expect(error.reason).toBe("invalid_candidate");
    });

    test("prompt-injection text stays in the untrusted envelope", async () => {
      const program = S.decodeUnknownSync(CompiledProgram)({
        schema: COMPILED_PROGRAM_SCHEMA_LITERAL,
        signatureId: graphExtractionSignature.signatureId,
        promptIr: graphExtractionSignature.defaultPromptIr,
        decodePolicy: { maxRepairs: 0, maxOutputChars: 20_000 },
        modelRole: "graph_extractor",
      });
      const observed: string[] = [];
      await Effect.runPromise(
        implementation.runGraphExtraction({
          corpus,
          program,
          model: {
            complete: ({ message }) => {
              observed.push(message.canonicalBytes);
              return Effect.succeed({
                text: JSON.stringify(candidates),
                modelIdentity: "model.conformance.v1",
                usage: { _tag: "Exact", inputTokens: 1, outputTokens: 1 },
              });
            },
          },
          limits,
          deps: deps(),
        }),
      );
      const envelope = JSON.parse(observed[0]!) as { trusted: unknown; untrustedContext: string };
      expect(envelope.untrustedContext).toContain(graphPromptInjectionFixture);
      expect(JSON.stringify(envelope.trusted)).not.toContain(graphPromptInjectionFixture);
    });

    test("a corpus that changes at an external-call boundary is refused", async () => {
      const program = S.decodeUnknownSync(CompiledProgram)({
        schema: COMPILED_PROGRAM_SCHEMA_LITERAL,
        signatureId: graphExtractionSignature.signatureId,
        promptIr: graphExtractionSignature.defaultPromptIr,
        decodePolicy: { maxRepairs: 0, maxOutputChars: 20_000 },
        modelRole: "graph_extractor",
      });
      let assertions = 0;
      const changingDeps: GraphExtractionRuntimeDeps = {
        ...deps(),
        assertCorpusUnchanged: () => {
          assertions += 1;
          return assertions < 3
            ? Effect.succeed("freshness.conformance")
            : Effect.fail(
                new GraphExtractionError({
                  reason: "invalid_corpus",
                  detailSafe: "The conformance corpus changed.",
                }),
              );
        },
      };
      const result = await Effect.runPromise(
        implementation.runGraphExtraction({
          corpus,
          program,
          model: {
            complete: () =>
              Effect.succeed({
                text: JSON.stringify(candidates),
                modelIdentity: "model.conformance.v1",
                usage: { _tag: "Exact", inputTokens: 1, outputTokens: 1 },
              }),
          },
          limits,
          deps: changingDeps,
        }),
      );
      expect(result.status).toBe("Refused");
      expect(result.batches).toEqual([]);
      expect(result.receipt.reasons).toContain("invalid_corpus");
    });
  });
};
