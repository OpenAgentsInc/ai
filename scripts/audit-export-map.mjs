#!/usr/bin/env node
/**
 * Export-map audit: every package.json exports target must exist on disk.
 * Fails non-zero on missing targets.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
let failed = 0;
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

for (const name of packages) {
  const pkgRoot = join(packagesDir, name);
  const pkgJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const exports = pkg.exports;
  if (!exports || typeof exports !== "object") {
    console.error(`[export-audit] ${pkg.name ?? name}: missing exports map`);
    failed += 1;
    continue;
  }
  for (const [key, target] of Object.entries(exports)) {
    const pathTarget =
      typeof target === "string"
        ? target
        : target && typeof target === "object"
          ? (target.default ?? target.import ?? target.require)
          : null;
    if (typeof pathTarget !== "string") {
      console.error(`[export-audit] ${pkg.name} export ${key}: non-string target`);
      failed += 1;
      continue;
    }
    const abs = resolve(pkgRoot, pathTarget);
    if (!existsSync(abs)) {
      console.error(`[export-audit] ${pkg.name} export ${key} → ${pathTarget} MISSING`);
      failed += 1;
    } else {
      console.log(`[export-audit] ok ${pkg.name} ${key} → ${pathTarget}`);
    }
  }
}

if (failed > 0) {
  console.error(`[export-audit] FAILED: ${failed} broken export(s)`);
  process.exit(1);
}
console.log(`[export-audit] OK (${packages.length} packages)`);
