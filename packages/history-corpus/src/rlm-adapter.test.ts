import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { makeInlineCorpusHandle } from "@openagentsinc/rlm";

import type { HistoryCorpusBuildResult } from "./builder.ts";
import { historyCorpusCoverageNote } from "./corpus.ts";
import {
  HISTORY_EVENT_ADDRESS_SCHEMA_ID,
  HISTORY_NOTE_ADDRESS_SCHEMA_ID,
  historyCorpusToRlmInput,
} from "./rlm-adapter.ts";

const history: HistoryCorpusBuildResult = {
  manifest: {
    corpusRef: "history.thread-1",
    scope: { _tag: "Thread", threadId: "thread-1" },
    builtAt: "2026-07-21T00:00:00Z",
    entryCount: 2,
    byteLength: 20,
    coverage: {
      eventKindsIncluded: ["text.delta", "thread.note"],
      eventKindsExcluded: [],
      note: historyCorpusCoverageNote,
    },
    exclusions: {
      excludedByVisibility: 1,
      excludedByRedaction: 2,
      policy: {
        includeVisibilities: ["private"],
        includeRedactionClasses: ["private_ref"],
      },
    },
  },
  entries: [
    {
      scopeRef: "thread-1",
      turnId: "turn-1",
      sequence: 1,
      kind: "text.delta",
      text: "event text",
      observedAt: "2026-07-21T00:00:00Z",
      visibility: "private",
      redactionClass: "private_ref",
    },
    {
      scopeRef: "thread-1",
      turnId: "note-1",
      sequence: 0,
      kind: "thread.note",
      role: "user",
      text: "note text",
      observedAt: "2026-07-21T00:00:01Z",
      visibility: "private",
      redactionClass: "private_ref",
    },
  ],
};

describe("historyCorpusToRlmInput", () => {
  test("preserves event and snapshot source planes and exact addresses", async () => {
    const input = historyCorpusToRlmInput(history);
    expect(input.entries.map((entry) => entry.sourcePlane)).toEqual([
      "event_log",
      "thread_snapshot",
    ]);
    expect(input.entries[0]!.sourceAddress.addressSchemaId).toBe(HISTORY_EVENT_ADDRESS_SCHEMA_ID);
    expect(input.entries[1]!.sourceAddress.addressSchemaId).toBe(HISTORY_NOTE_ADDRESS_SCHEMA_ID);
    expect(input.manifest.coverage.exclusions).toEqual([
      { reason: "history_visibility_policy", count: 1 },
      { reason: "history_redaction_policy", count: 2 },
    ]);
    const handle = await Effect.runPromise(makeInlineCorpusHandle(input));
    const validated = await Effect.runPromise(
      handle.validateSourceAddress(input.entries[0]!.sourceAddress, "event_log"),
    );
    expect(validated.entryRef).toBe(input.entries[0]!.entryRef);
  });
});
