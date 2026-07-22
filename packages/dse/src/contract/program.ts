import { candidateArtifactDigest, type CandidateArtifact } from "./artifact.js";
import type { DseSignature } from "./signature.js";

/**
 * The canonical model-program boundary.
 *
 * A Program is one typed DSE signature bound to one immutable, content-addressed
 * candidate artifact. It is not an optimizer session and it is not the
 * run-scoped `RlmProgram` query plan.
 */
export interface DseProgram<I, O> {
  readonly signature: DseSignature<I, O>;
  readonly artifact: CandidateArtifact;
}

/** The public short name for the canonical DSE model-program contract. */
export type Program<I, O> = DseProgram<I, O>;

export type BindProgramResult<I, O> =
  | { readonly ok: true; readonly program: DseProgram<I, O> }
  | {
      readonly ok: false;
      readonly reason:
        | "signature_mismatch"
        | "compiled_program_mismatch"
        | "artifact_digest_mismatch";
    };

/** Bind a signature to exact artifact bytes and fail closed on identity drift. */
export const bindProgram = <I, O>(args: {
  readonly signature: DseSignature<I, O>;
  readonly artifact: CandidateArtifact;
}): BindProgramResult<I, O> => {
  if (args.artifact.signatureId !== args.signature.signatureId) {
    return { ok: false, reason: "signature_mismatch" };
  }
  if (args.artifact.program.signatureId !== args.signature.signatureId) {
    return { ok: false, reason: "compiled_program_mismatch" };
  }
  if (candidateArtifactDigest(args.artifact) !== args.artifact.digest) {
    return { ok: false, reason: "artifact_digest_mismatch" };
  }
  return { ok: true, program: args };
};
