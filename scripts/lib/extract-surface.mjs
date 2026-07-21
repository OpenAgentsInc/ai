/**
 * Public-export-surface extraction over the TypeScript compiler API.
 *
 * This extends the AISDK-02 collision-audit approach: instead of only checking
 * that export-map subpaths resolve, it enumerates the exported symbols of each
 * entry point and captures a stable descriptor per name (kind + a hash of the
 * resolved type signature). Removals/renames and signature changes then show up
 * as a diff against the committed baseline.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packagesDir = join(repoRoot, "packages");

/** Read the publishable roster: non-private packages under packages/. */
export function readRoster() {
  const roster = [];
  for (const name of readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const pkgRoot = join(packagesDir, name);
    const pkgJsonPath = join(pkgRoot, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkg.private) continue;
    roster.push({ dir: pkgRoot, name: pkg.name, version: pkg.version, pkg });
  }
  return roster;
}

/** Resolve one export-map target (string or conditions object) to a source path. */
function exportTargetPath(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    return target.default ?? target.import ?? target.require ?? null;
  }
  return null;
}

function shortSig(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const TYPE_STRING_FLAGS = () =>
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;

/**
 * Build a structural signature string for one export type, one level deep.
 * Captures call/construct signatures and the sorted property set (with each
 * property's type), so both value shapes (functions, consts) and declared
 * types (interfaces, type aliases, enums) produce a distinct, order-stable
 * descriptor. A removed member or narrowed property type changes the hash.
 */
function typeSignature(checker, type) {
  const parts = [];
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    parts.push(`call ${checker.signatureToString(sig)}`);
  }
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
    parts.push(`new ${checker.signatureToString(sig)}`);
  }
  const props = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    let propType = "?";
    try {
      const pt = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getDeclaredTypeOfSymbol(prop);
      propType = checker.typeToString(pt, decl, TYPE_STRING_FLAGS());
    } catch {
      propType = "?";
    }
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
    props.push(`${prop.getName()}${optional}:${propType}`);
  }
  props.sort();
  parts.push(`{${props.join(";")}}`);
  return parts.join(" ");
}

/** Resolve the descriptive type for an export symbol (value shape, else declared). */
function symbolSignatureText(checker, sym) {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  let valueType;
  try {
    valueType = decl ? checker.getTypeOfSymbolAtLocation(sym, decl) : undefined;
  } catch {
    valueType = undefined;
  }
  const isTypeOnly =
    (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum)) !== 0;
  const valueIsAny = valueType ? (valueType.flags & ts.TypeFlags.Any) !== 0 : true;
  if ((valueIsAny || !valueType) && (isTypeOnly || sym.flags & ts.SymbolFlags.Alias)) {
    try {
      const declared = checker.getDeclaredTypeOfSymbol(sym);
      return typeSignature(checker, declared);
    } catch {
      return `<unresolved:${sym.getName()}>`;
    }
  }
  if (!valueType) return `<unresolved:${sym.getName()}>`;
  return typeSignature(checker, valueType);
}

/**
 * Extract the surface of a single package: for each export-map entry point that
 * points at a TypeScript source file, the sorted set of exported names with a
 * { kind, sig } descriptor.
 */
export function extractPackageSurface({ dir, pkg }) {
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
  const parsed = configPath
    ? ts.parseJsonConfigFileContent(
        ts.readConfigFile(configPath, ts.sys.readFile).config,
        ts.sys,
        dir,
      )
    : { options: {} };

  const entries = [];
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    const rel = exportTargetPath(target);
    if (typeof rel !== "string") continue;
    if (!/\.tsx?$/.test(rel)) continue; // only TS entry points carry a type surface
    const abs = resolve(dir, rel);
    if (!existsSync(abs)) continue;
    entries.push({ key, rel, abs });
  }

  const program = ts.createProgram({
    rootNames: entries.map((e) => e.abs),
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
  const checker = program.getTypeChecker();

  const entrypoints = {};
  for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key))) {
    const sf = program.getSourceFile(entry.abs);
    const moduleSymbol = sf ? checker.getSymbolAtLocation(sf) : undefined;
    const exportsOut = {};
    if (moduleSymbol) {
      const symbols = checker
        .getExportsOfModule(moduleSymbol)
        .slice()
        .sort((a, b) => a.getName().localeCompare(b.getName()));
      for (const sym of symbols) {
        const name = sym.getName();
        if (name === "default" || name === "__esModule") continue;
        const sigText = symbolSignatureText(checker, sym);
        exportsOut[name] = { kind: symbolKind(sym), sig: shortSig(sigText) };
      }
    }
    entrypoints[entry.key] = { source: entry.rel, exports: exportsOut };
  }

  return { version: pkg.version, entrypoints };
}

function symbolKind(sym) {
  const f = sym.flags;
  const F = ts.SymbolFlags;
  if (f & F.Class) return "class";
  if (f & F.Enum) return "enum";
  if (f & F.Function) return "function";
  if (f & F.Interface) return "interface";
  if (f & F.TypeAlias) return "type";
  if (f & F.Namespace || f & F.Module) return "namespace";
  if (f & F.Variable || f & F.BlockScopedVariable) return "value";
  if (f & F.Alias) return "alias";
  return "value";
}

/** Extract the full workspace surface keyed by package name. */
export function extractWorkspaceSurface(roster = readRoster()) {
  const packages = {};
  for (const entry of roster) {
    packages[entry.name] = extractPackageSurface(entry);
  }
  return packages;
}

/**
 * Derive the train label for a roster: the single shared version when the
 * roster agrees, otherwise the highest version present. One version per train
 * is the P1-1/P1-3 convergence invariant this audit is paired with.
 */
export function deriveTrain(roster = readRoster()) {
  const versions = [...new Set(roster.map((r) => r.version))];
  if (versions.length === 1) return versions[0];
  return versions.sort().at(-1);
}
