import { Effect, Ref } from "effect";
import { sha256Hex, canonicalJson } from "../corpus/digest.ts";
import type { RlmDigest, RlmValueRef } from "../schemas/primitives.ts";
import { RlmError } from "../schemas/errors.ts";
import type { RlmBudget } from "../schemas/budget.ts";
import type { RlmCitation } from "../schemas/corpus.ts";

export type RlmValueKind = "text" | "json" | "collection" | "findings";

export interface RlmStoredValue {
  readonly valueRef: RlmValueRef;
  readonly kind: RlmValueKind;
  readonly digest: RlmDigest;
  readonly encodedBytes: number;
  readonly itemCount?: number;
  readonly parentRefs: ReadonlyArray<RlmValueRef>;
  readonly producingNodeRef?: string;
  readonly citations: ReadonlyArray<RlmCitation>;
  readonly preview: string;
  /** Full payload kept out of model history. */
  readonly payload: unknown;
}

export interface RlmEnvironment {
  readonly publish: (input: {
    readonly valueRef: RlmValueRef;
    readonly kind: RlmValueKind;
    readonly payload: unknown;
    readonly parentRefs?: ReadonlyArray<RlmValueRef>;
    readonly producingNodeRef?: string;
    readonly citations?: ReadonlyArray<RlmCitation>;
    readonly preview?: string;
  }) => Effect.Effect<RlmStoredValue, RlmError>;
  readonly get: (valueRef: RlmValueRef) => Effect.Effect<RlmStoredValue, RlmError>;
  readonly list: () => Effect.Effect<ReadonlyArray<RlmStoredValue>>;
  readonly liveBytes: () => Effect.Effect<number>;
}

export const makeRlmEnvironment = (budget: RlmBudget): Effect.Effect<RlmEnvironment> =>
  Effect.gen(function* () {
    const store = yield* Ref.make(new Map<string, RlmStoredValue>());
    const bytesRef = yield* Ref.make(0);

    const publish: RlmEnvironment["publish"] = (input) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(store);
        if (map.has(input.valueRef)) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: `duplicate valueRef ${input.valueRef}`,
          });
        }
        if (map.size >= budget.maxValues) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: "maxValues exceeded",
          });
        }
        const encoded = canonicalJson(input.payload);
        const encodedBytes = encoded.length;
        if (encodedBytes > budget.maxValueBytes) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: "maxValueBytes exceeded",
          });
        }
        const live = yield* Ref.get(bytesRef);
        if (live + encodedBytes > budget.maxEnvironmentBytes) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: "maxEnvironmentBytes exceeded",
          });
        }
        const itemCount = Array.isArray(input.payload) ? input.payload.length : undefined;
        if (itemCount !== undefined && itemCount > budget.maxCollectionItems) {
          return yield* new RlmError({
            reason: "program_contract_violation",
            retryable: false,
            detailSafe: "maxCollectionItems exceeded",
          });
        }
        const value: RlmStoredValue = {
          valueRef: input.valueRef,
          kind: input.kind,
          digest: sha256Hex(encoded),
          encodedBytes,
          ...(itemCount !== undefined ? { itemCount } : {}),
          parentRefs: input.parentRefs ?? [],
          ...(input.producingNodeRef !== undefined
            ? { producingNodeRef: input.producingNodeRef }
            : {}),
          citations: input.citations ?? [],
          preview: (input.preview ?? encoded).slice(0, 256),
          payload: input.payload,
        };
        yield* Ref.update(store, (m) => new Map(m).set(input.valueRef, value));
        yield* Ref.update(bytesRef, (b) => b + encodedBytes);
        return value;
      });

    const get: RlmEnvironment["get"] = (valueRef) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(store);
        const v = map.get(valueRef);
        if (v === undefined) {
          return yield* new RlmError({
            reason: "value_unavailable",
            retryable: false,
            detailSafe: `unknown valueRef ${valueRef}`,
          });
        }
        return v;
      });

    return {
      publish,
      get,
      list: () => Ref.get(store).pipe(Effect.map((m) => [...m.values()])),
      liveBytes: () => Ref.get(bytesRef),
    } satisfies RlmEnvironment;
  });
