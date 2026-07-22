import * as Graph from "@openagentsinc/graph-corpus";
import * as Archive from "@openagentsinc/graph-corpus/archive";
import * as Ranking from "@openagentsinc/graph-corpus/ranking";
import * as Dse from "@openagentsinc/dse";
import { runGraphIdentityLaws } from "@openagentsinc/conformance-kit/graph-identity";
import { runGraphCapabilityDeleteLaws } from "@openagentsinc/conformance-kit/graph-delete";
import { runDseExtractionLaws } from "@openagentsinc/conformance-kit/dse-extraction";
import { runGraphRlmLaws } from "@openagentsinc/conformance-kit/graph-rlm";
import { runGraphRankingLaws } from "@openagentsinc/conformance-kit/graph-ranking";
import { runGraphArchiveLaws } from "@openagentsinc/conformance-kit/graph-archive";

runGraphIdentityLaws({ label: "reference", ...Graph });
runGraphCapabilityDeleteLaws({ label: "reference", ...Graph });
runDseExtractionLaws({ label: "reference", ...Dse });
runGraphRlmLaws({ label: "reference", ...Graph });
runGraphRankingLaws({ label: "reference", ...Graph, ...Ranking });
runGraphArchiveLaws({ label: "reference", ...Graph, ...Archive });
