import { describe, expect, test } from "vite-plus/test";

import { bindProgram, type Program } from "./program.js";
import {
  honestChatReplySignature,
  type HonestChatReplyInput,
  type HonestChatReplyOutput,
} from "./signatures.js";
import { signatureId } from "./refs.js";
import { honestProgram, honestDataset } from "../test-support.js";
import { makeCandidateArtifact } from "./artifact.js";
import { makeSearchPlan } from "./budget.js";

const artifact = () =>
  makeCandidateArtifact({
    signatureId: honestChatReplySignature.signatureId,
    datasetRevisionId: honestDataset().revisionId,
    searchPlan: makeSearchPlan({ algorithm: "instruction_grid.v1" }),
    program: honestProgram("HONESTY_STRICT"),
    producedAt: "2026-07-20T00:00:00.000Z",
  });

describe("canonical DSE Program contract", () => {
  test("binds one signature to one immutable candidate artifact", () => {
    const result = bindProgram({ signature: honestChatReplySignature, artifact: artifact() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const program: Program<HonestChatReplyInput, HonestChatReplyOutput> = result.program;
      expect(program.artifact.signatureId).toBe(program.signature.signatureId);
    }
  });

  test("fails closed when the artifact and signature identities differ", () => {
    const candidate = artifact();
    const result = bindProgram({
      signature: {
        ...honestChatReplySignature,
        signatureId: signatureId("Other/Signature.v1"),
      },
      artifact: candidate,
    });

    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("fails closed when covered artifact bytes change", () => {
    const candidate = artifact();
    const result = bindProgram({
      signature: honestChatReplySignature,
      artifact: {
        ...candidate,
        program: { ...candidate.program, modelRole: "changed-after-digest" },
      },
    });

    expect(result).toEqual({ ok: false, reason: "artifact_digest_mismatch" });
  });
});
