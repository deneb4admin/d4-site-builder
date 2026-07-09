#!/usr/bin/env node
/**
 * Validates a module's manifest.json against the D4 manifest contract.
 *
 * Usage:
 *   node bin/validate.mjs <path-to-module-dir-or-manifest.json>
 *
 * Implements the checks from schema/manifest.schema.json directly (no npm
 * dependencies) so it runs anywhere Node runs.
 */
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node bin/validate.mjs <module-dir-or-manifest.json>");
  process.exit(1);
}

let manifestPath = path.resolve(target);
if (existsSync(manifestPath) && statSync(manifestPath).isDirectory()) {
  manifestPath = path.join(manifestPath, "manifest.json");
}
if (!existsSync(manifestPath)) {
  console.error(`No manifest.json found at ${manifestPath}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`Invalid JSON: ${e.message}`);
  process.exit(1);
}

const errors = [];
const warn = [];

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

if (typeof manifest.name !== "string" || !/^d4-[a-z0-9-]+$/.test(manifest.name)) {
  errors.push('name: required, must match ^d4-[a-z0-9-]+$');
}
if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  errors.push("version: required, must be semver (x.y.z)");
}
if (!["site", "core", "feature"].includes(manifest.kind)) {
  errors.push('kind: required, one of "site" | "core" | "feature"');
}
if (typeof manifest.description !== "string" || !manifest.description.trim()) {
  errors.push("description: required, non-empty string");
}
if (!manifest.clientFacingSummary) warn.push("clientFacingSummary: recommended");
if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
  warn.push("keywords: recommended for brief matching");
}
if (manifest.requires !== undefined && !isObj(manifest.requires)) {
  errors.push("requires: must be an object of moduleName -> semver range");
}

if (!isObj(manifest.provides)) {
  errors.push("provides: required object");
} else {
  const p = manifest.provides;
  for (const key of ["routes", "nav", "adminPanels", "collections"]) {
    if (!Array.isArray(p[key])) errors.push(`provides.${key}: required array`);
  }
  for (const n of p.nav ?? []) {
    if (!n.label || !n.href) errors.push(`provides.nav: every entry needs label and href`);
  }
  for (const a of p.adminPanels ?? []) {
    if (!a.id || !a.label || !a.importPath) {
      errors.push("provides.adminPanels: every entry needs id, label, importPath");
    } else if (!a.importPath.startsWith("@/")) {
      errors.push(`provides.adminPanels: importPath must be an @/ alias path (got ${a.importPath})`);
    }
  }
}

if (manifest.env !== undefined) {
  if (!Array.isArray(manifest.env)) errors.push("env: must be an array");
  else {
    for (const v of manifest.env) {
      if (!v.name || typeof v.required !== "boolean" || !v.description) {
        errors.push("env: every entry needs name, required (boolean), description");
      }
    }
  }
}

if (!Array.isArray(manifest.copy) || manifest.copy.length === 0) {
  errors.push("copy: required, at least one {from, to} step");
} else {
  const moduleDir = path.dirname(manifestPath);
  for (const step of manifest.copy) {
    if (!step.from || !step.to) errors.push("copy: every step needs from and to");
    else if (!existsSync(path.join(moduleDir, step.from))) {
      errors.push(`copy: source directory "${step.from}" does not exist in the module`);
    }
  }
}

const name = manifest.name ?? manifestPath;
if (errors.length) {
  console.error(`INVALID: ${name}`);
  for (const e of errors) console.error(`  error: ${e}`);
  for (const w of warn) console.error(`  warning: ${w}`);
  process.exit(1);
}
console.log(`VALID: ${name}@${manifest.version} (${manifest.kind})`);
for (const w of warn) console.log(`  warning: ${w}`);
