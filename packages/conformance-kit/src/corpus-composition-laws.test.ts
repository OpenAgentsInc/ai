import { buildInMemoryCompositeProjection, makeCompositeCorpusHandle } from "@openagentsinc/rlm";

import { runCorpusCompositionLaws } from "./corpus-composition-laws.ts";

runCorpusCompositionLaws({
  label: "reference",
  compose: makeCompositeCorpusHandle,
  makeProjection: buildInMemoryCompositeProjection,
});
