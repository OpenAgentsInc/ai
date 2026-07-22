/**
 * LIVE Pi harness smoke — in-process `createAgentSession` from the real
 * `@earendil-works/pi-coding-agent`, driven through `makePiHarnessAdapter`
 * and the shared conversation driver. Gated:
 *
 *   PI_LIVE_SMOKE=1 pnpm --dir packages/agent-harness-contract exec \
 *     vitest run src/pi-adapter.live.test.ts
 *
 * Auth (owner decision): reuses the developer's Gemini API key from the
 * opencode auth store (`~/.local/share/opencode/auth.json`, provider
 * `google`), exported in-process as GEMINI_API_KEY. The key is never
 * printed or persisted anywhere else. Model: `google/gemini-3-flash`
 * (override with PI_LIVE_MODEL=<provider/model>).
 *
 * The agent dir is a fresh isolated temp dir — the adapter's live `~/.pi`
 * refusal stays in force for Pi (no owner Pi install is touched).
 */

import { describe, expect, test } from "vite-plus/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { runHarnessConversation } from "./harness-conversation-driver.ts";
import type { PiCreateSessionOptions, PiSessionSurface } from "./pi-adapter.ts";
import { makePiHarnessAdapter } from "./pi-adapter.ts";

const live = process.env.PI_LIVE_SMOKE === "1";
const modelSpec = process.env.PI_LIVE_MODEL ?? "google/gemini-3.6-flash";

const USER_TURNS: readonly string[] = [
  "My favorite number is 41. Remember it. Also: who are you, in one sentence?",
  "What is my favorite number plus one? Reply with just the number.",
  "No, that's not what I asked for — I meant my OTHER favorite number, 50. What is 50 plus one? Reply with just the number.",
];

/** Load the developer's Gemini key from the opencode auth store, in-process only. */
const loadGeminiKey = (): string | null => {
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"),
    ) as Record<string, { key?: string }>;
    const key = auth.google?.key;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
};

describe.skipIf(!live)("pi adapter — LIVE in-process smoke (gemini)", () => {
  test("three turns with continuity and correction", { timeout: 900_000 }, async () => {
    const geminiKey = loadGeminiKey();
    expect(geminiKey).not.toBeNull();
    process.env.GEMINI_API_KEY = geminiKey as string;

    // Dynamic imports so a Pi package incompatibility fails THIS test only.
    const codingAgent = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      createAgentSession: (options: Record<string, unknown>) => Promise<{
        session: PiSessionSurface;
        modelFallbackMessage?: string;
      }>;
    };

    const agentDir = mkdtempSync(join(tmpdir(), "oa-pi-agent-"));
    // Pin the default model (owner direction: gemini-3.6-flash) through Pi's
    // own settings file in the isolated agent dir.
    const { writeFileSync: writeSettings } = await import("node:fs");
    writeSettings(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultModel: modelSpec.split("/").slice(1).join("/") }),
    );
    const workspaceDir = mkdtempSync(join(tmpdir(), "oa-pi-work-"));

    const factory = async (options: PiCreateSessionOptions): Promise<PiSessionSurface> => {
      const created = await codingAgent.createAgentSession({
        agentDir: options.agentDir,
        cwd: options.workspaceDir ?? workspaceDir,
        ...(options.activeTools === undefined ? {} : { tools: [...options.activeTools] }),
        ...(options.customTools === undefined ? {} : { customTools: [...options.customTools] }),
      });
      return created.session;
    };

    const adapter = makePiHarnessAdapter({
      createSession: factory,
      agentDir,
      workspaceDir,
    });
    const source: KhalaRuntimeSource = { lane: "ai_sdk_core", adapterKind: "openagents_native" };

    const result = await Effect.runPromise(
      runHarnessConversation({
        adapter,
        lane: "pi-local",
        model: modelSpec,
        source,
        sessionId: `convo-pi-${process.pid}`,
        userTurns: USER_TURNS,
      }),
    );

    const outDir = process.env.CONVO_OUT_DIR ?? mkdtempSync(join(tmpdir(), "oa-convo-"));
    const { writeFileSync } = await import("node:fs");
    const path = join(outDir, "convo-pi.jsonl");
    writeFileSync(
      path,
      `${result.transcriptLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    console.log(`transcript: ${path}`);
    for (const [index, turn] of result.turns.entries()) {
      console.log(
        `pi-local turn ${index + 1} [${turn.finishReason}]: ${turn.answer.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }
    expect(result.turns).toHaveLength(3);
    expect(result.turns[1].answer).toContain("42");
    expect(result.turns[2].answer).toContain("51");
  });
});
