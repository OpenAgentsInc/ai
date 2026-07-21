import { Schema as S } from "effect";
import { RlmBoundedText, RlmNodeRef, RlmPositiveCount, RlmRef, RlmValueRef } from "./primitives.ts";

export const RLM_PROGRAM_SCHEMA_ID = "openagents.ai.rlm_program.v1" as const;

/** Registered pure deterministic corpus/value operator name. */
export const RlmOperatorName = S.Literals([
  "Grep",
  "OrdinalSlice",
  "InspectMetadata",
  "PartitionEqualSize",
  "TransformIdentity",
  "TransformJoinText",
]);
export type RlmOperatorName = typeof RlmOperatorName.Type;

export const RlmCorpusOpNode = S.TaggedStruct("CorpusOp", {
  nodeRef: RlmNodeRef,
  operator: RlmOperatorName,
  params: S.Record(S.String, S.Unknown),
  inputCorpus: S.optionalKey(S.Boolean),
  inputValueRefs: S.Array(RlmValueRef),
  outputValueRef: RlmValueRef,
});
export type RlmCorpusOpNode = typeof RlmCorpusOpNode.Type;

export const RlmPartitionNode = S.TaggedStruct("Partition", {
  nodeRef: RlmNodeRef,
  inputValueRef: RlmValueRef,
  partCount: RlmPositiveCount,
  outputValueRef: RlmValueRef,
});
export type RlmPartitionNode = typeof RlmPartitionNode.Type;

export const RlmTransformNode = S.TaggedStruct("Transform", {
  nodeRef: RlmNodeRef,
  operator: RlmOperatorName,
  params: S.Record(S.String, S.Unknown),
  inputValueRefs: S.Array(RlmValueRef),
  outputValueRef: RlmValueRef,
});
export type RlmTransformNode = typeof RlmTransformNode.Type;

export const RlmModelMapNode = S.TaggedStruct("ModelMap", {
  nodeRef: RlmNodeRef,
  inputCollectionRef: RlmValueRef,
  promptTemplate: RlmBoundedText,
  outputValueRef: RlmValueRef,
  maxConcurrency: S.optionalKey(RlmPositiveCount),
});
export type RlmModelMapNode = typeof RlmModelMapNode.Type;

export const RlmMapNode = S.TaggedStruct("RlmMap", {
  nodeRef: RlmNodeRef,
  inputCollectionRef: RlmValueRef,
  questionTemplate: RlmBoundedText,
  outputValueRef: RlmValueRef,
  maxConcurrency: S.optionalKey(RlmPositiveCount),
});
export type RlmMapNode = typeof RlmMapNode.Type;

export const RlmModelReduceNode = S.TaggedStruct("ModelReduce", {
  nodeRef: RlmNodeRef,
  inputCollectionRef: RlmValueRef,
  reducePrompt: RlmBoundedText,
  outputValueRef: RlmValueRef,
});
export type RlmModelReduceNode = typeof RlmModelReduceNode.Type;

export const RlmCommitNode = S.TaggedStruct("Commit", {
  nodeRef: RlmNodeRef,
  valueRef: RlmValueRef,
  citationValueRefs: S.Array(RlmValueRef),
});
export type RlmCommitNode = typeof RlmCommitNode.Type;

export const RlmProgramNode = S.Union([
  RlmCorpusOpNode,
  RlmPartitionNode,
  RlmTransformNode,
  RlmModelMapNode,
  RlmMapNode,
  RlmModelReduceNode,
  RlmCommitNode,
]);
export type RlmProgramNode = typeof RlmProgramNode.Type;

export const RlmProgram = S.Struct({
  schemaId: S.Literal(RLM_PROGRAM_SCHEMA_ID),
  programRef: RlmRef,
  nodes: S.Array(RlmProgramNode),
});
export type RlmProgram = typeof RlmProgram.Type;
