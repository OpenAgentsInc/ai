/**
 * @openagentsinc/conformance-kit — published law suites for the
 * `@openagentsinc/ai` contracts.
 *
 * Each law suite is a runner a consumer calls in their own test file,
 * parameterized over the implementation under test. Point one at your adapter,
 * store, reducer, recall source, or RLM engine and it either passes the kit or
 * it is not conformant. The kit's own tests run every suite against the in-repo
 * reference implementations, so the kit is proven to work.
 */
export { runAdapterLaws, type AdapterLawsConfig } from "./adapter-laws.ts";
export { runEventLogLaws, type EventLogLawsConfig } from "./event-log-laws.ts";
export { runReducerLaws, type ReducerLawsConfig } from "./reducer-laws.ts";
export { runRecallLaws, type RecallLawsConfig, type RecallSource } from "./recall-laws.ts";
export { runRlmCapLaws, type RlmCapLawsConfig } from "./rlm-cap-laws.ts";
export {
  assertContiguous,
  attempt,
  type Attempt,
  collect,
  scriptTurn,
  sequencesOf,
  TEST_SOURCE,
} from "./fixtures.ts";
