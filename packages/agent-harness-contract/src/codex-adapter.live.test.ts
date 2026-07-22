/**
 * LIVE Codex adapter smoke — spends real provider capacity, so it is gated:
 *
 *   CODEX_LIVE_SMOKE=1 pnpm --dir packages/agent-harness-contract exec \
 *     vitest run src/codex-adapter.live.test.ts
 *
 * Optional: CODEX_LIVE_MODEL (default gpt-5.6-terra), CODEX_LIVE_EFFORT
 * (default medium), CODEX_LIVE_COMPLEX=1 (multi-step sub-agent scenario,
 * workspace-write sandbox), CODEX_LIVE_BINARY.
 *
 * Proves `makeCodexHarnessAdapter` end to end in OWNER-LOCAL mode: the
 * currently-authenticated default Codex home (CODEX_HOME left unset), the
 * live exec spawner, and the neutral KhalaRuntimeEvent projection. Never
 * runs a login flow.
 */

import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { makeCodexHarnessAdapter } from "./codex-adapter.ts";
import { makeLiveCodexExecSpawner } from "./codex-exec-live-spawner.ts";

const live = process.env.CODEX_LIVE_SMOKE === "1";
const complex = process.env.CODEX_LIVE_COMPLEX === "1";
const model = process.env.CODEX_LIVE_MODEL ?? "gpt-5.6-terra";
const effortEnv = process.env.CODEX_LIVE_EFFORT ?? "medium";
const effort = effortEnv === "low" || effortEnv === "high" ? effortEnv : "medium";

const binary = [
  process.env.CODEX_LIVE_BINARY,
  join(homedir(), ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
]
  .filter((value): value is string => value !== undefined && value !== "")
  .find((path) => existsSync(path));

const SOURCE: KhalaRuntimeSource = { lane: "codex_app_server", adapterKind: "codex" };

const BASIC_PROMPT = "hey who are you";
const COMPLEX_PROMPT =
  "You are in an empty disposable workspace. Complete this multi-step task: " +
  "(1) If you support spawning sub-agents, spawn two in parallel: one writes fizzbuzz.py " +
  "printing FizzBuzz for 1..30, the other writes primes.py printing all primes below 50. " +
  "(2) Write tests.py that runs both scripts and asserts on their output, run it, and fix " +
  "any failure. (3) Write a README.md summarizing every file. (4) Finish with a short " +
  "report: what you created, what the tests showed, and whether sub-agents were used.";

describe.skipIf(!live)("codex adapter — LIVE owner-local smoke", () => {
  test(
    complex ? "complex multi-step turn through the adapter" : "basic turn through the adapter",
    { timeout: 660_000 },
    async () => {
      expect(binary).toBeDefined();
      const workdir = mkdtempSync(join(tmpdir(), "oa-adapter-smoke-"));
      const adapter = makeCodexHarnessAdapter({
        mode: "exec",
        codexBinaryPath: binary as string,
        // codexHome intentionally omitted: OWNER-LOCAL mode.
        workingDirectory: workdir,
        model,
        spawner: makeLiveCodexExecSpawner({
          reasoningEffort: effort,
          sandbox: complex ? "workspace-write" : "read-only",
          timeoutMs: 600_000,
        }),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* adapter.start({
            sessionId: `live-smoke-${process.pid}`,
            source: SOURCE,
          });
          const control = yield* session.promptTurn({
            turnId: "turn-1",
            prompt: complex ? COMPLEX_PROMPT : BASIC_PROMPT,
          });
          const kinds = new Map<string, number>();
          let finalText = "";
          yield* control.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
                const payload = event as { kind: string; text?: string };
                if (
                  (payload.kind === "text.delta" || payload.kind === "text.completed") &&
                  typeof payload.text === "string"
                ) {
                  finalText += payload.text;
                }
              }),
            ),
          );
          const turn = yield* control.done;
          const detach = yield* session.detach();
          return { kinds, finalText, turn, resumeData: detach.data };
        }),
      );

      console.log(`model=${model} effort=${effort} complex=${complex} workdir=${workdir}`);
      console.log(
        `khala events: ${[...result.kinds.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ")}`,
      );
      console.log(`resume data: ${JSON.stringify(result.resumeData)}`);
      console.log(`final: ${String(result.finalText ?? "").slice(0, 400)}`);

      expect(result.turn.finishReason).toBe("stop");
      expect(result.kinds.get("turn.started")).toBe(1);
      expect(result.kinds.get("turn.finished")).toBe(1);
      expect(result.finalText).toBeTruthy();
      // Owner-local resume data must carry the Codex-native thread id.
      expect(JSON.stringify(result.resumeData)).toContain("threadId");
    },
  );
});
