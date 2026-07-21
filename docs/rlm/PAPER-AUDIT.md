# RLM paper fidelity audit

**Paper:** Zhang, Kraska, and Khattab, _Recursive Language Models_,
arXiv:2512.24601v3

**Audit date:** 2026-07-21

**Local source reviewed:** `~/Downloads/arXiv-2512.24601v3/`

This audit compares the complete v3 paper package—including the algorithms,
methods prompts, negative results, quantitative appendices, figures, and
trajectory screenshots—with the first draft of this SDK specification. It is
normative where it identifies corrections to the SDK plan.

## 1. Release-blocking finding

The first draft captured symbolic corpus access, bounded observations, global
budgets, typed recursion, and Effect lifecycle semantics. It missed one of the
paper's three defining properties: **programmatic symbolic recursion inside a
persistent environment**.

The paper contrasts its RLM algorithm with a deliberately poor scaffold. In
the poor scaffold, code execution and a sub-LLM are separate model-selected
actions, so every subcall must be explicitly verbalized by another root-model
turn. The first draft's one-`Subcall`-per-iteration operation loop had the same
expressive limitation. Calling that surface first-class RLM would therefore be
incorrect even though it was recursive in a loose sense.

The correction is not to embed Python. The SDK uses a safe, typed equivalent:

- a scoped persistent symbolic environment;
- opaque value and collection refs whose full contents stay outside the root
  model context;
- a Schema-decoded declarative program graph;
- bounded deterministic operators over corpus/value refs;
- programmatic `ModelMap` for one-shot leaf calls and `RlmMap` for recursive
  calls;
- bounded reduce/compose operations and an explicit `Commit` of an existing
  value;
- atomic whole-program budget reservation and structured Effect fibers;
- optional artifact-backed output for results too large to inline.

This preserves the paper's symbolic recursion while keeping arbitrary model
code, shell access, filesystem access, and foreign processes out of the core
engine.

## 2. Paper property matrix

| Paper property                                                              | First draft                                   | Required correction                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Prompt/context lives behind a symbolic handle                               | Mostly covered by the immutable corpus        | Make the core corpus contract generic and capable of out-of-core access rather than history-array-only                         |
| Root receives metadata and bounded previews, not the whole prompt           | Covered                                       | Value observations must also return metadata/previews while full values remain in the environment                              |
| Persistent external state across root iterations                            | Missing                                       | Add a run-scoped `RlmEnvironment` with opaque value refs and deterministic cleanup                                             |
| Sub-LM calls can be launched programmatically over a collection             | Missing; one explicit `Subcall` per root turn | Add bounded declarative map/batch nodes with atomic fan-out and call reservation                                               |
| One-shot sub-LM and recursive sub-RLM calls are distinct                    | Missing                                       | Add separate `ModelMap` and `RlmMap` semantics; depth applies only to recursive RLM calls                                      |
| Intermediate results are stored symbolically and composed                   | Missing                                       | Add value collections, deterministic operators, reduce/compose, digests, and lineage                                           |
| Final output can come from stored state rather than another root generation | Missing; `Answer` carried inline text         | Replace normative inline `Answer` with `Commit(valueRef, citations)`                                                           |
| Effective output can exceed one model call's output window                  | Missing                                       | Add bounded inline output plus host-admitted artifact output and output-byte budgets                                           |
| Arbitrary input structures and task-agnostic use                            | Too history-specific                          | Make `RlmCorpusInput`, source refs, entries, and source addresses generic; keep history as an adapter in a separate dependency |
| Depth zero remains a semantic RLM with symbolic environment but no subcalls | Ambiguous                                     | Test semantic depth 0 separately from deterministic Tier D                                                                     |
| Higher depth is not monotonically better                                    | Partially covered by admission gate           | Evaluate direct, depth 0, depth 1, and higher depth independently by model/task family                                         |
| Sequential subcalls create severe latency                                   | Deferred                                      | Ship bounded structured concurrency for map nodes or explicitly fail the first-class release gate                              |
| Subcall count and cost are long-tailed and model-dependent                  | Covered in principle                          | Require p50/p75/p90/p95/p99 latency, calls, tokens, and cost, stratified by success/failure                                    |
| Prompt examples and strategy are model-sensitive                            | Missing                                       | Version strategy/prompt profiles and record `strategyRef` in runs and evaluation artifacts                                     |
| Per-call context/output limits can fail even under a global token budget    | Missing                                       | Add trusted per-model prompt/output headroom and preflight enforcement                                                         |
| Dense tasks scale as constant, linear, and quadratic work                   | Partially covered                             | Add explicit O(1), O(n), and O(n^2) fixture families across increasing lengths                                                 |
| Demonstrated contexts reach 1M and 10M+ tokens                              | Missing from conformance scale                | Add generated million-token and 10M+-token/out-of-core smoke fixtures without putting them in the root prompt                  |
| Long-output tasks require exact programmatic assembly                       | Missing                                       | Add artifact/collection output conformance and exact ordering/digest tests                                                     |

## 3. Algorithmic fidelity requirements

The release is paper-faithful only if all of the following are true:

1. A single root-produced program can cause multiple leaf calls over a
   programmatically selected collection without another root call between
   children.
2. Intermediate outputs survive as opaque values across root iterations while
   the root sees only bounded metadata or previews.
3. A recursive program node can invoke child RLM loops, while a one-shot model
   node does not consume recursion depth.
4. A final result commits an existing environment value. The engine never
   guesses whether free-form prose was a thought or a final answer.
5. Large output can be assembled without asking one model call to emit the
   entire output and without placing it in the root transcript.
6. Every program node, fan-out item, model call, recursive call, value byte,
   artifact byte, and fiber is covered by finite global limits and scoped
   cleanup.

A surface that only offers search/slice plus one explicit subcall per root turn
is useful recursive recall, but it does not pass this first-class RLM gate.

## 4. Safety translation

The paper's Python REPL is one implementation of an external symbolic
environment, not a requirement to run arbitrary code in production. The SDK
translation deliberately narrows execution:

- programs are Effect Schema values, not source text;
- graphs are finite, acyclic, statically validated, and hard-capped;
- only registered pure deterministic operators may touch stored values;
- model nodes can read only explicitly selected bounded inputs;
- source authorization is complete before values enter the environment;
- the environment is scoped to one run and is non-durable by default;
- durable artifacts require an explicit host-provided sink and policy;
- no operator can select credentials, providers, account policy, filesystem
  paths, or side-effecting application Tools.

This is stricter than the research scaffold while retaining the properties
responsible for its expressiveness.

## 5. Evaluation corrections from the appendices

The paper's averages hide important operational behavior:

- successful and failed trajectories can use radically different numbers of
  subcalls;
- cost and runtime have sharp 95th-percentile tails;
- some models launch hundreds or thousands of unnecessary calls;
- depth above one sometimes improves quality and sometimes makes it worse due
  to propagated errors;
- a depth-zero symbolic environment can beat recursive variants on some
  tasks;
- strategy examples materially change the first decomposition and final
  quality;
- models can exhaust per-call output tokens even when the overall run budget
  remains;
- the research implementation's `FINAL` versus `FINAL_VAR` convention is
  brittle;
- long-output tasks succeed by assembling stored values, not by asking the root
  model to regenerate the answer.

Consequently, the SDK and OpenAgents evaluation gates must report distributions
and failure-stratified data, pin strategy profiles, test per-call headroom, and
score exact large-output assembly. Mean quality and mean cost are insufficient.

## 6. Work-plan impact

- Expand SDK-RLM-01 and SDK-RLM-03 for generic/out-of-core corpus handles and
  value/artifact contracts.
- Move the granular implementation into `@openagentsinc/rlm`;
  `@openagentsinc/history-corpus` becomes a history adapter and compatibility
  package rather than the home of the generic engine.
- Add **SDK-RLM-04A — typed symbolic environment and programmatic recursion**
  as a release-blocking issue before the semantic engine can be called
  first-class.
- Expand SDK-RLM-04 for strategy profiles, per-call model limits, declarative
  program generation, and distinct model/RLM nodes.
- Expand SDK-RLM-05 for program/value/artifact events and structured
  concurrency.
- Expand SDK-RLM-07 for paper-faithful scale, depth, long-output, strategy, and
  tail-distribution conformance.
- Keep OpenAgents' `history_recall` terminal result bounded and inline for the
  first rollout; artifact output is an SDK capability, not automatically an
  admitted desktop tool behavior.

SDK-RLM-08 cannot publish the first-class rc until the new SDK-RLM-04A gate and
its conformance coverage are complete.
