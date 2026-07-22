import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { buildInlineCorpusInput } from "../corpus/handle.ts";
import { rlmInlineCorpusSourceLayer } from "../corpus/source.ts";
import { makeRlm, type RlmModelPlan } from "../engine/rlm.ts";
import { compileRlmGrepRegex, grepEntries } from "./deterministic.ts";
import { defaultRlmBudget, defaultRlmEvidencePolicy } from "../schemas/budget.ts";
import type { RlmProgram } from "../schemas/program.ts";
import type { RlmDeterministicRequest, RlmSemanticRequest } from "../schemas/request-result.ts";
import { RlmError } from "../schemas/errors.ts";

// ---------------------------------------------------------------------------
// Fixture corpus with feature-signal sentences that only match under a real
// regular expression (alternation, anchors) and NOT under a literal or glob.
// ---------------------------------------------------------------------------

const corpus = buildInlineCorpusInput({
  corpusRef: "corpus.grep",
  scopeRef: "scope.grep",
  entries: [
    {
      scopeRef: "scope.grep",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "e0" },
      text: "We need to win it on identity.",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.grep",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "e1" },
      text: "we need to extend that resilience to the harness.",
      visibility: "public",
      redactionClass: "none",
    },
    {
      scopeRef: "scope.grep",
      sourceKind: "fixture",
      sourceAddress: { addressSchemaId: "test.addr.v1", encodedAddress: "e2" },
      text: "A routine status line with no feature signal.",
      visibility: "public",
      redactionClass: "none",
    },
  ],
});

/** A regex pattern (alternation) that literal-plus-glob matching would miss. */
const REGEX_PATTERN = "we need to (win|extend)";

/** Grep(pattern) → Commit(cite hits): the minimal cited-candidate program. */
const grepCommitProgram = (pattern: string): RlmProgram => ({
  schemaId: "openagents.ai.rlm_program.v1",
  programRef: "prog.grep",
  nodes: [
    {
      _tag: "CorpusOp",
      nodeRef: "n.grep",
      operator: "Grep",
      params: { pattern, caseSensitive: false },
      inputValueRefs: [],
      outputValueRef: "v.hits",
    },
    {
      _tag: "Commit",
      nodeRef: "n.commit",
      valueRef: "v.hits",
      citationValueRefs: ["v.hits"],
    },
  ],
});

const semanticRequest = (
  runRef: string,
  program: RlmProgram,
): {
  readonly request: RlmSemanticRequest;
  readonly model: RlmModelPlan;
} => ({
  request: {
    _tag: "Semantic",
    schemaId: "openagents.ai.rlm_request.v1",
    runRef,
    corpus,
    question: "find feature signals",
    budget: { ...defaultRlmBudget, requireExactUsage: false },
    evidence: { ...defaultRlmEvidencePolicy, requireCitations: true, minimumCitations: 1 },
  },
  model: {
    completeRoot: () =>
      Effect.succeed({ text: JSON.stringify(program), inputTokens: 1, outputTokens: 1 }),
  },
});

const deterministicRequest = (runRef: string, pattern: string): RlmDeterministicRequest => ({
  _tag: "Deterministic",
  schemaId: "openagents.ai.rlm_request.v1",
  runRef,
  corpus,
  operation: { _tag: "Grep", pattern, caseSensitive: false },
  limits: {
    maxEntriesScanned: 100,
    maxSpans: 32,
    maxCharsPerSpan: 512,
    maxObservationChars: 4096,
  },
});

describe("RLM grep regex parity (Tier S CorpusOp matches Tier D)", () => {
  test("compileRlmGrepRegex accepts a valid regex and rejects an invalid one", () => {
    const ok = compileRlmGrepRegex(REGEX_PATTERN, false);
    expect(ok).not.toBeNull();
    expect(ok?.test("we need to win")).toBe(true);
    expect(ok?.test("nothing here")).toBe(false);

    // An unbalanced group is not a valid regex.
    expect(compileRlmGrepRegex("we need to (win", false)).toBeNull();
  });

  test("grepEntries uses full regex semantics (alternation), not literal/glob", () => {
    const { hits } = grepEntries(corpus.entries, REGEX_PATTERN, false, {
      maxScan: 100,
      maxHits: 32,
    });
    // e0 (win) and e1 (extend) match; e2 does not. A literal search for the
    // string "we need to (win|extend)" would have found zero.
    expect(hits.map((h) => h.entryRef)).toEqual(["entry.0", "entry.1"]);
  });

  test("Tier D deterministic Grep matches the same regex hits", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({});
        return yield* shape.run(deterministicRequest("run.grep.d", REGEX_PATTERN));
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );
    expect(result._tag).toBe("Completed");
    if (result._tag === "Refused") throw new Error("unexpected refusal");
    expect(result.citations.length).toBe(2);
  });

  test("Tier S CorpusOp Grep completes with cited candidates on a regex pattern", async () => {
    const { request, model } = semanticRequest("run.grep.s", grepCommitProgram(REGEX_PATTERN));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        return yield* shape.run(request);
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer)),
    );
    // Before the fix, the escaped literal/glob pattern found zero hits and the
    // run terminated Partial with reason "invalid_citations". With regex parity
    // the same pattern yields validated citations for exactly the two matching
    // entries and completes.
    expect(result._tag).toBe("Completed");
    if (result._tag === "Refused") throw new Error("unexpected refusal");
    expect(result.citations.length).toBeGreaterThan(0);
    const cited = new Set(result.citations.map((c) => c.entryRefStart));
    expect([...cited].sort()).toEqual(["entry.0", "entry.1"]);
  });

  test("Tier S CorpusOp Grep fails typed on an invalid regex, not invalid_citations", async () => {
    const { request, model } = semanticRequest(
      "run.grep.s.bad",
      grepCommitProgram("we need to (win"),
    );
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const shape = yield* makeRlm({ model, admitSemantic: true });
        return yield* shape.run(request);
      }).pipe(Effect.provide(rlmInlineCorpusSourceLayer), Effect.flip),
    );
    expect(error).toBeInstanceOf(RlmError);
    expect(error.reason).toBe("operation_contract_violation");
  });
});
