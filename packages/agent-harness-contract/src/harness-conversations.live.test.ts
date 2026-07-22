/**
 * LIVE multi-turn conversation smokes across the three working harness
 * lanes (Codex, Claude Code, opencode), all through the production adapters
 * and the shared conversation driver, all OWNER-LOCAL. Gated:
 *
 *   CONVO_LIVE_SMOKE=1 pnpm --dir packages/agent-harness-contract exec \
 *     vitest run src/harness-conversations.live.test.ts
 *
 * Each lane runs the SAME three-turn script on one session:
 *   1. seed a fact + identity question,
 *   2. continuity question that needs the fact from turn 1,
 *   3. a correction turn revising the fact (also exercises the grader's
 *      correction signal deliberately).
 *
 * Transcripts land in CONVO_OUT_DIR (default: fresh OS-temp dir) as
 * convo-<lane>.jsonl in the combined gradable format.
 */

import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import type { ClaudeCodeQuery } from "./claude-code-adapter.ts";
import { makeClaudeCodeHarnessAdapter } from "./claude-code-adapter.ts";
import { makeCodexHarnessAdapter } from "./codex-adapter.ts";
import { makeLiveCodexExecSpawner } from "./codex-exec-live-spawner.ts";
import { runHarnessConversation } from "./harness-conversation-driver.ts";
import { makeAcpHarnessAdapter } from "./acp-adapter.ts";
import { makeCursorHarnessAdapter } from "./cursor-adapter.ts";
import { makeLiveCursorAcpTransport } from "./cursor-acp-live-transport.ts";
import { makeLiveGrokAcpTransport } from "./grok-acp-live-transport.ts";
import { makeOpencodeAdapter } from "./opencode-adapter.ts";
import { makeLiveOpencodeTransport } from "./opencode-live-transport.ts";

const live = process.env.CONVO_LIVE_SMOKE === "1";
const outDir = process.env.CONVO_OUT_DIR ?? mkdtempSync(join(tmpdir(), "oa-convo-"));

const codexModel = process.env.CONVO_CODEX_MODEL ?? "gpt-5.6-terra";
const claudeModel = process.env.CONVO_CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";
const opencodeModel = process.env.CONVO_OPENCODE_MODEL ?? "opencode/claude-haiku-4-5";

const USER_TURNS: readonly string[] = [
  "My favorite number is 41. Remember it. Also: who are you, in one sentence?",
  "What is my favorite number plus one? Reply with just the number.",
  "No, that's not what I asked for — I meant my OTHER favorite number, 50. What is 50 plus one? Reply with just the number.",
];

const codexBinary = [
  join(homedir(), ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
].find((path) => existsSync(path));

const grokBinary = [
  join(homedir(), ".grok", "bin", "grok"),
  "/opt/homebrew/bin/grok",
  "/usr/local/bin/grok",
].find((path) => existsSync(path));

const cursorBinary = [
  join(homedir(), ".local", "bin", "cursor-agent"),
  "/opt/homebrew/bin/cursor-agent",
].find((path) => existsSync(path));

const opencodeBinary = [
  join(homedir(), ".opencode", "bin", "opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
].find((path) => existsSync(path));

const processEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const writeTranscript = (lane: string, lines: readonly { readonly type: string }[]): string => {
  const path = join(outDir, `convo-${lane}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
};

const report = (result: {
  readonly lane: string;
  readonly turns: readonly { readonly answer: string; readonly finishReason: string }[];
}): void => {
  for (const [index, turn] of result.turns.entries()) {
    console.log(
      `${result.lane} turn ${index + 1} [${turn.finishReason}]: ${turn.answer.replace(/\s+/g, " ").slice(0, 120)}`,
    );
  }
};

describe.skipIf(!live)("multi-turn LIVE conversations per harness", () => {
  test("codex: three turns with continuity and correction", { timeout: 900_000 }, async () => {
    expect(codexBinary).toBeDefined();
    const workdir = mkdtempSync(join(tmpdir(), "oa-convo-codex-"));
    const source: KhalaRuntimeSource = { lane: "codex_app_server", adapterKind: "codex" };
    const adapter = makeCodexHarnessAdapter({
      mode: "exec",
      codexBinaryPath: codexBinary as string,
      workingDirectory: workdir,
      model: codexModel,
      spawner: makeLiveCodexExecSpawner({ reasoningEffort: "medium", timeoutMs: 300_000 }),
    });
    const result = await Effect.runPromise(
      runHarnessConversation({
        adapter,
        lane: "codex-local",
        model: codexModel,
        source,
        sessionId: `convo-codex-${process.pid}`,
        userTurns: USER_TURNS,
      }),
    );
    console.log(`transcript: ${writeTranscript("codex", result.transcriptLines)}`);
    report(result);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[1].answer).toContain("42");
    expect(result.turns[2].answer).toContain("51");
  });

  test("claude: three turns with continuity and correction", { timeout: 900_000 }, async () => {
    const workdir = mkdtempSync(join(tmpdir(), "oa-convo-claude-"));
    const source: KhalaRuntimeSource = { lane: "claude_pylon", adapterKind: "claude_code" };
    const adapter = makeClaudeCodeHarnessAdapter({
      query: query as unknown as ClaudeCodeQuery,
      env: processEnv,
      cwd: workdir,
      model: claudeModel,
    });
    const result = await Effect.runPromise(
      runHarnessConversation({
        adapter,
        lane: "claude-local",
        model: claudeModel,
        source,
        sessionId: `convo-claude-${process.pid}`,
        userTurns: USER_TURNS,
      }),
    );
    console.log(`transcript: ${writeTranscript("claude", result.transcriptLines)}`);
    report(result);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[1].answer).toContain("42");
    expect(result.turns[2].answer).toContain("51");
  });

  test("opencode: three turns with continuity and correction", { timeout: 900_000 }, async () => {
    expect(opencodeBinary).toBeDefined();
    const workdir = mkdtempSync(join(tmpdir(), "oa-convo-opencode-"));
    const source: KhalaRuntimeSource = { lane: "agent_client_protocol", adapterKind: "opencode" };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeLiveOpencodeTransport({
          binaryPath: opencodeBinary as string,
          directory: workdir,
        });
        const adapter = makeOpencodeAdapter({
          transport,
          model: opencodeModel,
          directory: workdir,
        });
        const conversation = yield* runHarnessConversation({
          adapter,
          lane: "opencode-local",
          model: opencodeModel,
          source,
          sessionId: `convo-opencode-${process.pid}`,
          userTurns: USER_TURNS,
        });
        yield* transport.shutdown();
        return conversation;
      }),
    );
    console.log(`transcript: ${writeTranscript("opencode", result.transcriptLines)}`);
    report(result);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[1].answer).toContain("42");
    expect(result.turns[2].answer).toContain("51");
  });

  test("grok (ACP): three turns with continuity and correction", { timeout: 900_000 }, async () => {
    expect(grokBinary).toBeDefined();
    const workdir = mkdtempSync(join(tmpdir(), "oa-convo-grok-"));
    const source: KhalaRuntimeSource = { lane: "agent_client_protocol", adapterKind: "grok_cli" };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeLiveGrokAcpTransport({
          binaryPath: grokBinary as string,
          cwd: workdir,
        });
        const adapter = makeAcpHarnessAdapter({
          harnessId: "grok",
          harnessKind: "grok_cli",
          transport,
        });
        const conversation = yield* runHarnessConversation({
          adapter,
          lane: "grok-local",
          model: "grok-default",
          source,
          sessionId: `convo-grok-${process.pid}`,
          userTurns: USER_TURNS,
        });
        yield* transport.shutdown();
        return conversation;
      }),
    );
    console.log(`transcript: ${writeTranscript("grok", result.transcriptLines)}`);
    report(result);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[1].answer).toContain("42");
    expect(result.turns[2].answer).toContain("51");
  });

  test(
    "cursor (ACP): three turns with continuity and correction",
    { timeout: 900_000 },
    async () => {
      expect(cursorBinary).toBeDefined();
      const workdir = mkdtempSync(join(tmpdir(), "oa-convo-cursor-"));
      const source: KhalaRuntimeSource = {
        lane: "agent_client_protocol",
        adapterKind: "cursor_cli",
      };
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* makeLiveCursorAcpTransport({
            binaryPath: cursorBinary as string,
            cwd: workdir,
          });
          const adapter = makeCursorHarnessAdapter({
            cursorAgentPath: cursorBinary as string,
            transport,
          });
          const conversation = yield* runHarnessConversation({
            adapter,
            lane: "cursor-local",
            model: "cursor-default",
            source,
            sessionId: `convo-cursor-${process.pid}`,
            userTurns: USER_TURNS,
          });
          yield* transport.shutdown();
          return conversation;
        }),
      );
      console.log(`transcript: ${writeTranscript("cursor", result.transcriptLines)}`);
      report(result);
      expect(result.turns).toHaveLength(3);
      expect(result.turns[1].answer).toContain("42");
      expect(result.turns[2].answer).toContain("51");
    },
  );
});
