import { Effect } from "effect";
import { makeReferenceAdapter } from "@openagentsinc/agent-harness-contract";

import { runAdapterLaws } from "./adapter-laws.ts";

// The kit run against the in-repo reference adapter proves the kit itself
// works — a lossless suspend/continue adapter that supports every verb.
runAdapterLaws({
  label: "reference-adapter",
  makeHarness: () => Effect.sync(() => makeReferenceAdapter({ scriptWords: ["a", "b", "c"] })),
});

// A lossy-continue variant exercises the honest-degradation branch of the
// suspend/continue law.
runAdapterLaws({
  label: "reference-adapter (lossy continue)",
  makeHarness: () =>
    Effect.sync(() =>
      makeReferenceAdapter({ scriptWords: ["a", "b", "c"], continueIsLossy: true }),
    ),
});

// A verb-refusing variant exercises the fail-closed capability branch: compact,
// detach, and suspend must each fail with a named CapabilityUnsupported error.
runAdapterLaws({
  label: "reference-adapter (refuses compact/detach/suspend)",
  makeHarness: () =>
    Effect.sync(() =>
      makeReferenceAdapter({
        scriptWords: ["a", "b", "c"],
        supportsCompact: false,
        supportsDetach: false,
        supportsSuspend: false,
      }),
    ),
});
