<!--
Keep this short. The parts that matter are the two checklists below; the prose above them is for
whatever they do not cover.
-->

## What this changes

<!-- One paragraph. What behaviour is different afterwards, and why. -->

## Enforcement

warehousd's promises are that MCP clients send structured intents and never SQL, that every access
is scoped by a grant, and that every decision is audited (`README.md`, `SECURITY.md`,
`docs/architecture.md`). Tick what applies, or state that none does.

- [ ] No new path reaches SQL with client-supplied input except as a bound parameter or as an
      identifier validated by `sql/ident.ts`
- [ ] Any new broker verb parses its intent through `packages/broker/src/intents/schema.ts`
- [ ] Any new decision — allow or refuse — writes an audit row
- [ ] No new way to read or write data that does not go through a grant

## Checks

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] e2e run, if this touches the container, the CLI lifecycle, or SSO

## Notes for the reviewer

<!-- Anything you want looked at closely. Decisions you were unsure about belong here. -->
