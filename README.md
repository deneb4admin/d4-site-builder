# d4-site-builder

The orchestrator for the D4 toolkit. It turns a build config (client facts plus selected modules) into a complete, buildable Next.js site by copying module payloads together and generating the wiring between them.

If you are an AI agent assembling a site, read [AGENTS.md](AGENTS.md); it is the complete procedure.

## The pieces

| Path | Purpose |
|---|---|
| `registry.json` | The closed menu of modules: names, repos, one-line summaries. Assembly order is registry order. |
| `schema/manifest.schema.json` | JSON Schema every module's `manifest.json` conforms to. |
| `bin/assemble.mjs` | The assembler. Node built-ins only, no install needed. |
| `bin/validate.mjs` | Validates a module's manifest against the contract. |
| `examples/build.example.json` | A filled-in build config to copy. |
| `AGENTS.md` | The step-by-step agent procedure, brief to handoff. |

## Quick start

```
node bin/assemble.mjs --config examples/build.example.json
cd acme-fabrication
npm install
npm run build
```

## How composition works

Every module repo carries a `manifest.json` (its contract) and a `files/` payload. The assembler:

- resolves the selected modules plus everything they `require`, in registry order
- refuses route or admin-panel collisions and unknown modules
- copies each payload into the output directory
- merges each module's npm dependencies into `package.json`
- generates `src/config/nav.generated.ts` (module nav entries) and `src/config/admin-panels.generated.tsx` (dashboard panels)
- writes `src/config/site.ts` and optionally `src/app/theme.css` from the build config
- writes `.env.example` from every module's declared env vars
- records the exact module versions in `d4.assembly.json`

The assembled output is a standalone repo-ready site with no further dependency on this tool.

## The module family

| Module | Kind |
|---|---|
| [d4-site-template](https://github.com/deneb4admin/d4-site-template) | site (always included) |
| [d4-cms-core](https://github.com/deneb4admin/d4-cms-core) | core |
| [d4-careers-portal](https://github.com/deneb4admin/d4-careers-portal) | feature |
| [d4-insights-blog](https://github.com/deneb4admin/d4-insights-blog) | feature |
| [d4-catalog](https://github.com/deneb4admin/d4-catalog) | feature |
| [d4-gallery-editor](https://github.com/deneb4admin/d4-gallery-editor) | feature |

## Adding a new module

Create a repo with `manifest.json` (validate it: `node bin/validate.mjs <dir>`) and a `files/` payload that copies cleanly onto the site template, then add it to `registry.json`. Modules must not overwrite each other's files; the safe pattern is one route directory under `src/app/` plus one module directory under `src/modules/<name>/`.
