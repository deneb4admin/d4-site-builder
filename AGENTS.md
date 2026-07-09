# Assembling a client site: the agent procedure

This document is the deterministic procedure an AI agent follows to turn a client's selections into a working site. Follow it in order. Do not improvise wiring; everything the assembly needs is declared in module manifests and executed by the scripts in this repo.

## Inputs you need before starting

- The client's business facts: site name, tagline, description, contact email, phone, address. Never invent these; use only what the client supplied.
- The client's selected features, from their brief or selection form.
- Node and git available on the machine.
- A clone of this repo (`d4-site-builder`).

## Match selections to modules

Read `registry.json`. It is the closed menu: nothing off this list gets assembled. Match the client's selections to module names:

| Client asked for | Module |
|---|---|
| Editing their own content, an admin area, "CMS" | `d4-cms-core` |
| Jobs page, hiring, careers, applications | `d4-careers-portal` |
| Blog, news, articles, insights, updates | `d4-insights-blog` |
| Product list, services list, catalog, specs | `d4-catalog` |
| Photo gallery, portfolio, project photos | `d4-gallery-editor` |

For anything requested that has no module here, stop and escalate to a human. Do not build custom features during assembly.

You may read each candidate module's `manifest.json` (in its repo root) for its `description`, `clientFacingSummary`, and `keywords` when the mapping is unclear. `d4-site-template` is always included automatically. Any content module automatically pulls in `d4-cms-core`; you do not need to select it explicitly, but selecting it does no harm.

## Write the build config

Copy `examples/build.example.json` and fill it in with the client's facts and module list. Set `output` to a directory that does not exist yet.

Theme: pick `themePreset` from `slate-teal`, `warm-sand`, or `ink-indigo`, or pass a `theme` object of CSS variable names to space-separated RGB channel values for a custom palette.

## Assemble

```
node bin/assemble.mjs --config <your-build.json>
```

Options:
- `--modules-dir <dir>`: a directory containing local checkouts named after the modules (used before cloning). Without it, modules are cloned shallowly into `.d4-cache/`.

The script fails loudly and makes no partial output directory on config errors. If it fails, read the message, fix the config, and rerun. Do not hand-patch a partial assembly.

What it does, in order: resolves modules plus required dependencies, checks route and panel conflicts, copies each module's `files/` payload in registry order, merges npm dependencies into `package.json`, generates `src/config/nav.generated.ts` and `src/config/admin-panels.generated.tsx`, writes `src/config/site.ts` from your config, writes `src/app/theme.css` if a theme was chosen, writes `.env.example`, and records `d4.assembly.json`.

## Configure the environment

In the output directory, copy `.env.example` to `.env.local` and fill in every variable marked REQUIRED. For `d4-cms-core`:

- `ADMIN_PASSWORD`: generate a strong unique value. Record it in the handoff notes flagged rotate-before-use. Never reuse a password across clients.
- `TOTP_SECRET` (optional but recommended): a base32 secret enabling two-factor login.

## Verify

Run every step; do not skip on the assumption it probably works.

```
cd <output-dir>
npm install
npm run build
```

The build must complete with no errors. Then run `npm run dev` and check:

- Home, About, and Contact pages render with the client's name and copy.
- Every module route in `d4.assembly.json` renders (e.g. `/careers`, `/insights`, `/catalog`, `/gallery`).
- `/admin` accepts `ADMIN_PASSWORD` and the dashboard shows one tab per selected content module.
- Create a test item in each admin panel and confirm it appears on the public page, then delete it.
- The contact form submits successfully.

If any check fails, fix the root cause or escalate. Do not ship a site with a failing check.

## Handoff notes to produce

- The admin URL (`/admin`), the password, and whether 2FA is enabled, all flagged rotate-before-use.
- Which modules and versions shipped (copy from `d4.assembly.json`).
- Which env vars are set where the site is hosted.
- Note that `data/` and `public/uploads/` hold the client's content and must be included in backups; both require a writable filesystem on the host.
