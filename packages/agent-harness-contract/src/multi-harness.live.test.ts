/**
 * LIVE multi-harness orchestration smoke — Codex and Claude Code working in
 * ONE conversation, both through their production adapters in OWNER-LOCAL
 * mode. Spends real capacity on two providers, gated:
 *
 *   MULTI_LIVE_SMOKE=1 pnpm --dir packages/agent-harness-contract exec \
 *     vitest run src/multi-harness.live.test.ts
 *
 * Two scenarios:
 *  - parallel: one user request delegating one task to each harness
 *    simultaneously; the orchestrator merges both answers.
 *  - sequential: Codex produces, Claude critiques and improves the exact
 *    output (a real cross-harness handoff).
 *
 * Each scenario writes a combined transcript (JSONL) interleaving the
 * orchestrator's user/assistant messages, agent.child lifecycle lines per
 * lane, and every neutral KhalaRuntimeEvent with lane + model attribution —
 * gradable by the openagents coherence/complexity grader.
 * Env: MULTI_OUT_DIR (default: a fresh OS-temp dir), MULTI_CODEX_MODEL
 * (default gpt-5.6-terra), MULTI_CLAUDE_MODEL (default
 * claude-haiku-4-5-20251001).
 */

import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import type { AgentHarness } from "./adapter.ts";
import type { ClaudeCodeQuery } from "./claude-code-adapter.ts";
import { makeClaudeCodeHarnessAdapter } from "./claude-code-adapter.ts";
import { makeCodexHarnessAdapter } from "./codex-adapter.ts";
import { makeLiveCodexExecSpawner } from "./codex-exec-live-spawner.ts";

const live = process.env.MULTI_LIVE_SMOKE === "1";
const codexModel = process.env.MULTI_CODEX_MODEL ?? "gpt-5.6-terra";
const claudeModel = process.env.MULTI_CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";
const outDir = process.env.MULTI_OUT_DIR ?? mkdtempSync(join(tmpdir(), "oa-multi-"));

const codexBinary = [
  join(homedir(), ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
].find((path) => existsSync(path));

interface TranscriptLine {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface LaneResult {
  readonly text: string;
  readonly lines: readonly TranscriptLine[];
}

/** Run one turn on a lane and capture its transcript slice with attribution. */
const runLaneTurn = (params: {
  readonly adapter: AgentHarness;
  readonly lane: string;
  readonly model: string;
  readonly source: KhalaRuntimeSource;
  readonly prompt: string;
}): Effect.Effect<LaneResult, unknown> =>
  Effect.gen(function* () {
    const lines: TranscriptLine[] = [];
    lines.push({ type: "agent.child.started", lane: params.lane, model: params.model });
    const session = yield* params.adapter.start({
      sessionId: `${params.lane}-${process.pid}`,
      source: params.source,
    });
    const control = yield* session.promptTurn({ turnId: "turn-1", prompt: params.prompt });
    let text = "";
    yield* control.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          lines.push({ type: "khala", lane: params.lane, model: params.model, event });
          const payload = event as { kind: string; text?: string };
          if (payload.kind === "text.delta" && typeof payload.text === "string") {
            text += payload.text;
          }
          if (payload.kind === "text.completed" && typeof payload.text === "string") {
            text = payload.text;
          }
        }),
      ),
    );
    const result = yield* control.done;
    lines.push({
      type: "agent.child.finished",
      lane: params.lane,
      model: params.model,
      finishReason: result.finishReason,
    });
    return { text, lines };
  });

const writeTranscript = (name: string, lines: readonly TranscriptLine[]): string => {
  const path = join(outDir, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
};

describe.skipIf(!live)("multi-harness LIVE orchestration (codex + claude)", () => {
  const makeAdapters = () => {
    const workdir = mkdtempSync(join(tmpdir(), "oa-multi-work-"));
    const processEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const codex = makeCodexHarnessAdapter({
      mode: "exec",
      codexBinaryPath: codexBinary as string,
      workingDirectory: workdir,
      model: codexModel,
      spawner: makeLiveCodexExecSpawner({ reasoningEffort: "medium", timeoutMs: 300_000 }),
    });
    const claude = makeClaudeCodeHarnessAdapter({
      query: query as unknown as ClaudeCodeQuery,
      env: processEnv,
      cwd: workdir,
      model: claudeModel,
    });
    return { codex, claude };
  };

  const codexSource: KhalaRuntimeSource = { lane: "codex_app_server", adapterKind: "codex" };
  const claudeSource: KhalaRuntimeSource = { lane: "claude_pylon", adapterKind: "claude_code" };

  test(
    "parallel: one task delegated to each harness simultaneously",
    { timeout: 660_000 },
    async () => {
      expect(codexBinary).toBeDefined();
      const { codex, claude } = makeAdapters();
      const userMessage =
        "Two tasks, one for each delegate. CODEX: write a four-line poem about databases. " +
        "CLAUDE: explain what a monad is in exactly two sentences.";
      const lines: TranscriptLine[] = [{ type: "user_message", text: userMessage }];

      const [codexResult, claudeResult] = await Effect.runPromise(
        Effect.all(
          [
            runLaneTurn({
              adapter: codex,
              lane: "codex-local",
              model: codexModel,
              source: codexSource,
              prompt: "Write a four-line poem about databases. Reply with only the poem.",
            }),
            runLaneTurn({
              adapter: claude,
              lane: "claude-local",
              model: claudeModel,
              source: claudeSource,
              prompt: "Explain what a monad is in exactly two sentences.",
            }),
          ],
          { concurrency: 2 },
        ),
      );

      lines.push(...codexResult.lines, ...claudeResult.lines);
      const combined =
        `From Codex (${codexModel}):\n${codexResult.text}\n\n` +
        `From Claude (${claudeModel}):\n${claudeResult.text}`;
      lines.push({ type: "assistant_message", text: combined });
      const path = writeTranscript("multi-parallel.jsonl", lines);

      console.log(`transcript: ${path}`);
      console.log(`codex answer: ${codexResult.text.slice(0, 160)}`);
      console.log(`claude answer: ${claudeResult.text.slice(0, 160)}`);
      expect(codexResult.text.length).toBeGreaterThan(0);
      expect(claudeResult.text.length).toBeGreaterThan(0);
    },
  );

  test(
    "sequential: codex produces, claude improves the handoff",
    { timeout: 660_000 },
    async () => {
      expect(codexBinary).toBeDefined();
      const { codex, claude } = makeAdapters();
      const userMessage =
        "First have CODEX write a limerick about TCP. Then have CLAUDE critique it and " +
        "produce an improved version.";
      const lines: TranscriptLine[] = [{ type: "user_message", text: userMessage }];

      const codexResult = await Effect.runPromise(
        runLaneTurn({
          adapter: codex,
          lane: "codex-local",
          model: codexModel,
          source: codexSource,
          prompt: "Write a limerick about TCP. Reply with only the limerick.",
        }),
      );
      lines.push(...codexResult.lines);
      lines.push({
        type: "agent.child.interacted",
        lane: "claude-local",
        fromLane: "codex-local",
        note: "handoff: codex output forwarded to claude for critique",
      });
      const claudeResult = await Effect.runPromise(
        runLaneTurn({
          adapter: claude,
          lane: "claude-local",
          model: claudeModel,
          source: claudeSource,
          prompt:
            "Another agent wrote this limerick about TCP:\n\n" +
            `${codexResult.text}\n\n` +
            "Critique it in one sentence, then produce an improved version.",
        }),
      );
      lines.push(...claudeResult.lines);
      lines.push({ type: "assistant_message", text: claudeResult.text });
      const path = writeTranscript("multi-sequential.jsonl", lines);

      console.log(`transcript: ${path}`);
      console.log(`codex limerick: ${codexResult.text.slice(0, 200)}`);
      console.log(`claude improvement: ${claudeResult.text.slice(0, 200)}`);
      expect(codexResult.text.length).toBeGreaterThan(0);
      expect(claudeResult.text.length).toBeGreaterThan(0);
    },
  );
});
