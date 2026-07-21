import { Effect } from "effect";
import type { RlmProgram, RlmProgramNode } from "../schemas/program.ts";
import type { RlmBudget } from "../schemas/budget.ts";
import { RlmError } from "../schemas/errors.ts";

export const validateProgram = (
  program: RlmProgram,
  budget: RlmBudget,
): Effect.Effect<void, RlmError> =>
  Effect.gen(function* () {
    if (program.nodes.length === 0) {
      return yield* new RlmError({
        reason: "program_contract_violation",
        retryable: false,
        detailSafe: "empty program",
      });
    }
    if (program.nodes.length > budget.maxProgramNodes) {
      return yield* new RlmError({
        reason: "program_contract_violation",
        retryable: false,
        detailSafe: "maxProgramNodes exceeded",
      });
    }
    if (program.nodes.length > budget.maxProgramNodesPerIteration) {
      return yield* new RlmError({
        reason: "program_contract_violation",
        retryable: false,
        detailSafe: "maxProgramNodesPerIteration exceeded",
      });
    }

    const nodeRefs = new Set<string>();
    const outputRefs = new Set<string>();
    const producers = new Map<string, string>(); // valueRef -> nodeRef

    for (const node of program.nodes) {
      if (nodeRefs.has(node.nodeRef)) {
        return yield* new RlmError({
          reason: "program_contract_violation",
          retryable: false,
          detailSafe: `duplicate nodeRef ${node.nodeRef}`,
        });
      }
      nodeRefs.add(node.nodeRef);

      const outs = outputValueRefs(node);
      for (const out of outs) {
        if (outputRefs.has(out)) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: `duplicate output valueRef ${out}`,
          });
        }
        outputRefs.add(out);
        producers.set(out, node.nodeRef);
      }
    }

    // Build edges valueRef dependency: consumer -> producer node
    const adj = new Map<string, Array<string>>(); // node -> nodes it depends on
    for (const node of program.nodes) {
      const deps: Array<string> = [];
      for (const ref of inputValueRefs(node)) {
        const prod = producers.get(ref);
        if (prod !== undefined && prod !== node.nodeRef) {
          deps.push(prod);
        }
      }
      adj.set(node.nodeRef, deps);
    }

    // Cycle detection (DFS)
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (n: string): boolean => {
      if (visiting.has(n)) return true;
      if (visited.has(n)) return false;
      visiting.add(n);
      for (const d of adj.get(n) ?? []) {
        if (visit(d)) return true;
      }
      visiting.delete(n);
      visited.add(n);
      return false;
    };
    for (const node of program.nodes) {
      if (visit(node.nodeRef)) {
        return yield* new RlmError({
          reason: "program_contract_violation",
          retryable: false,
          detailSafe: "program graph contains a cycle",
        });
      }
    }

    // Fan-out reservation check for map nodes
    for (const node of program.nodes) {
      if (node._tag === "ModelMap" || node._tag === "RlmMap" || node._tag === "Partition") {
        // partCount / collection size checked at runtime; graph-level maxFanOut is a hard ceiling
        if (node._tag === "Partition" && node.partCount > budget.maxFanOut) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: "partition fan-out exceeds maxFanOut",
          });
        }
      }
    }
  });

const outputValueRefs = (node: RlmProgramNode): ReadonlyArray<string> => {
  switch (node._tag) {
    case "Commit":
      return [];
    case "CorpusOp":
    case "Partition":
    case "Transform":
    case "ModelMap":
    case "RlmMap":
    case "ModelReduce":
      return [node.outputValueRef];
  }
};

const inputValueRefs = (node: RlmProgramNode): ReadonlyArray<string> => {
  switch (node._tag) {
    case "CorpusOp":
      return node.inputValueRefs;
    case "Partition":
      return [node.inputValueRef];
    case "Transform":
      return node.inputValueRefs;
    case "ModelMap":
    case "RlmMap":
    case "ModelReduce":
      return [node.inputCollectionRef];
    case "Commit":
      return [node.valueRef, ...node.citationValueRefs];
  }
};

/** Topological order for execution. */
export const topologicalNodes = (program: RlmProgram): ReadonlyArray<RlmProgramNode> => {
  const byRef = new Map(program.nodes.map((n) => [n.nodeRef, n] as const));
  const producers = new Map<string, string>();
  for (const node of program.nodes) {
    for (const out of outputValueRefs(node)) {
      producers.set(out, node.nodeRef);
    }
  }
  const indeg = new Map<string, number>();
  const children = new Map<string, Array<string>>();
  for (const node of program.nodes) {
    indeg.set(node.nodeRef, 0);
    children.set(node.nodeRef, []);
  }
  for (const node of program.nodes) {
    for (const ref of inputValueRefs(node)) {
      const prod = producers.get(ref);
      if (prod !== undefined && prod !== node.nodeRef) {
        children.get(prod)!.push(node.nodeRef);
        indeg.set(node.nodeRef, (indeg.get(node.nodeRef) ?? 0) + 1);
      }
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order: Array<RlmProgramNode> = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(byRef.get(n)!);
    for (const c of children.get(n) ?? []) {
      const next = (indeg.get(c) ?? 1) - 1;
      indeg.set(c, next);
      if (next === 0) queue.push(c);
    }
  }
  return order.length === program.nodes.length ? order : program.nodes;
};
