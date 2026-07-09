#!/usr/bin/env node
/**
 * D4 site assembler.
 *
 * Usage:
 *   node bin/assemble.mjs --config <build.json> [--modules-dir <dir>]
 *
 * Reads a build config (see examples/build.example.json), resolves the
 * selected modules plus their required dependencies, copies their payloads
 * into the output directory in registry order, merges npm dependencies,
 * generates the nav and admin-panel registries, rewrites site config and
 * theme, writes .env.example, and records d4.assembly.json.
 *
 * Module sources: each module is looked up first under --modules-dir
 * (a directory containing checkouts named after the modules), then cloned
 * with `git clone --depth 1` into .d4-cache/ using the repo URL from
 * registry.json.
 *
 * Node built-ins only; no npm install needed to run this script.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function fail(msg) {
  console.error(`\nASSEMBLY FAILED: ${msg}\n`);
  process.exit(1);
}

function readJson(fp, what) {
  if (!existsSync(fp)) fail(`${what} not found at ${fp}`);
  try {
    return JSON.parse(readFileSync(fp, "utf8"));
  } catch (e) {
    fail(`${what} at ${fp} is not valid JSON: ${e.message}`);
  }
}

// ── Arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const configPath = argValue("--config");
if (!configPath) fail("Pass --config <build.json>. See examples/build.example.json.");
const modulesDir = argValue("--modules-dir");

// ── Inputs ─────────────────────────────────────────────────────────────
const config = readJson(path.resolve(configPath), "Build config");
const registry = readJson(path.join(ROOT, "registry.json"), "registry.json");

const outDir = path.resolve(config.output ?? fail("Build config needs \"output\": a directory path."));
if (!config.siteName) fail('Build config needs "siteName".');
if (!Array.isArray(config.modules)) fail('Build config needs "modules": an array of module names.');

const registryByName = new Map(registry.modules.map((m) => [m.name, m]));

// ── Resolve selection: always-included + selected + required deps ──────
const selected = new Set(config.modules);
for (const m of registry.modules) if (m.alwaysIncluded) selected.add(m.name);

for (const name of selected) {
  if (!registryByName.has(name)) {
    fail(`Module "${name}" is not in registry.json. The registry is the closed menu; nothing off it gets assembled.`);
  }
}

// ── Fetch module sources ───────────────────────────────────────────────
const cacheDir = path.join(process.cwd(), ".d4-cache");

function sourceDirFor(name) {
  if (modulesDir) {
    const local = path.join(path.resolve(modulesDir), name);
    if (existsSync(path.join(local, "manifest.json"))) return local;
  }
  const cached = path.join(cacheDir, name);
  if (existsSync(path.join(cached, "manifest.json"))) return cached;
  const repo = registryByName.get(name).repo;
  console.log(`Cloning ${repo} …`);
  mkdirSync(cacheDir, { recursive: true });
  rmSync(cached, { recursive: true, force: true });
  execFileSync("git", ["clone", "--depth", "1", repo, cached], { stdio: "inherit" });
  return cached;
}

// Load manifests, expanding required dependencies until stable.
const manifests = new Map();
let added = true;
while (added) {
  added = false;
  for (const name of [...selected]) {
    if (manifests.has(name)) continue;
    const dir = sourceDirFor(name);
    const manifest = readJson(path.join(dir, "manifest.json"), `${name} manifest`);
    if (manifest.name !== name) fail(`${name}: manifest name "${manifest.name}" does not match.`);
    manifests.set(name, { manifest, dir });
    for (const dep of Object.keys(manifest.requires ?? {})) {
      if (!selected.has(dep)) {
        console.log(`${name} requires ${dep}; including it.`);
        selected.add(dep);
        added = true;
      }
    }
  }
}

// Deterministic order: registry order.
const ordered = registry.modules.filter((m) => selected.has(m.name)).map((m) => m.name);

// ── Conflict checks ────────────────────────────────────────────────────
const routeOwners = new Map();
for (const name of ordered) {
  for (const route of manifests.get(name).manifest.provides?.routes ?? []) {
    if (routeOwners.has(route)) {
      fail(`Route conflict: ${route} is provided by both ${routeOwners.get(route)} and ${name}.`);
    }
    routeOwners.set(route, name);
  }
}
const panelIds = new Map();
for (const name of ordered) {
  for (const p of manifests.get(name).manifest.provides?.adminPanels ?? []) {
    if (panelIds.has(p.id)) {
      fail(`Admin panel id conflict: "${p.id}" in both ${panelIds.get(p.id)} and ${name}.`);
    }
    panelIds.set(p.id, name);
  }
}

// ── Copy payloads ──────────────────────────────────────────────────────
if (existsSync(outDir)) {
  fail(`Output directory already exists: ${outDir}. Refusing to overwrite; remove it or pick another path.`);
}
mkdirSync(outDir, { recursive: true });

for (const name of ordered) {
  const { manifest, dir } = manifests.get(name);
  for (const step of manifest.copy) {
    const from = path.join(dir, step.from);
    const to = path.join(outDir, step.to);
    if (!existsSync(from)) fail(`${name}: copy source ${step.from} does not exist.`);
    cpSync(from, to, { recursive: true });
  }
  console.log(`Copied ${name}@${manifest.version}`);
}

// ── Merge npm dependencies ─────────────────────────────────────────────
const pkgPath = path.join(outDir, "package.json");
const pkg = readJson(pkgPath, "Assembled package.json");
pkg.name = config.siteName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 100) || "d4-site";
for (const name of ordered) {
  const m = manifests.get(name).manifest;
  Object.assign(pkg.dependencies, m.npmDependencies ?? {});
  pkg.devDependencies = { ...pkg.devDependencies, ...(m.npmDevDependencies ?? {}) };
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// ── Generate nav registry ──────────────────────────────────────────────
const navEntries = ordered.flatMap((name) => manifests.get(name).manifest.provides?.nav ?? []);
writeFileSync(
  path.join(outDir, "src", "config", "nav.generated.ts"),
  `/**
 * GENERATED FILE. Written by d4-site-builder during assembly. Do not edit
 * by hand; edits are overwritten on reassembly.
 */
import type { NavItem } from "@/types";

export const moduleNav: NavItem[] = ${JSON.stringify(navEntries, null, 2)};
`
);

// ── Generate admin panel registry ──────────────────────────────────────
const panels = ordered.flatMap((name) => manifests.get(name).manifest.provides?.adminPanels ?? []);
const panelImports = panels
  .map((p, i) => `import Panel${i} from "${p.importPath}";`)
  .join("\n");
const panelRows = panels
  .map((p, i) => `  { id: ${JSON.stringify(p.id)}, label: ${JSON.stringify(p.label)}, Component: Panel${i} },`)
  .join("\n");
writeFileSync(
  path.join(outDir, "src", "config", "admin-panels.generated.tsx"),
  `/**
 * GENERATED FILE. Written by d4-site-builder during assembly. Do not edit
 * by hand; edits are overwritten on reassembly.
 */
import type { ComponentType } from "react";
${panelImports ? panelImports + "\n" : ""}
export interface AdminPanel {
  id: string;
  label: string;
  Component: ComponentType;
}

export const adminPanels: AdminPanel[] = [
${panelRows}
];
`
);

// ── Rewrite site config ────────────────────────────────────────────────
const site = {
  name: config.siteName,
  tagline: config.tagline ?? "A clear, direct statement of what this business does.",
  description:
    config.description ??
    "Replace this with two or three sentences about the business: who it serves, what it delivers, and why clients choose it.",
  contactEmail: config.contactEmail ?? "",
  phone: config.phone ?? "",
  address: config.address ?? "",
};
writeFileSync(
  path.join(outDir, "src", "config", "site.ts"),
  `import type { NavItem } from "@/types";

/**
 * Site identity. Written by d4-site-builder from the build config.
 */
export const siteConfig = ${JSON.stringify(site, null, 2)};

/** Base navigation. Module nav entries are appended after these. */
export const baseNav: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "About", href: "/about" },
];

/** Nav entries pinned to the end (after module entries). */
export const tailNav: NavItem[] = [{ label: "Contact", href: "/contact" }];
`
);

// ── Theme ──────────────────────────────────────────────────────────────
const PRESETS = {
  "slate-teal": {
    "--accent": "15 118 110",
    "--accent-strong": "17 94 89",
    "--bg-base": "248 250 252",
    "--bg-surface": "255 255 255",
    "--text-heading": "15 23 42",
    "--text-body": "51 65 85",
    "--text-muted": "100 116 139",
  },
  "warm-sand": {
    "--accent": "180 99 42",
    "--accent-strong": "146 78 32",
    "--bg-base": "250 246 240",
    "--bg-surface": "255 255 255",
    "--text-heading": "35 26 18",
    "--text-body": "77 62 48",
    "--text-muted": "128 108 90",
  },
  "ink-indigo": {
    "--accent": "79 70 229",
    "--accent-strong": "67 56 202",
    "--bg-base": "250 250 252",
    "--bg-surface": "255 255 255",
    "--text-heading": "17 24 39",
    "--text-body": "55 65 81",
    "--text-muted": "107 114 128",
  },
};
let themeVars = null;
if (config.theme && typeof config.theme === "object") {
  themeVars = config.theme;
} else if (config.themePreset) {
  themeVars = PRESETS[config.themePreset];
  if (!themeVars) fail(`Unknown themePreset "${config.themePreset}". Options: ${Object.keys(PRESETS).join(", ")}.`);
}
if (themeVars) {
  const lines = Object.entries(themeVars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  writeFileSync(
    path.join(outDir, "src", "app", "theme.css"),
    `/*\n * Theme tokens. Written by d4-site-builder from the build config.\n * Values are space-separated RGB channels.\n */\n:root {\n${lines}\n}\n`
  );
}

// ── .env.example ───────────────────────────────────────────────────────
const envLines = [`# Generated by d4-site-builder for ${config.siteName}`];
const seenEnv = new Set();
for (const name of ordered) {
  const m = manifests.get(name).manifest;
  for (const v of m.env ?? []) {
    if (seenEnv.has(v.name)) continue;
    seenEnv.add(v.name);
    envLines.push(`# ${v.required ? "REQUIRED" : "optional"} (${name}): ${v.description}`);
    envLines.push(`${v.name}=`);
  }
}
writeFileSync(path.join(outDir, ".env.example"), envLines.join("\n") + "\n");

// ── Assembly record ────────────────────────────────────────────────────
writeFileSync(
  path.join(outDir, "d4.assembly.json"),
  JSON.stringify(
    {
      assembledAt: new Date().toISOString(),
      siteName: config.siteName,
      modules: Object.fromEntries(
        ordered.map((n) => [n, manifests.get(n).manifest.version])
      ),
      routes: Object.fromEntries(routeOwners),
    },
    null,
    2
  ) + "\n"
);

const requiredEnv = ordered
  .flatMap((n) => (manifests.get(n).manifest.env ?? []).filter((v) => v.required))
  .map((v) => v.name);

console.log(`
Assembled "${config.siteName}" at ${outDir}
Modules: ${ordered.join(", ")}

Next steps:
  cd ${outDir}
  npm install
  ${requiredEnv.length ? `Set required env vars in .env.local: ${[...new Set(requiredEnv)].join(", ")}` : "No required env vars."}
  npm run build   (verify it compiles)
  npm run dev
`);
