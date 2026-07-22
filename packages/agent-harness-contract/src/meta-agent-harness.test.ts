import { Effect, Stream } from "effect";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { describe, expect, test } from "vite-plus/test";

import { HarnessCapabilityUnsupported } from "./capability.ts";
import { metaAgentHarness } from "./meta-agent-harness.ts";
import { makeReferenceAdapter } from "./reference-adapter.ts";
import { HarnessTurnError } from "./session.ts";
import type { HarnessStreamEvent } from "./stream.ts";

const SOURCE: KhalaRuntimeSource = { lane: "test_fixture" };

const collect = (
  stream: Stream.Stream<HarnessStreamEvent, unknown>,
): Effect.Effect<ReadonlyArray<HarnessStreamEvent>, unknown> => Stream.runCollect(stream);

const sequences = (events: ReadonlyArray<HarnessStreamEvent>) => events.map((e) => e.sequence);

/** Two-member fleet routed by prompt prefix: `beta:` goes to beta, else alpha. */
const makeFleet = (options?: {
  readonly alphaWords?: ReadonlyArray<string>;
  readonly alphaSupportsSuspend?: boolean;
  readonly alphaSupportsCompact?: boolean;
  readonly alphaLossy?: boolean;
}) =>
  metaAgentHarness({
    members: [
      {
        id: "alpha",
        harness: makeReferenceAdapter({
          harnessId: "ref-alpha",
          scriptWords: options?.alphaWords ?? ["a", "b", "c"],
          supportsSuspend: options?.alphaSupportsSuspend ?? true,
          supportsCompact: options?.alphaSupportsCompact ?? true,
          continueIsLossy: options?.alphaLossy ?? false,
        }),
      },
      {
        id: "beta",
        harness: makeReferenceAdapter({ harnessId: "ref-beta", scriptWords: ["x", "y"] }),
      },
    ],
    route: ({ prompt }) => (prompt.startsWith("beta:") ? "beta" : "alpha"),
  });

// ---------------------------------------------------------------------------
// The same adapter law suite the reference and seven runtime adapters pass.
// ---------------------------------------------------------------------------

describe("meta-agent harness — turn semantics (adapter laws)", () => {
  test("a full turn streams turn.started -> ... -> turn.finished with contiguous sequences", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const events = yield* collect(control.events);
        const done = yield* control.done;
        return { events, done };
      }),
    );

    expect(result.events[0]?.kind).toBe("turn.started");
    expect(result.events.at(-1)?.kind).toBe("turn.finished");
    // turn.started + agent.child.started + 3 text.delta + agent.child.finished
    // + turn.finished = 7 events, sequences 0..6.
    expect(sequences(result.events)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.done.finishReason).toBe("stop");
    expect(result.done.lastCursor).toBe(6);
  });

  test("suspend then continue replays from cursor+1 with no gap and no duplicate", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();

        // Phase 1: pull only the first three events, then suspend.
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(3)));
        const continuation = yield* session.suspendTurn();

        // Phase 2: a FRESH session (different process) resumes from the cursor.
        const session2 = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* collect(control2.events);

        return { phase1, continuation, phase2 };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1, 2]);
    expect(outcome.continuation.cursor).toBe(2);
    expect(outcome.continuation.lossy).toBe(false);
    // Phase 2 attaches at cursor + 1 — no gap, no duplicate.
    expect(outcome.phase2[0]?.sequence).toBe(outcome.continuation.cursor + 1);
    expect(sequences(outcome.phase2)).toEqual([3, 4, 5, 6]);

    const merged = sequences([...outcome.phase1, ...outcome.phase2]);
    expect(merged).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(merged).size).toBe(merged.length);
    expect([...outcome.phase1, ...outcome.phase2].at(-1)?.kind).toBe("turn.finished");
  });

  test("suspend between a member event and its synthetic frame keeps the tail (no lost event)", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();

        // 7 total meta events; take 6 stops right after agent.child.finished(5)
        // and BEFORE turn.finished(6), which the member side already produced.
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const phase1 = yield* collect(control.events.pipe(Stream.take(6)));
        const continuation = yield* session.suspendTurn();

        const session2 = yield* adapter.start({
          sessionId: "s1",
          source: SOURCE,
          continueFrom: continuation,
        });
        const control2 = yield* session2.continueTurn({});
        const phase2 = yield* collect(control2.events);
        const done = yield* control2.done;
        return { phase1, continuation, phase2, done };
      }),
    );

    expect(sequences(outcome.phase1)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(outcome.continuation.cursor).toBe(5);
    expect(sequences(outcome.phase2)).toEqual([6]);
    expect(outcome.phase2[0]?.kind).toBe("turn.finished");
    expect(outcome.done.finishReason).toBe("stop");
    expect(outcome.done.lastCursor).toBe(6);
  });

  test("a lossy member reports the meta continuation as re-driven", async () => {
    const continuation = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet({ alphaLossy: true });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events.pipe(Stream.take(1)));
        return yield* session.suspendTurn();
      }),
    );
    expect(continuation.lossy).toBe(true);
  });
});

describe("meta-agent harness — capability refusal is fail-closed", () => {
  test("a member that cannot compact fails the meta compact with a typed capability error", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const adapter = makeFleet({ alphaSupportsCompact: false });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        return yield* session.compact();
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("suspend on a member without suspend propagates the member's typed refusal", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet({ alphaSupportsSuspend: false });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events.pipe(Stream.take(1)));
        return yield* session.suspendTurn().pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HarnessCapabilityUnsupported);
    expect(error.capability).toBe("suspend_turn");
  });
});

describe("meta-agent harness — lifecycle export", () => {
  test("detach and stop return re-importable resume state naming the meta session", async () => {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        yield* collect(control.events);
        const detached = yield* session.detach();
        const stopped = yield* session.stop();
        return { detached, stopped };
      }),
    );
    expect(states.detached.harnessId).toBe("meta-agent");
    expect(states.detached.sessionId).toBe("s1");
    expect(states.stopped.sessionId).toBe("s1");
    // The exported payload carries the member states for re-import.
    const data = states.detached.data as { members: ReadonlyArray<{ memberId: string }> };
    expect(data.members.map((m) => m.memberId)).toEqual(["alpha"]);
  });
});

// ---------------------------------------------------------------------------
// Meta-specific laws: routing, attribution, capability honesty.
// ---------------------------------------------------------------------------

describe("meta-agent harness — member attribution (no laundering)", () => {
  test("delegated events keep member source refs and gain member causality refs", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        return yield* collect(control.events);
      }),
    );

    const textDeltas = events.filter((e) => e.kind === "text.delta");
    expect(textDeltas.length).toBe(3);
    for (const event of textDeltas) {
      // Member attribution is preserved on the event source…
      expect(event.source.providerRef).toBe("provider.member.alpha");
      expect(event.source.adapterSessionRef).toBe("member.alpha.s1");
      // …and the original member event id rides the causality refs.
      expect(event.causalityRefs.some((ref) => ref.startsWith("cause.member.alpha."))).toBe(true);
    }
  });

  test("the delegated turn is bracketed by agent.child.started/finished naming member and parent", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        const control = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        return yield* collect(control.events);
      }),
    );

    const started = events.find((e) => e.kind === "agent.child.started");
    const finished = events.find((e) => e.kind === "agent.child.finished");
    expect(started).toBeDefined();
    expect(finished).toBeDefined();
    if (started?.kind === "agent.child.started") {
      expect(started.childAgentId).toBe("alpha");
      expect(started.parentAgentId).toBe("meta-agent");
    }
    if (finished?.kind === "agent.child.finished") {
      expect(finished.childAgentId).toBe("alpha");
      expect(finished.finishReason).toBe("stop");
    }
  });
});

describe("meta-agent harness — routing across members", () => {
  test("consecutive turns route to different members with one contiguous session cursor", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeFleet();
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });

        const control1 = yield* session.promptTurn({ turnId: "t1", prompt: "hi" });
        const turn1 = yield* collect(control1.events);
        const done1 = yield* control1.done;

        const control2 = yield* session.promptTurn({ turnId: "t2", prompt: "beta: go" });
        const turn2 = yield* collect(control2.events);
        const done2 = yield* control2.done;

        return { turn1, done1, turn2, done2 };
      }),
    );

    // Turn 1 went to alpha, turn 2 to beta — visible in the attribution.
    const child1 = outcome.turn1.find((e) => e.kind === "agent.child.started");
    const child2 = outcome.turn2.find((e) => e.kind === "agent.child.started");
    if (child1?.kind === "agent.child.started") expect(child1.childAgentId).toBe("alpha");
    if (child2?.kind === "agent.child.started") expect(child2.childAgentId).toBe("beta");

    // The meta cursor is session-global and contiguous across member boundaries.
    const merged = sequences([...outcome.turn1, ...outcome.turn2]);
    expect(merged[0]).toBe(0);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]).toBe((merged[i - 1] ?? -1) + 1);
    }
    expect(outcome.done2.lastCursor).toBe(merged.length - 1);
  });

  test("a route to an unknown member fails typed, not silently", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = metaAgentHarness({
          members: [{ id: "alpha", harness: makeReferenceAdapter() }],
          route: () => "missing",
        });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.promptTurn({ turnId: "t1", prompt: "hi" }).pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HarnessTurnError);
    expect(error.failureClass).toBe("unknown_member");
  });

  test("a throwing route fails the turn typed", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = metaAgentHarness({
          members: [{ id: "alpha", harness: makeReferenceAdapter() }],
          route: () => {
            throw new Error("no route");
          },
        });
        const session = yield* adapter.start({ sessionId: "s1", source: SOURCE });
        return yield* session.promptTurn({ turnId: "t1", prompt: "hi" }).pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(HarnessTurnError);
    expect(error.failureClass).toBe("route_failed");
  });
});

describe("meta-agent harness — capability honesty is the member intersection", () => {
  test("builtin tools and flags reflect what EVERY member supports", () => {
    const both = metaAgentHarness({
      members: [
        { id: "alpha", harness: makeReferenceAdapter() },
        { id: "beta", harness: makeReferenceAdapter() },
      ],
      route: () => "alpha",
    });
    // Both reference members expose Bash, so the intersection keeps it.
    expect(both.builtinTools.map((t) => t.nativeName)).toEqual(["Bash"]);
    // Reference members do not support native approvals/filtering.
    expect(both.supportsBuiltinToolApprovals).toBe(false);
    expect(both.supportsBuiltinToolFiltering).toBe(false);
    expect(both.specificationVersion).toBe("agent-harness-v1");
    expect(both.harnessId).toBe("meta-agent");
  });

  test("configuration is validated: empty fleets and duplicate ids are rejected", () => {
    expect(() => metaAgentHarness({ members: [], route: () => "x" })).toThrow();
    expect(() =>
      metaAgentHarness({
        members: [
          { id: "alpha", harness: makeReferenceAdapter() },
          { id: "alpha", harness: makeReferenceAdapter() },
        ],
        route: () => "alpha",
      }),
    ).toThrow();
  });
});
