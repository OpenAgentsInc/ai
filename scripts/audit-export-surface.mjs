#!/usr/bin/env node
/**
 * API-surface audit — the per-train breaking-change gate (P1-2, #16).
 *
 * Modes:
 *   (default)   check the current roster surface against the latest committed
 *               baseline snapshot and the package versions. Exits non-zero on
 *               an un-versioned breaking change (a removed/renamed export or a
 *               changed signature with no version bump).
 *   --update    (re)generate the committed snapshot for the current train at
 *               docs/api-surface/<train>.json.
 *
 * Baseline snapshots live in docs/api-surface/. The baseline used for a check
 * is the highest-semver snapshot file present. On an intentional break: bump
 * the roster version, then run `pnpm run audit:surface:update` to record the
 * new train's surface as the next baseline.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { compareSemver, decidePackage } from "./lib/surface-diff.mjs";
import {
  deriveTrain,
  extractWorkspaceSurface,
  readRoster,
  repoRoot,
} from "./lib/extract-surface.mjs";

const surfaceDir = join(repoRoot, "docs", "api-surface");
const mode = process.argv.includes("--update") ? "update" : "check";

function listSnapshots() {
  if (!existsSync(surfaceDir)) return [];
  return readdirSync(surfaceDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: join(surfaceDir, f), train: basename(f, ".json") }))
    .sort((a, b) => compareSemver(a.train, b.train));
}

function loadSnapshot(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function buildSnapshot() {
  const roster = readRoster();
  return {
    train: deriveTrain(roster),
    tool: "scripts/audit-export-surface.mjs",
    extractorSchema: "openagents.ai.public_export_surface.v2",
    note: "V2 measures each entry point independently and normalizes compiler paths. Regenerate with `pnpm run audit:surface:update`.",
    packages: extractWorkspaceSurface(roster),
  };
}

function writeSnapshot(snapshot) {
  mkdirSync(surfaceDir, { recursive: true });
  const file = join(surfaceDir, `${snapshot.train}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

if (mode === "update") {
  const snapshot = buildSnapshot();
  const file = writeSnapshot(snapshot);
  const pkgCount = Object.keys(snapshot.packages).length;
  console.log(
    `[surface-audit] wrote ${basename(file)} for train ${snapshot.train} (${pkgCount} packages)`,
  );
  process.exit(0);
}

// check mode
const snapshots = listSnapshots();
if (snapshots.length === 0) {
  console.error(
    "[surface-audit] no baseline snapshot found in docs/api-surface/. Run `pnpm run audit:surface:update` to create one.",
  );
  process.exit(1);
}

const baselineMeta = snapshots.at(-1);
const baseline = loadSnapshot(baselineMeta.file);
const current = buildSnapshot();

let failed = 0;
let bumped = 0;
let additive = 0;
let ok = 0;

const currentNames = new Set(Object.keys(current.packages));
for (const name of Object.keys(baseline.packages)) {
  if (currentNames.has(name)) continue;
  console.error(
    `[surface-audit] FAIL ${name}: package removed from roster since train ${baselineMeta.train}. Regenerate the snapshot at a bumped train.`,
  );
  failed += 1;
}

for (const name of Object.keys(current.packages).sort()) {
  const cur = current.packages[name];
  const base = baseline.packages[name];
  if (!base) {
    console.log(`[surface-audit] ok ${name}: new package (additive)`);
    ok += 1;
    additive += 1;
    continue;
  }
  const verdict = decidePackage({
    baseline: base,
    current: cur,
    baselineVersion: base.version,
    currentVersion: cur.version,
  });
  const { diff } = verdict;
  if (verdict.status === "ok") {
    if (diff.added.length > 0) {
      console.log(`[surface-audit] ok ${name}: +${diff.added.length} additive export(s)`);
      additive += 1;
    }
    ok += 1;
  } else if (verdict.status === "ok-bumped") {
    console.log(
      `[surface-audit] ok ${name}: breaking change declared by version bump ${base.version} -> ${cur.version} ` +
        `(removed ${diff.removed.length}, changed ${diff.changed.length}). Regenerate the snapshot to record train ${cur.version}.`,
    );
    bumped += 1;
    ok += 1;
  } else {
    console.error(
      `[surface-audit] FAIL ${name}: breaking export change at unchanged version ${cur.version}.`,
    );
    for (const r of diff.removed) console.error(`    removed:  ${r}`);
    for (const c of diff.changed) console.error(`    changed:  ${c}`);
    console.error(
      `    -> bump ${name} past ${base.version} and run \`pnpm run audit:surface:update\`, or restore the removed export.`,
    );
    failed += 1;
  }
}

if (failed > 0) {
  console.error(
    `[surface-audit] FAILED: ${failed} package(s) with un-versioned breaking export changes (baseline train ${baselineMeta.train}).`,
  );
  process.exit(1);
}

console.log(
  `[surface-audit] OK (baseline train ${baselineMeta.train}; ${ok} packages clean, ${additive} additive, ${bumped} bumped).`,
);
