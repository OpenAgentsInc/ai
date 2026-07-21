import { recallTierD } from "@openagentsinc/history-corpus";

import { runRecallLaws } from "./recall-laws.ts";

// The kit run against the in-repo reference recall backend (Tier D) proves the
// kit itself works.
runRecallLaws({
  label: "recall-tier-d",
  recall: (params) => recallTierD(params),
});
