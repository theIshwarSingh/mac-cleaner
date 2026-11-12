# mac-cleaner: notes for agents

- Node 22, ESM, TypeScript. `npm run check` type-checks, `npm test` runs
  `node --test`, `npx tsx src/cli.ts ...` runs without a build.
- Never run `clean --yes`, `uninstall --yes`, `perf run` without `--dry-run`,
  or MCP `confirm: true` unless the user explicitly approved that exact
  selection. Show the dry run first.
- Scanners return `GroupResult`s; add a new one in `src/scanners/` and register
  it in `MODULES` in `src/scan.ts`. Put path knowledge in `src/core/kb.ts`,
  not inline. Mark judgment-call findings `autoSelect: false` and
  information-only ones `action: "report"`.
- Findings describe this machine. Reports and logs go to `~/.mac-cleaner`;
  do not commit scan output, and keep `data/` ignored.
- The parent folder's `CLAUDE.md` (candy projects) applies: new tools get
  their own folder, not a subfolder here.
