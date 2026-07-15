#!/usr/bin/env node
/**
 * WCAG contrast validator for the closed design menus.
 *
 * Checks every pairing palette in pairings.json (fallbackTheme +
 * fallbackThemeDark) and every preset in presets.json (light + dark):
 *
 *   - --text-heading / --text-body / --text-muted >= 4.5:1 on both
 *     --bg-base and --bg-surface
 *   - --accent and --accent-strong >= 4.5:1 as TEXT on both backgrounds
 *     in DARK palettes (accents are used for links/labels on dark bg).
 *     In light palettes the accents are fills, not guaranteed text, so
 *     they are reported informationally but don't fail the run.
 *   - --accent-contrast >= 4.5:1 on both --accent and --accent-strong
 *     (button text on accent fills), when the palette declares it.
 *
 * Exit code 0 = all required checks pass; 1 = at least one failure.
 * Run after ANY palette edit. Node built-ins only.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(rgb) {
  const [r, g, b] = rgb.split(/\s+/).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;
let checks = 0;

function check(label, fg, bg, required) {
  const ratio = contrast(fg, bg);
  const pass = ratio >= 4.5;
  checks++;
  if (!pass && required) {
    failures++;
    console.log(`  FAIL  ${label}: ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
  } else if (!pass) {
    console.log(`  info  ${label}: ${ratio.toFixed(2)}:1 (not a text role here)`);
  } else if (process.env.VERBOSE) {
    console.log(`  ok    ${label}: ${ratio.toFixed(2)}:1`);
  }
}

function validatePalette(name, vars, { dark }) {
  const required = ["--bg-base", "--bg-surface", "--text-heading", "--text-body", "--text-muted", "--accent", "--accent-strong"];
  for (const key of required) {
    if (!vars[key]) {
      failures++;
      console.log(`  FAIL  ${name}: missing ${key}`);
      return;
    }
  }
  for (const bg of ["--bg-base", "--bg-surface"]) {
    for (const text of ["--text-heading", "--text-body", "--text-muted"]) {
      check(`${name} ${text} on ${bg}`, vars[text], vars[bg], true);
    }
    // Accents double as link/label text on dark backgrounds.
    check(`${name} --accent on ${bg}`, vars["--accent"], vars[bg], dark);
    check(`${name} --accent-strong on ${bg}`, vars["--accent-strong"], vars[bg], dark);
  }
  if (vars["--accent-contrast"]) {
    check(`${name} --accent-contrast on --accent`, vars["--accent-contrast"], vars["--accent"], true);
    check(`${name} --accent-contrast on --accent-strong`, vars["--accent-contrast"], vars["--accent-strong"], true);
  } else if (dark) {
    failures++;
    console.log(`  FAIL  ${name}: dark palette must declare --accent-contrast`);
  }
}

const pairings = JSON.parse(readFileSync(path.join(ROOT, "pairings.json"), "utf8"));
console.log("pairings.json:");
for (const p of pairings.pairings) {
  validatePalette(`${p.id} (light)`, p.fallbackTheme, { dark: false });
  if (p.fallbackThemeDark) {
    validatePalette(`${p.id} (dark)`, p.fallbackThemeDark, { dark: true });
  } else {
    failures++;
    console.log(`  FAIL  ${p.id}: missing fallbackThemeDark`);
  }
}

const presets = JSON.parse(readFileSync(path.join(ROOT, "presets.json"), "utf8"));
console.log("presets.json:");
for (const [id, modes] of Object.entries(presets.presets)) {
  validatePalette(`${id} (light)`, modes.light, { dark: false });
  validatePalette(`${id} (dark)`, modes.dark, { dark: true });
}

console.log(`\n${checks} checks, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
