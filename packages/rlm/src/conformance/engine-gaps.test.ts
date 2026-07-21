import { Deferred, Effect, Fiber, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { buildInlineCorpusInput } from "../corpus/handle.ts";
import { rlmInlineCorpusSourceLayer } from "../corpus/source.ts";
import { makeRlm, type RlmModelPlan } from "../engine/rlm.ts";
import {
  denyEffectfulRlmToolAuthorizer,
  makeRlmToolHandler,
  type RlmToolAuthorizer,
} from "../tool/rlm-tool.ts";
import { defaultRlmBudget, defaultRlmEvidencePolicy } from "../schemas/budget.ts";
import type { RlmProgram } from "../schemas/program.ts";
import type { RlmSemanticRequest } from "../schemas/request-result.ts";
import { RlmError } from "../schemas/errors.ts";

const corpus = buildInlineCorpusInput({
  corpusRef: "corpus.gaps",
  scopeRef: "scope.gaps",
  entries: [
    {
      scopeRef: "scope.gaps",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "g0" },
      text: "alpha fact one",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.gaps",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "g1" },
      text: "beta fact two",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.gaps",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "g2" },
      text: "gamma fact three",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.gaps",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "g3" },
      text: "delta fact four",
      visibility: "public",
      redactionClass: "none",
    },
  ],
});

/** Partition → ModelMap(parts) → Join → Commit: one root, `parts` leaf calls. */
const mapProgram = (parts: number): RlmProgram => ({
  schemaId: "openagents.ai.rlm_program.v1",
  programRef: "prog.gaps",
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

const semanticRequest = (runRef: string, requireExactUsage: boolean): RlmSemanticRequest => ({
  _tag: "Semantic",
  schemaId: "openagents.ai.rlm_request.v1",
  runRef,
  corpus,
  question: "summarize all facts",
  budget: { ...defaultRlmBudget, requireExactUsage },
  evidence: { ...defaultRlmEvidencePolicy, requireCitations: false, minimumCitations: 0 },
});

describe("RLM engine gaps #26 #27 #28 #29", () => {
  test("#26 emits exactly one RlmModelCallCompleted per model call", async () => {
    const model: RlmModelPlan = {
      completeRoot: () =>
        Effect.succeed({ text: JSON.stringify(mapProgram(4)), inputTokens: 1, outputTokens: 1 }),
      completeLeaf: (prompt) =>
        Effect.succeed({ text: `leaf:${prompt.slice(0, 8)}`, inputTokens: 2, outputTokens: 3 }),
    };

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        return yield* shape.stream(semanticRequest("run.gaps.26", false)).pipe(Stream.runCollect);
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    const modelCalls = Array.from(events).filter((e) => e._tag === "ModelCallCompleted");
    // one root + four ModelMap leaf calls
    expect(modelCalls.length).toBe(5);
    const roots = modelCalls.filter((e) => e._tag === "ModelCallCompleted" && e.role === "root");
    const leaves = modelCalls.filter((e) => e._tag === "ModelCallCompleted" && e.role === "leaf");
    expect(roots.length).toBe(1);
    expect(leaves.length).toBe(4);
    // Every model-call event carries exact usage and causality to its trigger.
    for (const call of modelCalls) {
      if (call._tag !== "ModelCallCompleted") continue;
      expect(call.usageExact).toBe(true);
      expect(call.inputTokens).toBeDefined();
      expect(call.outputTokens).toBeDefined();
      expect(call.causalityRefs?.length ?? 0).toBeGreaterThan(0);
    }
    // Root causality points at the run; leaf causality points at the map node.
    expect(roots[0]?._tag === "ModelCallCompleted" && roots[0].causalityRefs?.[0]).toBe(
      "run.gaps.26",
    );
    expect(
      leaves.every((e) => e._tag === "ModelCallCompleted" && e.causalityRefs?.[0] === "n.map"),
    ).toBe(true);
  });

  test("#27 requireExactUsage fails the run when a model call lacks exact usage", async () => {
    // Root returns exact usage (valid program); the leaf omits token usage.
    const model: RlmModelPlan = {
      completeRoot: () =>
        Effect.succeed({ text: JSON.stringify(mapProgram(4)), inputTokens: 1, outputTokens: 1 }),
      completeLeaf: () => Effect.succeed({ text: "leaf-no-usage" }),
    };

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        return yield* shape.run(semanticRequest("run.gaps.27", true));
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer), Effect.flip),
    );

    expect(error).toBeInstanceOf(RlmError);
    expect(error.reason).toBe("usage_required_but_unavailable");
  });

  test("#27 requireExactUsage completes when every call reports exact usage", async () => {
    const model: RlmModelPlan = {
      completeRoot: () =>
        Effect.succeed({ text: JSON.stringify(mapProgram(4)), inputTokens: 1, outputTokens: 1 }),
      completeLeaf: () => Effect.succeed({ text: "leaf", inputTokens: 1, outputTokens: 1 }),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        return yield* shape.run(semanticRequest("run.gaps.27b", true));
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    expect(result._tag).toBe("Completed");
  });

  test("#28 stream yields events live, before the terminal Answer", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        // A gate holds every leaf call open so the run cannot reach Terminal
        // until the test releases it. A post-hoc buffer would deliver nothing
        // until completion and this test would deadlock/time out.
        const gate = yield* Deferred.make<void>();
        const firstEvent = yield* Deferred.make<void>();
        const received: Array<string> = [];

        const model: RlmModelPlan = {
          completeRoot: () =>
            Effect.succeed({
              text: JSON.stringify(mapProgram(2)),
              inputTokens: 1,
              outputTokens: 1,
            }),
          completeLeaf: () =>
            Effect.gen(function* () {
              yield* Deferred.await(gate);
              return { text: "leaf", inputTokens: 1, outputTokens: 1 };
            }),
        };

        const shape = yield* makeRlm({ model, admitSemantic: true });
        const fiber = yield* shape.stream(semanticRequest("run.gaps.28", false)).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              received.push(event._tag);
              if (received.length === 1) {
                Deferred.doneUnsafe(firstEvent, Effect.void);
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        // Resolves ONLY if events are delivered while the run is still blocked
        // on the leaf gate — i.e. the stream is live, not replayed.
        yield* Deferred.await(firstEvent);
        const terminalBeforeRelease = received.includes("Terminal");

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(fiber);

        return { received: [...received], terminalBeforeRelease };
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    // Events arrived mid-run while Terminal had not yet been produced.
    expect(outcome.terminalBeforeRelease).toBe(false);
    expect(outcome.received.length).toBeGreaterThan(1);
    expect(outcome.received).toContain("ModelCallCompleted");
    // Terminal is the last event once the gate is released.
    expect(outcome.received[outcome.received.length - 1]).toBe("Terminal");
    // A live pre-map event was observed before the terminal.
    expect(outcome.received.indexOf("RunStarted")).toBeGreaterThanOrEqual(0);
    expect(outcome.received.indexOf("RunStarted")).toBeLessThan(
      outcome.received.indexOf("Terminal"),
    );
  });

  test("#29 an un-admitted effectful (semantic) tool call is refused", async () => {
    const model: RlmModelPlan = {
      completeRoot: () =>
        Effect.succeed({ text: JSON.stringify(mapProgram(4)), inputTokens: 1, outputTokens: 1 }),
      completeLeaf: () => Effect.succeed({ text: "leaf", inputTokens: 1, outputTokens: 1 }),
    };

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        // No authorizer injected → deny-by-default for effectful operations.
        const tool = makeRlmToolHandler(shape);
        return yield* tool.handle({
          mode: "semantic",
          runRef: "run.gaps.29",
          question: "summarize",
          corpus,
        });
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer), Effect.flip),
    );

    expect(error).toBeInstanceOf(RlmError);
    expect(error.reason).toBe("authority_not_granted");
  });

  test("#29 read-only recall runs under the default deny authorizer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ admitSemantic: false, model: { refuseSemantic: true } });
        const tool = makeRlmToolHandler(shape, { authorizer: denyEffectfulRlmToolAuthorizer });
        return yield* tool.handle({
          mode: "deterministic",
          runRef: "run.gaps.29b",
          pattern: "fact",
          corpus,
        });
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    expect(result._tag).toBe("Completed");
  });

  test("#29 a granting authorizer admits an effectful tool call", async () => {
    const grantAll: RlmToolAuthorizer = {
      authorize: () => Effect.succeed({ granted: true }),
    };
    const model: RlmModelPlan = {
      completeRoot: () =>
        Effect.succeed({ text: JSON.stringify(mapProgram(4)), inputTokens: 1, outputTokens: 1 }),
      completeLeaf: () => Effect.succeed({ text: "leaf", inputTokens: 1, outputTokens: 1 }),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        const tool = makeRlmToolHandler(shape, { authorizer: grantAll });
        return yield* tool.handle({
          mode: "semantic",
          runRef: "run.gaps.29c",
          question: "summarize",
          corpus,
        });
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );

    expect(result._tag).toBe("Completed");
  });
});
