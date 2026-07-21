import { describe, expect, test } from "vite-plus/test";
import { compareSemver, decidePackage, diffPackageSurface, semverGt } from "./surface-diff.mjs";

/** Build a one-entrypoint package surface from a { name: [kind, sig] } map. */
const surface = (version: string, exports: Record<string, [string, string]>) => ({
  version,
  entrypoints: {
    ".": {
      source: "./src/index.ts",
      exports: Object.fromEntries(
        Object.entries(exports).map(([name, [kind, sig]]) => [name, { kind, sig }]),
      ),
    },
  },
});

const base = surface("0.2.0-rc.1", {
  Alpha: ["function", "aaa"],
  Beta: ["interface", "bbb"],
});

describe("compareSemver / semverGt", () => {
  test("orders release triples", () => {
    expect(compareSemver("0.3.0", "0.2.9")).toBe(1);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
    expect(compareSemver("0.2.0", "0.3.0")).toBe(-1);
  });

  test("a release outranks its own pre-releases", () => {
    expect(semverGt("0.2.0", "0.2.0-rc.9")).toBe(true);
    expect(semverGt("0.2.0-rc.1", "0.2.0")).toBe(false);
  });

  test("orders numeric pre-release counters", () => {
    expect(semverGt("0.2.0-rc.2", "0.2.0-rc.1")).toBe(true);
    expect(semverGt("0.2.0-rc.1", "0.2.0-rc.2")).toBe(false);
  });
});

describe("diffPackageSurface", () => {
  test("identical surfaces produce no diff", () => {
    const d = diffPackageSurface(base, base);
    expect(d.hasBreaking).toBe(false);
    expect(d.added).toEqual([]);
  });

  test("a new export name is additive, not breaking", () => {
    const next = surface("0.2.0-rc.1", {
      Alpha: ["function", "aaa"],
      Beta: ["interface", "bbb"],
      Gamma: ["function", "ggg"],
    });
    const d = diffPackageSurface(base, next);
    expect(d.hasBreaking).toBe(false);
    expect(d.added).toEqual([".:Gamma"]);
  });

  test("a removed export name is breaking", () => {
    const next = surface("0.2.0-rc.1", { Alpha: ["function", "aaa"] });
    const d = diffPackageSurface(base, next);
    expect(d.removed).toEqual([".:Beta"]);
    expect(d.hasBreaking).toBe(true);
  });

  test("a changed signature is breaking", () => {
    const next = surface("0.2.0-rc.1", {
      Alpha: ["function", "AAA-narrowed"],
      Beta: ["interface", "bbb"],
    });
    const d = diffPackageSurface(base, next);
    expect(d.changed).toEqual([".:Alpha"]);
    expect(d.hasBreaking).toBe(true);
  });

  test("a removed entry point counts every name as removed", () => {
    const multi = {
      version: "0.2.0-rc.1",
      entrypoints: {
        ".": { source: "./src/index.ts", exports: { Alpha: { kind: "function", sig: "aaa" } } },
        "./extra": {
          source: "./src/extra.ts",
          exports: { Extra: { kind: "function", sig: "eee" } },
        },
      },
    };
    const dropped = {
      version: "0.2.0-rc.1",
      entrypoints: {
        ".": { source: "./src/index.ts", exports: { Alpha: { kind: "function", sig: "aaa" } } },
      },
    };
    const d = diffPackageSurface(multi, dropped);
    expect(d.removed).toEqual(["./extra:Extra"]);
    expect(d.hasBreaking).toBe(true);
  });
});

describe("decidePackage gate", () => {
  test("additive change passes at the same version", () => {
    const next = surface("0.2.0-rc.1", {
      Alpha: ["function", "aaa"],
      Beta: ["interface", "bbb"],
      Gamma: ["function", "ggg"],
    });
    const v = decidePackage({
      baseline: base,
      current: next,
      baselineVersion: base.version,
      currentVersion: next.version,
    });
    expect(v.status).toBe("ok");
  });

  test("removal WITHOUT a version bump fails", () => {
    const next = surface("0.2.0-rc.1", { Alpha: ["function", "aaa"] });
    const v = decidePackage({
      baseline: base,
      current: next,
      baselineVersion: base.version,
      currentVersion: next.version,
    });
    expect(v.status).toBe("fail");
    expect(v.diff.removed).toEqual([".:Beta"]);
  });

  test("removal WITH a version bump passes", () => {
    const next = surface("0.3.0", { Alpha: ["function", "aaa"] });
    const v = decidePackage({
      baseline: base,
      current: next,
      baselineVersion: base.version,
      currentVersion: next.version,
    });
    expect(v.status).toBe("ok-bumped");
    expect(v.diff.removed).toEqual([".:Beta"]);
  });

  test("a signature change without a bump fails; with a bump passes", () => {
    const narrowed = surface("0.2.0-rc.1", {
      Alpha: ["function", "AAA-narrowed"],
      Beta: ["interface", "bbb"],
    });
    expect(
      decidePackage({
        baseline: base,
        current: narrowed,
        baselineVersion: base.version,
        currentVersion: "0.2.0-rc.1",
      }).status,
    ).toBe("fail");
    expect(
      decidePackage({
        baseline: base,
        current: { ...narrowed, version: "0.2.0" },
        baselineVersion: base.version,
        currentVersion: "0.2.0",
      }).status,
    ).toBe("ok-bumped");
  });

  test("an rc-to-rc bump still authorizes a break", () => {
    const next = surface("0.2.0-rc.2", { Alpha: ["function", "aaa"] });
    const v = decidePackage({
      baseline: base,
      current: next,
      baselineVersion: base.version,
      currentVersion: next.version,
    });
    expect(v.status).toBe("ok-bumped");
  });
});
