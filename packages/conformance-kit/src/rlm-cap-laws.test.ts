import { makeRlm, rlmInlineCorpusSourceLayer } from "@openagentsinc/rlm";

import { runRlmCapLaws } from "./rlm-cap-laws.ts";

// The kit run against the in-repo reference RLM engine proves the kit itself
// works.
runRlmCapLaws({
  label: "rlm-engine",
  makeEngine: makeRlm,
  corpusSourceLayer: rlmInlineCorpusSourceLayer,
});
