import {
  applyUiChunk,
  initialUiMessage,
  reduceUiMessageStream,
  UiMessageReducerError,
} from "@openagentsinc/agent-harness-contract";

import { runReducerLaws } from "./reducer-laws.ts";

// The kit run against the in-repo reference reducer proves the kit itself works.
runReducerLaws({
  label: "ui-message-reducer",
  initial: () => initialUiMessage(),
  applyChunk: applyUiChunk,
  isReducerError: (error) => error instanceof UiMessageReducerError,
  reduceStream: (stream) => reduceUiMessageStream(stream),
});
