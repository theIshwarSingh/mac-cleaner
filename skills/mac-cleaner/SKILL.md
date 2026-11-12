---
name: mac-cleaner
description: Clean up this Mac like CleanMyMac. Scan for system junk, caches, logs, Xcode junk, mail attachments, trash, browser privacy traces, app leftovers, unused apps and DMGs, duplicates, large old files and downloads; run maintenance tasks; show health and a Space Lens size tree; uninstall apps with their leftovers. Use when the user says "clean my mac", "free up space", "what is taking space", "uninstall X completely", "clear caches", "remove leftovers", "privacy cleanup", "flush dns", "free up ram", or asks why the disk is full.
---

# mac-cleaner

Open CleanMyMac-style cleaner for macOS. TypeScript on Node 22, lives in
`candy projects/mac-cleaner`. Reports and logs go to `~/.mac-cleaner`, never
into the repo.

## How to drive it

Prefer the MCP tools when the `mac-cleaner` server is connected
(`scan`, `findings`, `clean`, `apps`, `uninstall`, `health`, `space_lens`,
`maintenance`). Otherwise use the CLI from the project folder:

```bash
cd "candy projects/mac-cleaner"
npx tsx src/cli.ts scan --fast            # all five modules, skip slow hashing
npx tsx src/cli.ts scan -m cleanup -v     # one module with per-item ids
npx tsx src/cli.ts list                   # groups in the last report
npx tsx src/cli.ts list --group logs      # items of one group
npx tsx src/cli.ts clean --groups user-caches,logs       # DRY RUN
npx tsx src/cli.ts clean --groups user-caches,logs --yes # move to Trash
npx tsx src/cli.ts uninstall "Some App"   # plan; add --yes to remove
npx tsx src/cli.ts perf list / perf run flush-dns --dry-run
npx tsx src/cli.ts health / space ~ --depth 2
npx tsx src/cli.ts serve --open           # web UI on http://127.0.0.1:4747
```

Modules: `cleanup`, `protection`, `performance`, `applications`, `clutter`.
Group ids print with `list`; finding ids are stable across scans.

## Rules

1. Scan first, then show the user the summary with sizes before anything else.
2. Never remove without a dry run the user has seen. `clean`, `uninstall`
   and `maintenance` are dry runs until `--yes` / `confirm: true`. Get an
   explicit yes for the specific groups or ids, then confirm with the same
   selection. Do not widen the selection between dry run and real run.
3. Default is move-to-Trash. Use `--permanent` only when the user asks and
   understands it cannot be undone. Trash bins and browser databases are
   always permanent.
4. Items marked `report-only` (saved passwords, permissions, unused apps,
   language files, universal binaries) are information. Explain them, do not
   try to delete them another way.
5. Root-owned items are printed as `sudo rm -rf ...` commands. Show the
   command and let the user run it, or pass `--sudo` only in an interactive
   terminal the user controls. The MCP server and web UI never use sudo.
6. Quit the browser before cleaning its history or cookies; findings say
   when the browser is running.
7. If a group warns about Full Disk Access, say so: Mail, Safari, TCC and
   Time Machine data stay invisible until the terminal app gets FDA in
   System Settings > Privacy & Security.
8. When unsure whether a folder is junk (Leftover Files, Downloads,
   Large & Old, Duplicates), list it for the user instead of pre-selecting.

## What maps to what in CleanMyMac 5

| CleanMyMac 5 | mac-cleaner |
| --- | --- |
| Smart Care | `scan` (all modules) |
| Cleanup: System Junk, Mail Attachments, Trash Bins | `cleanup` module groups `user-caches`, `system-caches`, `logs`, `xcode-junk`, `ios-backups`, `broken-login-items`, `broken-preferences`, `system-misc`, `language-files`, `universal-binaries`, `mail-attachments`, `trash-bins` |
| Protection: Privacy, Application Permissions | `protection`: `safari`, `chrome`, `firefox`, `recent-items`, `app-permissions` |
| Performance: Maintenance, Login Items | `performance`: `maintenance` (`perf run`), `login-items` |
| Applications: Uninstaller, Leftovers, Unused DMGs, Updater | `applications`: `leftovers`, `installers`, `unused-apps`, `updates`; `uninstall <app>` |
| My Clutter: Large & Old, Duplicates, Downloads | `clutter`: `large-old`, `duplicates`, `downloads` |
| Space Lens | `space [path]` |
| Menu-bar health monitor | `health` |

Malware removal and real-time protection are out of scope on purpose.
