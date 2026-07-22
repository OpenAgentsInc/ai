import { makeCompositeCorpusHandle } from "@openagentsinc/rlm";

import { runCorpusCompositionLaws } from "./corpus-composition-laws.ts";

runCorpusCompositionLaws({ label: "reference", compose: makeCompositeCorpusHandle });
