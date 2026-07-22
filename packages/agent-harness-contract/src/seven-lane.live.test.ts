/**
 * LIVE seven-lane orchestrated conversation — every supported harness doing
 * real work in ONE conversation on ONE shared workspace, through the
 * production adapters, owner-local. Gated:
 *
 *   SEVEN_LIVE_SMOKE=1 pnpm --dir packages/agent-harness-contract exec \
 *     vitest run src/seven-lane.live.test.ts
 *
 * Scenario (three user turns, representative of real coding sessions):
 *   1. Build a small TS utility — Codex implements, OpenCode writes+runs
 *      tests, Pi writes usage docs (parallel delegation, real files).
 *   2. A correction: diacritics must transliterate, not strip — Claude
 *      reviews and fixes Codex's file, Cursor critiques the API.
 *   3. Grok writes a changelog entry; Goose gives a QA verdict on the
 *      whole workspace; the orchestrator synthesizes.
 *
 * Output: one combined gradable transcript (CONVO_OUT_DIR/seven-lane.jsonl)
 * with user/assistant messages, agent.child lifecycle + handoffs, and every
 * lane's KhalaRuntimeEvents with lane + model attribution.
 */

import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { KhalaRuntimeSource } from "@openagentsinc/agent-runtime-schema";
import { makeAcpHarnessAdapter } from "./acp-adapter.ts";
import type { AgentHarness } from "./adapter.ts";
import type { ClaudeCodeQuery } from "./claude-code-adapter.ts";
import { makeClaudeCodeHarnessAdapter } from "./claude-code-adapter.ts";
import { makeCodexHarnessAdapter } from "./codex-adapter.ts";
import type { HarnessSession } from "./session.ts";
import { makeLiveCodexExecSpawner } from "./codex-exec-live-spawner.ts";
import { makeCursorHarnessAdapter } from "./cursor-adapter.ts";
import { makeLiveCursorAcpTransport } from "./cursor-acp-live-transport.ts";
import { makeLiveGrokAcpTransport } from "./grok-acp-live-transport.ts";
import { makeLiveGooseAcpTransport } from "./goose-acp-live-transport.ts";
import { makeOpencodeAdapter } from "./opencode-adapter.ts";
import { makeLiveOpencodeTransport } from "./opencode-live-transport.ts";
import type { PiCreateSessionOptions, PiSessionSurface } from "./pi-adapter.ts";
import { makePiHarnessAdapter } from "./pi-adapter.ts";

const live = process.env.SEVEN_LIVE_SMOKE === "1";
const outDir = process.env.CONVO_OUT_DIR ?? mkdtempSync(join(tmpdir(), "oa-seven-"));

interface Line {
  readonly type: string;
  readonly [key: string]: unknown;
}

const find = (paths: readonly string[]): string | undefined =>
  paths.find((path) => existsSync(path));

const home = homedir();
const codexBinary = find([
  join(home, ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
]);
const grokBinary = find([join(home, ".grok", "bin", "grok")]);
const cursorBinary = find([join(home, ".local", "bin", "cursor-agent")]);
const gooseBinary = find([
  join(home, "Downloads", "Goose.app", "Contents", "Resources", "bin", "goose"),
  "/Applications/Goose.app/Contents/Resources/bin/goose",
]);
const opencodeBinary = find([join(home, ".opencode", "bin", "opencode")]);

const geminiKey = (() => {
  try {
    const auth = JSON.parse(
      readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8"),
    ) as Record<string, { key?: string }>;
    return auth.google?.key ?? "";
  } catch {
    return "";
  }
})();

const processEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

describe.skipIf(!live)("seven-lane LIVE orchestrated conversation", () => {
  test("real mini-project across all seven harnesses", { timeout: 2_400_000 }, async () => {
    expect(codexBinary && grokBinary && cursorBinary && gooseBinary && opencodeBinary).toBeTruthy();
    expect(geminiKey).not.toBe("");
    process.env.GEMINI_API_KEY = geminiKey;

    const workdir = mkdtempSync(join(tmpdir(), "oa-seven-work-"));
    const lines: Line[] = [];
    const push = (line: Line): void => {
      lines.push(line);
    };

    // ---- lane sessions (one per harness, all sharing the workdir) --------
    const sources: Record<string, KhalaRuntimeSource> = {
      codex: { lane: "codex_app_server", adapterKind: "codex" },
      claude: { lane: "claude_pylon", adapterKind: "claude_code" },
      opencode: { lane: "agent_client_protocol", adapterKind: "opencode" },
      grok: { lane: "agent_client_protocol", adapterKind: "grok_cli" },
      cursor: { lane: "agent_client_protocol", adapterKind: "cursor_cli" },
      pi: { lane: "ai_sdk_core", adapterKind: "openagents_native" },
      goose: { lane: "agent_client_protocol", adapterKind: "agent_client_protocol" },
    };
    const models: Record<string, string> = {
      codex: "gpt-5.6-terra",
      claude: "claude-haiku-4-5-20251001",
      opencode: "opencode/claude-haiku-4-5",
      grok: "grok-default",
      cursor: "cursor-default",
      pi: "google/gemini-3.6-flash",
      goose: "gemini-3.6-flash",
    };

    const grokTransport = await Effect.runPromise(
      makeLiveGrokAcpTransport({ binaryPath: grokBinary as string, cwd: workdir }),
    );
    const cursorTransport = await Effect.runPromise(
      makeLiveCursorAcpTransport({ binaryPath: cursorBinary as string, cwd: workdir }),
    );
    const gooseTransport = await Effect.runPromise(
      makeLiveGooseAcpTransport({
        binaryPath: gooseBinary as string,
        cwd: workdir,
        env: {
          GOOSE_PROVIDER: "google",
          GOOSE_MODEL: "gemini-3.6-flash",
          GOOGLE_API_KEY: geminiKey,
        },
      }),
    );
    const opencodeTransport = await Effect.runPromise(
      makeLiveOpencodeTransport({ binaryPath: opencodeBinary as string, directory: workdir }),
    );

    const piAgentDir = mkdtempSync(join(tmpdir(), "oa-seven-pi-"));
    writeFileSync(
      join(piAgentDir, "settings.json"),
      JSON.stringify({ defaultModel: "gemini-3.6-flash" }),
    );
    const codingAgent = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      createAgentSession: (
        options: Record<string, unknown>,
      ) => Promise<{ session: PiSessionSurface }>;
    };
    const piFactory = async (options: PiCreateSessionOptions): Promise<PiSessionSurface> =>
      (
        await codingAgent.createAgentSession({
          agentDir: options.agentDir,
          cwd: options.workspaceDir ?? workdir,
        })
      ).session;

    const adapters: Record<string, AgentHarness> = {
      codex: makeCodexHarnessAdapter({
        mode: "exec",
        codexBinaryPath: codexBinary as string,
        workingDirectory: workdir,
        model: models.codex,
        spawner: makeLiveCodexExecSpawner({
          reasoningEffort: "medium",
          sandbox: "workspace-write",
          timeoutMs: 480_000,
        }),
      }),
      claude: makeClaudeCodeHarnessAdapter({
        query: query as unknown as ClaudeCodeQuery,
        env: processEnv,
        cwd: workdir,
        model: models.claude,
      }),
      opencode: makeOpencodeAdapter({
        transport: opencodeTransport,
        model: models.opencode,
        directory: workdir,
      }),
      grok: makeAcpHarnessAdapter({
        harnessId: "grok",
        harnessKind: "grok_cli",
        transport: grokTransport,
      }),
      cursor: makeCursorHarnessAdapter({
        cursorAgentPath: cursorBinary as string,
        transport: cursorTransport,
      }),
      pi: makePiHarnessAdapter({
        createSession: piFactory,
        agentDir: piAgentDir,
        workspaceDir: workdir,
      }),
      goose: makeAcpHarnessAdapter({
        harnessId: "goose",
        harnessKind: "custom",
        transport: gooseTransport,
      }),
    };

    const sessions = new Map<string, HarnessSession>();
    const laneTurn = (lane: string, prompt: string): Promise<string> =>
      Effect.runPromise(
        Effect.gen(function* () {
          let session = sessions.get(lane);
          if (session === undefined) {
            session = yield* adapters[lane].start({
              sessionId: `seven-${lane}`,
              source: sources[lane],
              ...(lane === "claude" ? { permissionMode: "allow-all" as const } : {}),
            });
            sessions.set(lane, session);
          }
          push({ type: "agent.child.started", lane: `${lane}-local`, model: models[lane] });
          const control = yield* session.promptTurn({ turnId: `t-${lines.length}`, prompt });
          let answer = "";
          yield* Stream.runForEach(control.events, (event) =>
            Effect.sync(() => {
              push({ type: "khala", lane: `${lane}-local`, model: models[lane], event });
              const payload = event as { kind: string; text?: string };
              if (payload.kind === "text.delta" && typeof payload.text === "string")
                answer += payload.text;
              if (payload.kind === "text.completed" && typeof payload.text === "string")
                answer = payload.text;
            }),
          );
          const result = yield* control.done;
          push({
            type: "agent.child.finished",
            lane: `${lane}-local`,
            model: models[lane],
            finishReason: result.finishReason,
          });
          return answer;
        }) as Effect.Effect<string, unknown>,
      );

    const say = (text: string): void => push({ type: "user_message", text });
    const answer = (text: string): void => push({ type: "assistant_message", text });
    const handoff = (from: string, to: string, note: string): void =>
      push({
        type: "agent.child.interacted",
        lane: `${to}-local`,
        fromLane: `${from}-local`,
        note,
      });

    // ================= TURN 1 =================
    say(
      "I need a tiny TypeScript utility in this workspace: slugify.ts exporting slugify(title: string): string " +
        "(lowercase, words joined by '-', unicode handled, no leading/trailing dashes). Delegate it: " +
        "Codex implements slugify.ts, OpenCode writes slugify.test.ts with vitest-style asserts and runs a quick node check, " +
        "Pi writes USAGE.md with three realistic examples. Work in parallel, then report.",
    );
    const [impl, tests, docs] = await Promise.all([
      laneTurn(
        "codex",
        "Create slugify.ts in this workspace exporting slugify(title: string): string — lowercase, words joined by '-', " +
          "strip punctuation, collapse repeated dashes, no leading/trailing dashes. Handle unicode. Reply with a 2-line summary of your approach.",
      ),
      laneTurn(
        "opencode",
        "A colleague is writing slugify.ts (slugify(title: string): string, kebab-case, unicode-aware) in this workspace. " +
          "Write slugify.test.ts with 6 plain-node assert cases covering spaces, punctuation, repeated dashes, and unicode. " +
          "If slugify.ts exists already, run `node --experimental-strip-types slugify.test.ts` and report; otherwise just write the file and say so.",
      ),
      laneTurn(
        "pi",
        "Write USAGE.md in this workspace documenting a slugify(title) TypeScript utility (kebab-case, unicode-aware): " +
          "one paragraph, then three realistic before/after examples (blog title, product name, unicode title). Reply with a 1-line confirmation.",
      ),
    ]);
    answer(
      `Delegated in parallel. Codex (implementation): ${impl}\n\nOpenCode (tests): ${tests}\n\nPi (docs): ${docs}`,
    );

    // ================= TURN 2 (correction) =================
    say(
      "No — the unicode handling is wrong for my use case. I don't want diacritics stripped, I want them transliterated " +
        "(é→e, ü→u, ñ→n). Have Claude review and fix slugify.ts accordingly and re-run the tests, and have Cursor critique the public API surface.",
    );
    handoff("codex", "claude", "correction: transliterate diacritics instead of stripping");
    const [fix, critique] = await Promise.all([
      laneTurn(
        "claude",
        "Review slugify.ts in this workspace. Requirement change: diacritics must TRANSLITERATE (é→e, ü→u, ñ→n), never be stripped. " +
          "Fix the implementation (normalize('NFD') + combining-mark removal is acceptable), update slugify.test.ts with a transliteration case, " +
          "run `node --experimental-strip-types slugify.test.ts`, and report pass/fail plus what you changed in 3 lines.",
      ),
      laneTurn(
        "cursor",
        "Critique the public API of slugify.ts in this workspace in 4 bullet points max: naming, options it should probably grow " +
          "(separator? maxLength?), edge-case behavior worth documenting, and whether the signature should stay a single pure function.",
      ),
    ]);
    answer(`Claude (fix + tests): ${fix}\n\nCursor (API critique): ${critique}`);

    // ================= TURN 3 (wrap) =================
    say(
      "Good. Have Grok write a CHANGELOG.md entry for v0.1.0 summarizing what was built and the transliteration fix, " +
        "and have Goose do a final QA pass over the workspace files and give a ship/no-ship verdict. Then summarize the whole task.",
    );
    handoff("claude", "grok", "changelog input: implementation + transliteration fix");
    handoff("claude", "goose", "QA handoff: verify workspace files and test result");
    const [changelog, verdict] = await Promise.all([
      laneTurn(
        "grok",
        "Write CHANGELOG.md in this workspace: a v0.1.0 entry for a new slugify utility — initial kebab-case implementation, " +
          "vitest-style tests, usage docs, and a fix changing diacritic handling from strip to transliterate. Reply with the entry text.",
      ),
      laneTurn(
        "goose",
        "QA pass on this workspace: list the files present, run `node --experimental-strip-types slugify.test.ts` if both slugify files exist, " +
          "and give a one-line ship/no-ship verdict with the reason.",
      ),
    ]);
    answer(
      `Grok (changelog): ${changelog}\n\nGoose (QA verdict): ${verdict}\n\n` +
        "Summary: slugify.ts implemented (Codex), tested (OpenCode), documented (Pi), corrected to transliterate diacritics " +
        "(Claude), API-reviewed (Cursor), changelogged (Grok), and QA-verified (Goose) — one workspace, seven agents.",
    );

    await Effect.runPromise(grokTransport.shutdown());
    await Effect.runPromise(cursorTransport.shutdown());
    await Effect.runPromise(gooseTransport.shutdown());
    await Effect.runPromise(opencodeTransport.shutdown());

    const path = join(outDir, "seven-lane.jsonl");
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    console.log(`transcript: ${path}`);
    console.log(`workdir: ${workdir}`);
    for (const [lane, text] of [
      ["codex", impl],
      ["opencode", tests],
      ["pi", docs],
      ["claude", fix],
      ["cursor", critique],
      ["grok", changelog],
      ["goose", verdict],
    ] as const) {
      console.log(`${lane}: ${String(text).replace(/\s+/g, " ").slice(0, 140)}`);
    }
    expect(impl.length).toBeGreaterThan(0);
    expect(fix.length).toBeGreaterThan(0);
    expect(verdict.length).toBeGreaterThan(0);
    expect(existsSync(join(workdir, "slugify.ts"))).toBe(true);
  });
});
