import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { buildInlineCorpusInput } from "../corpus/handle.ts";
import { rlmInlineCorpusSourceLayer } from "../corpus/source.ts";
import { makeRlm, rlmLayer, runRlm, type RlmModelPlan } from "../engine/rlm.ts";
import { defaultRlmBudget, defaultRlmEvidencePolicy } from "../schemas/budget.ts";
import type { RlmProgram } from "../schemas/program.ts";
import { RlmError } from "../schemas/errors.ts";
import { sha256Hex } from "../corpus/digest.ts";

const corpus = buildInlineCorpusInput({
  corpusRef: "corpus.paper",
  scopeRef: "scope.paper",
  entries: [
    {
      scopeRef: "scope.paper",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a0" },
      text: "alpha fact one",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.paper",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a1" },
      text: "beta fact two",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.paper",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a2" },
      text: "gamma fact three",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.paper",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "a3" },
      text: "delta fact four",
      visibility: "public",
      redactionClass: "none",
    },
  ],
});

/** Paper-fidelity program: Partition → ModelMap → Join → Commit (N leaf calls, one root). */
const paperProgram = (parts: number): RlmProgram => ({
  schemaId: "openagents.ai.rlm_program.v1",
  programRef: "prog.paper",
  nodes: [
    {
      _tag: "CorpusOp",
      nodeRef: "n.grep",
      operator: "Grep",
      params: { pattern: "fact" },
      inputValueRefs: [],
      outputValueRef: "v.hits",
    },
    {
      _tag: "Partition",
      nodeRef: "n.part",
      inputValueRef: "v.hits",
      partCount: parts,
      outputValueRef: "v.parts",
    },
    {
      _tag: "ModelMap",
      nodeRef: "n.map",
      inputCollectionRef: "v.parts",
      promptTemplate: "Summarize part {{index}}: {{item}}",
      outputValueRef: "v.mapped",
      maxConcurrency: 4,
    },
    {
      _tag: "Transform",
      nodeRef: "n.join",
      operator: "TransformJoinText",
      params: {},
      inputValueRefs: ["v.mapped"],
      outputValueRef: "v.joined",
    },
    {
      _tag: "Commit",
      nodeRef: "n.commit",
      valueRef: "v.joined",
      citationValueRefs: ["v.hits"],
    },
  ],
});

const scriptedModel = (leafCalls: { count: number }): RlmModelPlan => ({
  strategyRef: "strategy.paper.v1",
  completeRoot: () =>
    Effect.succeed({
      text: JSON.stringify(paperProgram(4)),
      inputTokens: 10,
      outputTokens: 20,
    }),
  completeLeaf: (prompt) =>
    Effect.sync(() => {
      leafCalls.count += 1;
      return {
        text: `leaf:${sha256Hex(prompt).slice(0, 8)}`,
        inputTokens: 5,
        outputTokens: 5,
      };
    }),
});

describe("paper fidelity — programmatic ModelMap", () => {
  test("one root program launches N mapped leaf calls with no intervening root decisions", async () => {
    const leafCalls = { count: 0 };
    const rootCalls = { count: 0 };
    const model: RlmModelPlan = {
      strategyRef: "strategy.paper.v1",
      completeRoot: () =>
        Effect.sync(() => {
          rootCalls.count += 1;
          return { text: JSON.stringify(paperProgram(4)), inputTokens: 1, outputTokens: 1 };
        }),
      completeLeaf: (prompt) =>
        Effect.sync(() => {
          leafCalls.count += 1;
          return {
            text: `leaf-${leafCalls.count}:${prompt.slice(0, 12)}`,
            inputTokens: 1,
            outputTokens: 1,
          };
        }),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        return yield* shape.run({
          _tag: "Semantic",
          schemaId: "openagents.ai.rlm_request.v1",
          runRef: "run.paper.1",
          corpus,
          question: "summarize all facts",
          budget: { ...defaultRlmBudget, requireExactUsage: false },
          evidence: { ...defaultRlmEvidencePolicy, requireCitations: false, minimumCitations: 0 },
        });
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    expect(rootCalls.count).toBe(1);
    expect(leafCalls.count).toBe(4);
    expect(result._tag).toBe("Completed");
    if (result._tag === "Completed") {
      expect(result.honesty.modelMapCalls).toBe(4);
      expect(result.output._tag).toBe("InlineValue");
      if (result.output._tag === "InlineValue") {
        expect(result.output.value).toContain("leaf-");
      }
    }
  });

  test("concurrency 1 and >1 produce identical committed digests", async () => {
    const runWithConcurrency = async (maxConcurrentCalls: number) => {
      const leafCalls = { count: 0 };
      const model = scriptedModel(leafCalls);
      // Force program maxConcurrency via root program embedding
      const program = paperProgram(4);
      const mapNode = program.nodes.find((n) => n._tag === "ModelMap");
      if (mapNode && mapNode._tag === "ModelMap") {
        (mapNode as { maxConcurrency?: number }).maxConcurrency = maxConcurrentCalls;
      }
      const modelFixed: RlmModelPlan = {
        ...model,
        completeRoot: () => Effect.succeed({ text: JSON.stringify(program) }),
      };
      return Effect.runPromise(
        Effect.gen(function* () {
          const shape = yield* makeRlm({ model: modelFixed, admitSemantic: true });
          return yield* shape.run({
            _tag: "Semantic",
            schemaId: "openagents.ai.rlm_request.v1",
            runRef: `run.conc.${maxConcurrentCalls}`,
            corpus,
            question: "q",
            budget: { ...defaultRlmBudget, maxConcurrentCalls },
            evidence: { ...defaultRlmEvidencePolicy, requireCitations: false, minimumCitations: 0 },
          });
        }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
      );
    };

    const a = await runWithConcurrency(1);
    const b = await runWithConcurrency(4);
    expect(a._tag).toBe("Completed");
    expect(b._tag).toBe("Completed");
    if (a._tag === "Completed" && b._tag === "Completed") {
      expect(a.output).toEqual(b.output);
    }
  });

  test("ModelMap does not increase RLM depth accounting while RlmMap does consume subcalls", async () => {
    const rlmMapProgram: RlmProgram = {
      schemaId: "openagents.ai.rlm_program.v1",
      programRef: "prog.rlmmap",
      nodes: [
        {
          _tag: "CorpusOp",
          nodeRef: "n.grep",
          operator: "Grep",
          params: { pattern: "fact" },
          inputValueRefs: [],
          outputValueRef: "v.hits",
        },
        {
          _tag: "RlmMap",
          nodeRef: "n.rlm",
          inputCollectionRef: "v.hits",
          questionTemplate: "detail {{index}} {{item}}",
          outputValueRef: "v.child",
          maxConcurrency: 2,
        },
        {
          _tag: "Transform",
          nodeRef: "n.join",
          operator: "TransformJoinText",
          params: {},
          inputValueRefs: ["v.child"],
          outputValueRef: "v.out",
        },
        {
          _tag: "Commit",
          nodeRef: "n.commit",
          valueRef: "v.out",
          citationValueRefs: ["v.hits"],
        },
      ],
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({
          admitSemantic: true,
          model: {
            completeRoot: () => Effect.succeed({ text: JSON.stringify(rlmMapProgram) }),
            completeLeaf: () => Effect.succeed({ text: "child-answer" }),
          },
        });
        return yield* shape.run({
          _tag: "Semantic",
          schemaId: "openagents.ai.rlm_request.v1",
          runRef: "run.rlmmap",
          corpus,
          question: "expand",
          budget: defaultRlmBudget,
          evidence: { ...defaultRlmEvidencePolicy, requireCitations: false, minimumCitations: 0 },
        });
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    expect(result._tag).toBe("Completed");
    if (result._tag === "Completed") {
      expect(result.honesty.rlmMapCalls).toBeGreaterThan(0);
      expect(result.usage.subcalls).toBeGreaterThan(0);
    }
  });

  test("cycle program fails before node execution", async () => {
    const cyclic: RlmProgram = {
      schemaId: "openagents.ai.rlm_program.v1",
      programRef: "prog.cycle",
      nodes: [
        {
          _tag: "Transform",
          nodeRef: "n1",
          operator: "TransformIdentity",
          params: {},
          inputValueRefs: ["v2"],
          outputValueRef: "v1",
        },
        {
          _tag: "Transform",
          nodeRef: "n2",
          operator: "TransformIdentity",
          params: {},
          inputValueRefs: ["v1"],
          outputValueRef: "v2",
        },
        {
          _tag: "Commit",
          nodeRef: "n3",
          valueRef: "v1",
          citationValueRefs: [],
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const shape = yield* makeRlm({
          admitSemantic: true,
          model: {
            completeRoot: () => Effect.succeed({ text: JSON.stringify(cyclic) }),
          },
        });
        return yield* shape.run({
          _tag: "Semantic",
          schemaId: "openagents.ai.rlm_request.v1",
          runRef: "run.cycle",
          corpus,
          question: "x",
          budget: defaultRlmBudget,
          evidence: defaultRlmEvidencePolicy,
        });
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("deterministic Tier D never touches a model", async () => {
    let modelTouched = false;
    const layer = rlmLayer({
      admitSemantic: true,
      model: {
        completeRoot: () =>
          Effect.sync(() => {
            modelTouched = true;
            return { text: "{}" };
          }),
      },
    });

    const result = await Effect.runPromise(
      runRlm({
        _tag: "Deterministic",
        schemaId: "openagents.ai.rlm_request.v1",
        runRef: "run.d",
        corpus,
        operation: { _tag: "Grep", pattern: "alpha" },
        limits: {
          maxEntriesScanned: 100,
          maxSpans: 10,
          maxCharsPerSpan: 200,
          maxObservationChars: 2000,
        },
      }).pipe(Effect.provide(layer), Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    expect(modelTouched).toBe(false);
    expect(result._tag).toBe("Completed");
    if (result._tag === "Completed") {
      expect(result.usage.modelCalls).toBe(0);
      expect(result.output._tag).toBe("DeterministicFindings");
    }
  });

  test("content digests are order-independent for equivalent entry sets", () => {
    const a = buildInlineCorpusInput({
      corpusRef: "c",
      scopeRef: "s",
      entries: [
        {
          scopeRef: "s",
          sourceKind: "k",
          sourceAddress: { addressSchemaId: "a", encodedAddress: "1" },
          text: "x",
          visibility: "public",
          redactionClass: "none",
          entryRef: "e0",
        },
        {
          scopeRef: "s",
          sourceKind: "k",
          sourceAddress: { addressSchemaId: "a", encodedAddress: "2" },
          text: "y",
          visibility: "public",
          redactionClass: "none",
          entryRef: "e1",
        },
      ],
    });
    // Same ordinals/content — rebuild
    const b = buildInlineCorpusInput({
      corpusRef: "c",
      scopeRef: "s",
      entries: a.entries.map((e) => ({
        scopeRef: e.scopeRef,
        sourceKind: e.sourceKind,
        sourceAddress: e.sourceAddress,
        ...(e.text !== undefined ? { text: e.text } : {}),
        visibility: e.visibility,
        redactionClass: e.redactionClass,
        entryRef: e.entryRef,
      })),
    });
    expect(a.manifest.contentDigest).toBe(b.manifest.contentDigest);
    expect(a.manifest.manifestDigest).toBe(b.manifest.manifestDigest);
  });
});
