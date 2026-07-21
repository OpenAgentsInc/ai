import { Context, Effect, Layer } from "effect";
import type { RlmCorpusInput } from "../schemas/corpus.ts";
import { RlmCorpusError } from "../schemas/errors.ts";
import { makeInlineCorpusHandle, type RlmCorpusHandle } from "./handle.ts";

export interface RlmCorpusSourceShape {
  readonly resolve: (input: RlmCorpusInput) => Effect.Effect<RlmCorpusHandle, RlmCorpusError>;
}

export class RlmCorpusSource extends Context.Service<RlmCorpusSource, RlmCorpusSourceShape>()(
  "@openagentsinc/rlm/RlmCorpusSource",
) {}

/** Layer that only supports Inline corpora (hermetic tests). */
export const rlmInlineCorpusSourceLayer: Layer.Layer<RlmCorpusSource> = Layer.succeed(
  RlmCorpusSource,
  RlmCorpusSource.of({
    resolve: (input) =>
      input._tag === "Inline"
        ? makeInlineCorpusHandle(input)
        : Effect.fail(
            new RlmCorpusError({
              reason: "unavailable",
              detailSafe: "Source corpus resolution requires an application Layer",
            }),
          ),
  }),
);
