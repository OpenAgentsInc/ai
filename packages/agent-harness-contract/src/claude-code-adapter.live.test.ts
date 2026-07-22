/**
 * LIVE Claude Code adapter smoke — spends real provider capacity, gated:
 *
 *   CLAUDE_LIVE_SMOKE=1 pnpm --dir packages/agent-harness-contract exec \
 *     vitest run src/claude-code-adapter.live.test.ts
 *
 * Optional: CLAUDE_LIVE_MODEL (default claude-haiku-4-5-20251001),
 * CLAUDE_LIVE_COMPLEX=1 (multi-step scenario with allow-all permission mode).
 *
 * Proves `makeClaudeCodeHarnessAdapter` end to end in OWNER-LOCAL mode: the
 * currently-authenticated default Claude home (CLAUDE_CONFIG_DIR unset), the
 * real `@anthropic-ai/claude-agent-sdk` `query` as the injected seam, and
 * the neutral KhalaRuntimeEvent projection. Never runs a login flow.
 */

import { describe, expect, test } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import type { ClaudeCodeQuery } from "./claude-code-adapter.ts";
import { makeClaudeCodeHarnessAdapter } from "./claude-code-adapter.ts";

const live = process.env.CLAUDE_LIVE_SMOKE === "1";
const complex = process.env.CLAUDE_LIVE_COMPLEX === "1";
const model = process.env.CLAUDE_LIVE_MODEL ?? "claude-haiku-4-5-20251001";

const SOURCE: KhalaRuntimeSource = { lane: "claude_pylon", adapterKind: "claude_code" };

const BASIC_PROMPT = "hey who are you";
const COMPLEX_PROMPT =
  "You are in an empty disposable workspace. Complete this multi-step task: " +
  "(1) Write fizzbuzz.py printing FizzBuzz for 1..30 and primes.py printing all primes " +
  "below 50. (2) Write tests.py that runs both scripts and asserts on their output, run " +
  "it, and fix any failure. (3) Write a README.md summarizing every file. (4) Finish " +
  "with a short report: what you created and what the tests showed.";

describe.skipIf(!live)("claude code adapter — LIVE owner-local smoke", () => {
  test(
    complex ? "complex multi-step turn through the adapter" : "basic turn through the adapter",
    { timeout: 660_000 },
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), "oa-claude-smoke-"));
      const processEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const adapter = makeClaudeCodeHarnessAdapter({
        // The real SDK query is structurally the injected seam.
        query: query as unknown as ClaudeCodeQuery,
        // configDir intentionally omitted: OWNER-LOCAL mode. The SDK child
        // env REPLACES process env, so inherit it for auth/PATH/HOME.
        env: processEnv,
        cwd: workdir,
        model,
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* adapter.start({
            sessionId: `live-claude-${process.pid}`,
            source: SOURCE,
            ...(complex ? { permissionMode: "allow-all" as const } : {}),
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
                if (payload.kind === "text.delta" && typeof payload.text === "string") {
                  finalText += payload.text;
                }
                if (payload.kind === "text.completed" && typeof payload.text === "string") {
                  finalText = payload.text;
                }
              }),
            ),
          );
          const turn = yield* control.done;
          const detach = yield* session.detach();
          return { kinds, finalText, turn, resumeData: detach.data, modelId: session.modelId };
        }),
      );

      console.log(`model=${model} complex=${complex} workdir=${workdir}`);
      console.log(
        `khala events: ${[...result.kinds.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ")}`,
      );
      console.log(`sdk model: ${JSON.stringify(result.modelId ?? null)}`);
      console.log(`resume data: ${JSON.stringify(result.resumeData)}`);
      console.log(`final: ${String(result.finalText ?? "").slice(0, 300)}`);

      expect(result.turn.finishReason).toBe("stop");
      expect(result.kinds.get("turn.started")).toBe(1);
      expect(result.kinds.get("turn.finished")).toBe(1);
      expect(result.finalText).toBeTruthy();
    },
  );
});
