/**
 * Pure surface-diff and breaking-change decision logic for the API-surface
 * audit gate (P1-2, #16).
 *
 * A "surface" for one package is:
 *   { version: string, entrypoints: { <key>: { source, exports: { <name>: { kind, sig } } } } }
 *
 * These helpers hold no I/O and no TypeScript-compiler state, so the gate
 * decision is deterministic and unit-testable against synthetic surfaces.
 */

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Understands the numeric release triple plus an optional dotted pre-release
 * tail (for example `0.2.0-rc.1` < `0.2.0-rc.2` < `0.2.0`).
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-");
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  // A release (no pre-release tail) outranks any pre-release of the same triple.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePreRelease(pa.pre, pb.pre);
}

function comparePreRelease(a, b) {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const ai = as[i];
    const bi = bs[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = Number.parseInt(ai, 10);
    const bn = Number.parseInt(bi, 10);
    const aNum = String(an) === ai;
    const bNum = String(bn) === bi;
    if (aNum && bNum) {
      if (an !== bn) return an > bn ? 1 : -1;
    } else if (ai !== bi) {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

export function semverGt(a, b) {
  return compareSemver(a, b) > 0;
}

/**
 * Diff a package's baseline surface against its current surface.
 *
 * Breaking = a previously exported name is gone (removal/rename) OR an existing
 * name's signature changed (a rename, kind change, or narrowed/altered type).
 * A removed entry point counts every name it used to export as removed.
 * Additive = a brand-new export name or a brand-new entry point, with no
 * change to any pre-existing name.
 */
export function diffPackageSurface(baseline, current) {
  const removed = [];
  const changed = [];
  const added = [];

  const baseEps = baseline?.entrypoints ?? {};
  const curEps = current?.entrypoints ?? {};

  for (const [ep, baseEp] of Object.entries(baseEps)) {
    const curEp = curEps[ep];
    const baseExports = baseEp?.exports ?? {};
    if (!curEp) {
      for (const name of Object.keys(baseExports)) removed.push(`${ep}:${name}`);
      continue;
    }
    const curExports = curEp.exports ?? {};
    for (const [name, desc] of Object.entries(baseExports)) {
      const curDesc = curExports[name];
      if (!curDesc) {
        removed.push(`${ep}:${name}`);
      } else if (curDesc.kind !== desc.kind || curDesc.sig !== desc.sig) {
        changed.push(`${ep}:${name}`);
      }
    }
  }

  for (const [ep, curEp] of Object.entries(curEps)) {
    const baseEp = baseEps[ep];
    const curExports = curEp?.exports ?? {};
    const baseExports = baseEp?.exports ?? {};
    for (const name of Object.keys(curExports)) {
      if (!baseExports[name]) added.push(`${ep}:${name}`);
    }
  }

  removed.sort();
  changed.sort();
  added.sort();
  const breaking = [...removed, ...changed].sort();
  return { removed, changed, added, breaking, hasBreaking: breaking.length > 0 };
}

/**
 * Decide the gate verdict for one package.
 *
 * - No breaking change            -> "ok" (identical or purely additive).
 * - Breaking change + version bump -> "ok-bumped" (the bump declares the break;
 *   the snapshot must be regenerated so the next train carries the new surface).
 * - Breaking change, no bump       -> "fail".
 *
 * `baselineVersion` is the version recorded in the committed snapshot; a break
 * is only permitted when the current package version is strictly greater.
 */
export function decidePackage({ baseline, current, baselineVersion, currentVersion }) {
  const diff = diffPackageSurface(baseline, current);
  if (!diff.hasBreaking) {
    return { status: "ok", diff, bumped: semverGt(currentVersion, baselineVersion) };
  }
  const bumped = semverGt(currentVersion, baselineVersion);
  return { status: bumped ? "ok-bumped" : "fail", diff, bumped };
}
