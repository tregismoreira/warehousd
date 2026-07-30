# @warehousd/broker

The enforcement layer. Every read and every write goes through a verb here, and every verb writes
an audit row before it answers — see `docs/architecture.md` for the invariants and
`SECURITY.md` for what counts as a vulnerability against them.

## Why this package is private, and why its entry points are TypeScript

`package.json` is `"private": true` and both `main` and `exports` point at `./src/index.ts`
rather than at `dist/`. That combination is unusual enough to be worth stating rather than
leaving for someone to discover:

- **Nothing consumes `dist/`.** `apps/web` lists this package in Next's `transpilePackages`,
  `packages/cli` inlines it at build time (`noExternal: [/.*/]` in `tsup.config.ts`), and
  `examples/` and `scripts/` import the source directly. All four are in-workspace, so the raw
  `.ts` entry point resolves.
- **It is not published.** `packages/cli` is the published artifact and it carries this code
  inside its bundle. Marking the package private is what keeps an accidental `npm publish` from
  shipping a package whose entry point is TypeScript source that nothing downstream could compile.
- **`build` still runs.** `tsc -p tsconfig.json` emits `dist/` and is part of `pnpm build`; its
  value is the type-check, not the output. `pnpm typecheck` covers the same source plus `test/`
  (see `scripts/typecheck.ts`).

If this package ever needs to be consumed from outside the workspace, both entry points move to
`dist/` and `private` comes off — in the same change, not separately.
