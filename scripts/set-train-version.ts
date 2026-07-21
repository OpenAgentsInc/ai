#!/usr/bin/env node
/**
 * set-train-version — converge the whole publishable roster to one train.
 *
 * Version convergence policy (P1-3, #17): the roster ships as ONE train — every
 * publishable package.json carries the same `version`, and every inter-package
 * dependency inside the workspace points at that one train through the
 * `workspace:*` protocol (rewritten to the concrete version at pack time).
 *
 * Usage:
 *   node scripts/set-train-version.ts <version>       # apply
 *   node scripts/set-train-version.ts <version> --check # verify convergence, no writes
 *
 * The script:
 *   1. sets `version` on every non-private package under packages/.
 *   2. converges any straggler inter-package range (a @openagentsinc/* dep that
 *      pins a concrete version instead of `workspace:*`) back to `workspace:*`.
 *
 * Pre-stable trains publish under dist-tag `rc` only, never `latest`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const packagesDir = join(repoRoot, "packages");

const args = process.argv.slice(2);
const check = args.includes("--check");
const version = args.find((a) => !a.startsWith("--"));

if (!version) {
  console.error("usage: node scripts/set-train-version.ts <version> [--check]");
  process.exit(2);
}

type Pkg = {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const depFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const roster: { name: string; file: string }[] = [];
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(packagesDir, entry.name, "package.json");
  let pkg: Pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private || !pkg.name) continue;
  roster.push({ name: pkg.name, file });
}

const rosterNames = new Set(roster.map((r) => r.name));
const drift: string[] = [];

for (const { file } of roster) {
  const raw = readFileSync(file, "utf8");
  const pkg: Pkg = JSON.parse(raw);
  let changed = false;

  if (pkg.version !== version) {
    if (check) drift.push(`${pkg.name}: version ${pkg.version} != ${version}`);
    pkg.version = version;
    changed = true;
  }

  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (!rosterNames.has(dep)) continue;
      if (deps[dep] !== "workspace:*") {
        if (check) drift.push(`${pkg.name}: ${field}.${dep} = ${deps[dep]} != workspace:*`);
        deps[dep] = "workspace:*";
        changed = true;
      }
    }
  }

  if (changed && !check) {
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[set-train-version] ${pkg.name} -> ${version}`);
  }
}

if (check) {
  if (drift.length > 0) {
    console.error(`[set-train-version] roster not converged to ${version}:`);
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(`[set-train-version] roster converged to ${version} (${roster.length} packages)`);
} else {
  console.log(`[set-train-version] roster set to ${version} (${roster.length} packages)`);
}
