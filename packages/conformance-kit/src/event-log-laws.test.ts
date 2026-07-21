import { Effect } from "effect";
import { makeInMemoryEventLogStore } from "@openagentsinc/agent-harness-contract";

import { runEventLogLaws } from "./event-log-laws.ts";

// The kit run against the in-repo reference store proves the kit itself works.
runEventLogLaws({
  label: "in-memory-store",
  makeStore: () => Effect.sync(() => makeInMemoryEventLogStore()),
});
