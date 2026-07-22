import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { extractPackageSurface } from "./extract-surface.mjs";

const makePackage = (parent: string) => {
  const dir = join(parent, "surface-fixture");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
  );
  writeFileSync(
    join(dir, "src", "shared.ts"),
    "export interface Shared { readonly value: string }\n",
  );
  writeFileSync(
    join(dir, "src", "index.ts"),
    'export const make = (): import("./shared.js").Shared => ({ value: "ok" });\nexport const literal = "stable" as const;\n',
  );
  writeFileSync(
    join(dir, "src", "extra.ts"),
    'export const extra = (value: import("./shared.js").Shared): import("./shared.js").Shared => value;\n',
  );
  return dir;
};

const pkg = (withExtra: boolean) => ({
  name: "@fixture/surface",
  version: "1.0.0",
  exports: {
    ".": "./src/index.ts",
    ...(withExtra ? { "./extra": "./src/extra.ts" } : {}),
  },
});

describe("extractPackageSurface stability", () => {
  test("adding an entry point does not change an existing entry point", () => {
    const dir = makePackage(mkdtempSync(join(tmpdir(), "surface-root-set-")));
    const before = extractPackageSurface({ dir, pkg: pkg(false) });
    const after = extractPackageSurface({ dir, pkg: pkg(true) });
    expect(after.entrypoints["."]).toEqual(before.entrypoints["."]);
    expect(after.entrypoints["./extra"]).toBeDefined();
  });

  test("checkout location does not change signature hashes", () => {
    const left = makePackage(mkdtempSync(join(tmpdir(), "surface-left-")));
    const right = makePackage(mkdtempSync(join(tmpdir(), "surface-right-")));
    expect(extractPackageSurface({ dir: right, pkg: pkg(true) })).toEqual(
      extractPackageSurface({ dir: left, pkg: pkg(true) }),
    );
  });

  test("an unrelated test global augmentation does not change an entry point", () => {
    const dir = makePackage(mkdtempSync(join(tmpdir(), "surface-test-root-")));
    const before = extractPackageSurface({ dir, pkg: pkg(false) });
    writeFileSync(
      join(dir, "src", "unrelated.test.ts"),
      "declare global { interface String { conformanceOnly(): number } }\nexport {};\n",
    );
    expect(extractPackageSurface({ dir, pkg: pkg(false) })).toEqual(before);
  });

  test("fresh compiler programs do not leak generated symbol ids", () => {
    const dir = makePackage(mkdtempSync(join(tmpdir(), "surface-symbol-id-")));
    const first = extractPackageSurface({ dir, pkg: pkg(true) });
    const second = extractPackageSurface({ dir, pkg: pkg(true) });
    expect(second).toEqual(first);
  });
});
