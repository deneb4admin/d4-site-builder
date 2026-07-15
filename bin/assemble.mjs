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
const pairingsFile = readJson(path.join(ROOT, "pairings.json"), "pairings.json");
const presetsFile = readJson(path.join(ROOT, "presets.json"), "presets.json");

let pairing = null;
if (config.pairing) {
  pairing = pairingsFile.pairings.find((p) => p.id === config.pairing);
  if (!pairing) {
    fail(
      `Unknown pairing "${config.pairing}". pairings.json is the closed menu; options: ${pairingsFile.pairings
        .map((p) => p.id)
        .join(", ")}.`
    );
  }
}

const outDir = path.resolve(config.output ?? fail("Build config needs \"output\": a directory path."));
if (!config.siteName) fail('Build config needs "siteName".');
if (!Array.isArray(config.modules)) fail('Build config needs "modules": an array of module names.');

// ── Validate optional shell config (before any output is created) ──────
// Nav structure: items may nest (children) and carry descriptions; the
// template renders groups with children as mega-menu panels. Closed shape:
// anything unrecognized fails the build.
function validateNav(items, where, depth = 0) {
  if (!Array.isArray(items)) fail(`${where} must be an array of nav items.`);
  if (depth > 2) fail(`${where}: nav nests at most two levels below the top (group > child > sub).`);
  return items.map((item) => {
    if (typeof item?.label !== "string" || !item.label.trim()) {
      fail(`${where}: every nav item needs a non-empty string "label".`);
    }
    if (typeof item?.href !== "string" || !/^(\/|https?:\/\/)/.test(item.href)) {
      fail(`${where} "${item.label}": "href" must start with "/" or be an absolute http(s) URL.`);
    }
    const known = { label: item.label, href: item.href };
    if (item.description !== undefined) {
      if (typeof item.description !== "string") fail(`${where} "${item.label}": "description" must be a string.`);
      known.description = item.description;
    }
    if (item.children !== undefined) {
      known.children = validateNav(item.children, `${where} "${item.label}" children`, depth + 1);
    }
    const extra = Object.keys(item).filter((k) => !["label", "href", "description", "children"].includes(k));
    if (extra.length) fail(`${where} "${item.label}": unknown nav item field(s): ${extra.join(", ")}.`);
    return known;
  });
}
const baseNav = config.nav?.base
  ? validateNav(config.nav.base, 'nav.base')
  : [
      { label: "Home", href: "/" },
      { label: "About", href: "/about" },
    ];
const tailNav = config.nav?.tail
  ? validateNav(config.nav.tail, 'nav.tail')
  : [{ label: "Contact", href: "/contact" }];

// Optional announcement bar (config-gated; null = hidden).
let announcement = null;
if (config.announcement) {
  if (typeof config.announcement.text !== "string" || !config.announcement.text.trim()) {
    fail('announcement needs a non-empty "text".');
  }
  announcement = { text: config.announcement.text };
  if (config.announcement.href) announcement.href = String(config.announcement.href);
  if (config.announcement.linkLabel) announcement.linkLabel = String(config.announcement.linkLabel);
}

// Quote-request modal config; enabled by default.
const quote = {
  enabled: config.quote?.enabled !== false,
  topics: Array.isArray(config.quote?.topics) ? config.quote.topics.map(String) : [],
};

// Footer social links.
const socialLinks = Array.isArray(config.socialLinks)
  ? config.socialLinks.map((s) => {
      if (typeof s?.label !== "string" || typeof s?.href !== "string") {
        fail('socialLinks entries need string "label" and "href".');
      }
      return { label: s.label, href: s.href };
    })
  : [];

// Home page FAQ section (hidden when empty).
const faq = Array.isArray(config.faq)
  ? config.faq.map((f) => {
      if (typeof f?.q !== "string" || !f.q.trim() || typeof f?.a !== "string" || !f.a.trim()) {
        fail('faq entries need non-empty string "q" and "a".');
      }
      return { q: f.q, a: f.a };
    })
  : [];
if (faq.length > 12) fail(`faq has ${faq.length} entries; cap is 12 — a FAQ longer than that belongs on its own page.`);

// Home page logo strip (hidden when items is empty).
let logoWall = { items: [] };
if (config.logoWall) {
  if (!Array.isArray(config.logoWall.items)) fail('logoWall needs an "items" array.');
  logoWall = {
    ...(config.logoWall.title ? { title: String(config.logoWall.title) } : {}),
    items: config.logoWall.items.map((it) => {
      if (typeof it?.name !== "string" || !it.name.trim()) {
        fail('logoWall items need a non-empty string "name".');
      }
      const entry = { name: it.name };
      if (it.src) entry.src = String(it.src);
      if (it.subtitle) entry.subtitle = String(it.subtitle);
      if (it.size !== undefined) {
        if (!["sm", "md", "lg"].includes(it.size)) fail(`logoWall "${it.name}": size must be sm, md, or lg.`);
        entry.size = it.size;
      }
      return entry;
    }),
  };
}

// Theme resolution (validated here, written after payload copy).
// Light palette priority: explicit theme > themePreset > pairing fallback.
// Dark palette priority: explicit themeDark > preset dark > pairing dark —
// but a custom light theme (e.g. brand ingest) without an explicit themeDark
// gets NO dark block: dark mode only ships with a palette that was
// contrast-validated against that palette source (bin/validate-contrast.mjs).
// config.darkMode === false disables dark mode regardless.
const PRESETS = presetsFile.presets;
let themeVars = null;
let darkVars = null;
if (config.theme && typeof config.theme === "object") {
  themeVars = { ...config.theme };
  if (config.themeDark && typeof config.themeDark === "object") darkVars = { ...config.themeDark };
} else if (config.themePreset) {
  const preset = PRESETS[config.themePreset];
  if (!preset) fail(`Unknown themePreset "${config.themePreset}". Options: ${Object.keys(PRESETS).join(", ")}.`);
  themeVars = { ...preset.light };
  darkVars = { ...preset.dark };
} else if (pairing) {
  themeVars = { ...pairing.fallbackTheme };
  darkVars = pairing.fallbackThemeDark ? { ...pairing.fallbackThemeDark } : null;
}
if (config.darkMode === false) darkVars = null;
// With no theme override at all, the template's checked-in default stands
// (modern-signal light + validated dark), so dark mode defaults to on.
const darkMode = themeVars ? Boolean(darkVars) : config.darkMode !== false;

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
  `import type { Announcement, FaqItem, LogoWall, NavItem, QuoteConfig, SocialLink } from "@/types";

/**
 * Site identity. Written by d4-site-builder from the build config.
 */
export const siteConfig = ${JSON.stringify(site, null, 2)};

/**
 * Base navigation. Module nav entries are appended after these. Items with
 * children render as mega-menu groups; flat items as plain links.
 */
export const baseNav: NavItem[] = ${JSON.stringify(baseNav, null, 2)};

/** Nav entries pinned to the end (after module entries). */
export const tailNav: NavItem[] = ${JSON.stringify(tailNav, null, 2)};

/** Optional announcement bar above the header; null = hidden. */
export const announcement: Announcement | null = ${JSON.stringify(announcement, null, 2)};

/** Quote-request modal; when disabled, quote CTAs link to /contact instead. */
export const quoteConfig: QuoteConfig = ${JSON.stringify(quote, null, 2)};

/** Social profiles shown in the footer; empty = hidden. */
export const socialLinks: SocialLink[] = ${JSON.stringify(socialLinks, null, 2)};

/** FAQ entries for the home page; empty = section hidden. */
export const faq: FaqItem[] = ${JSON.stringify(faq, null, 2)};

/** Client/partner logo strip on the home page; empty items = hidden. */
export const logoWall: LogoWall = ${JSON.stringify(logoWall, null, 2)};
`
);

// ── Theme (resolved and validated up top; written here) ────────────────
if (themeVars) {
  // Text color on accent fills; custom themes predating the token get white.
  if (!themeVars["--accent-contrast"]) themeVars["--accent-contrast"] = "255 255 255";
  const block = (vars) =>
    Object.entries(vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
  const dark = darkVars ? `\n\n.dark {\n  color-scheme: dark;\n${block(darkVars)}\n}` : "";
  writeFileSync(
    path.join(outDir, "src", "app", "theme.css"),
    `/*\n * Theme tokens. Written by d4-site-builder from the build config.\n * Values are space-separated RGB channels.\n */\n:root {\n  color-scheme: light;\n${block(themeVars)}\n}${dark}\n`
  );
}

// ── Pairing: fonts + motion signature + dark-mode flag ─────────────────
// The template ships working defaults for the generated files; when the
// build config names a pairing, fonts + motion are rewritten from
// pairings.json. design.generated.ts is also rewritten whenever the theme
// changed, so the darkMode flag always matches what theme.css carries.
if (pairing) {
  const fontDecl = (spec, cssVar) =>
    `${spec.import}({
  subsets: ["latin"],
  weight: ${JSON.stringify(spec.weights)},
  variable: "${cssVar}",
  display: "swap",
})`;
  writeFileSync(
    path.join(outDir, "src", "config", "fonts.generated.ts"),
    `/**
 * GENERATED FILE. Written by d4-site-builder during assembly. Do not edit
 * by hand; edits are overwritten on reassembly.
 * Pairing: ${pairing.id} — ${pairing.display.family} / ${pairing.body.family}
 */
import { ${pairing.display.import}${pairing.body.import !== pairing.display.import ? `, ${pairing.body.import}` : ""} } from "next/font/google";

export const displayFont = ${fontDecl(pairing.display, "--font-display")};

export const bodyFont = ${fontDecl(pairing.body, "--font-body")};
`
  );
}
if (pairing || themeVars || config.darkMode === false) {
  writeFileSync(
    path.join(outDir, "src", "config", "design.generated.ts"),
    `/**
 * GENERATED FILE. Written by d4-site-builder during assembly. Do not edit
 * by hand; edits are overwritten on reassembly.
 */
export const pairingId = ${JSON.stringify(pairing ? pairing.id : "modern-signal")};

/** Motion signature; the template's motion layer keys off this value. */
export const motionMode = ${JSON.stringify(pairing ? pairing.motion : "reveal-fast")};

/**
 * True when theme.css carries a validated .dark palette. Gates the header
 * theme toggle and the early theme script; with no dark palette the site is
 * permanently light and no toggle renders.
 */
export const darkMode = ${JSON.stringify(darkMode)};
`
  );
}
if (pairing) {
  console.log(
    `Applied pairing ${pairing.id} (${pairing.display.family} / ${pairing.body.family}, motion: ${pairing.motion}, dark mode: ${darkMode ? "on" : "off"})`
  );
} else if (themeVars) {
  console.log(`Applied theme (${config.themePreset ? `preset ${config.themePreset}` : "custom"}, dark mode: ${darkMode ? "on" : "off"})`);
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
      pairing: pairing ? pairing.id : null,
      darkMode,
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
