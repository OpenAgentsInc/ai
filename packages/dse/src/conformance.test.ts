import { describe, expect, test } from "vite-plus/test";

import * as Root from "./index.js";
import * as Runtime from "./runtime/index.js";
import * as Optimizer from "./optimizer/index.js";

describe("DSE subpath authority", () => {
  test("keeps compile and promotion off the root and runtime surfaces", () => {
    expect("compileSignature" in Root).toBe(false);
    expect("generateCandidates" in Root).toBe(false);
    expect("promote" in Root).toBe(false);
    expect("compileSignature" in Runtime).toBe(false);
    expect("promote" in Runtime).toBe(false);
  });

  test("exposes compile and promotion only from the optimizer", () => {
    expect(typeof Optimizer.compileSignature).toBe("function");
    expect(typeof Optimizer.generateCandidates).toBe("function");
    expect(typeof Optimizer.promote).toBe("function");
  });
});
