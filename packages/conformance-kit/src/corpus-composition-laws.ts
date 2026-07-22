import { Effect } from "effect";
import {
  buildInlineCorpusInput,
  makeInlineCorpusHandle,
  type MakeCompositeCorpusHandleInput,
  type RlmCorpusError,
  type RlmCorpusHandle,
} from "@openagentsinc/rlm";
import { describe, expect, test } from "vite-plus/test";

export interface CorpusCompositionLawsConfig {
  readonly label: string;
  readonly compose: (
    input: MakeCompositeCorpusHandleInput,
  ) => Effect.Effect<RlmCorpusHandle, RlmCorpusError>;
}

const policy = {
  includeVisibilities: ["public"] as const,
  includeRedactionClasses: ["none"] as const,
};

const childInput = (corpusRef: string, address: string) =>
  buildInlineCorpusInput({
    corpusRef,
    scopeRef: "scope.conformance",
    policy,
    entries: [
      {
        scopeRef: "scope.conformance",
        sourcePlane: "repository",
        sourceKind: "fixture",
        sourceAddress: { addressSchemaId: "conformance.address.v1", encodedAddress: address },
        text: `content ${address}`,
        visibility: "public",
        redactionClass: "none",
      },
    ],
  });

/** Published laws for an application-authorized RLM composite implementation. */
export const runCorpusCompositionLaws = (config: CorpusCompositionLawsConfig): void => {
  describe(`[${config.label}] RLM corpus composition`, () => {
    test("same ordered identities and policy produce the same identity", async () => {
      const first = await Effect.runPromise(makeInlineCorpusHandle(childInput("child.a", "a")));
      const second = await Effect.runPromise(makeInlineCorpusHandle(childInput("child.b", "b")));
      const input = {
        corpusRef: "composite",
        scopeRef: "scope.conformance",
        policy,
        children: [
          { expectedIdentity: first.identity, handle: first },
          { expectedIdentity: second.identity, handle: second },
        ],
      } satisfies MakeCompositeCorpusHandleInput;
      const left = await Effect.runPromise(config.compose(input));
      const right = await Effect.runPromise(config.compose(input));
      expect(left.identity).toEqual(right.identity);
    });

    test("semantic child reordering changes the composite content digest", async () => {
      const first = await Effect.runPromise(makeInlineCorpusHandle(childInput("child.a", "a")));
      const second = await Effect.runPromise(makeInlineCorpusHandle(childInput("child.b", "b")));
      const left = await Effect.runPromise(
        config.compose({
          corpusRef: "left",
          scopeRef: "scope.conformance",
          policy,
          children: [
            { expectedIdentity: first.identity, handle: first },
            { expectedIdentity: second.identity, handle: second },
          ],
        }),
      );
      const right = await Effect.runPromise(
        config.compose({
          corpusRef: "right",
          scopeRef: "scope.conformance",
          policy,
          children: [
            { expectedIdentity: second.identity, handle: second },
            { expectedIdentity: first.identity, handle: first },
          ],
        }),
      );
      expect(left.identity.contentDigest).not.toBe(right.identity.contentDigest);
    });

    test("a composite policy cannot widen a child policy", async () => {
      const child = await Effect.runPromise(makeInlineCorpusHandle(childInput("child.a", "a")));
      const error = await Effect.runPromise(
        config
          .compose({
            corpusRef: "composite",
            scopeRef: "scope.conformance",
            policy: {
              includeVisibilities: ["public", "private"],
              includeRedactionClasses: ["none"],
            },
            children: [{ expectedIdentity: child.identity, handle: child }],
          })
          .pipe(Effect.flip),
      );
      expect(error.reason).toBe("policy_widened");
    });
  });
};
