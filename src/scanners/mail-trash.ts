import { promises as fs } from "node:fs";
import path from "node:path";
import type { Finding, GroupScanner } from "../core/types.js";
import { HOME, UID, duBytes, duMany, exists, group, listDir, makeFinding, statSafe } from "../core/util.js";

const MOD = "cleanup" as const;

/** Mail Attachments: Apple Mail keeps a local copy of every attachment plus a "Mail Downloads" folder. */
export const mailAttachments: GroupScanner = async (opts) => {
  opts.onProgress?.("Mail attachments");
  const g = "mail-attachments";
  const items: Finding[] = [];
  let warning: string | undefined;
  const mailRoot = path.join(HOME, "Library/Mail");
  let versions: string[] = [];
  try {
    versions = (await fs.readdir(mailRoot)).filter((n) => /^V\d+$/.test(n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") warning = "Needs Full Disk Access to read ~/Library/Mail.";
  }
  // Attachments live under <V>/<account>/<mailbox>.mbox/<uuid>/Data/**/Attachments. One find per version dir.
  for (const v of versions) {
    const vdir = path.join(mailRoot, v);
    const { run } = await import("../core/util.js");
    const res = await run("/usr/bin/find", [vdir, "-type", "d", "-name", "Attachments", "-not", "-path", "*/MailData/*"], { timeoutMs: 300_000 });
    const dirs = res.stdout.split("\n").filter(Boolean);
    const sizes = opts.sizes === false ? new Map<string, number>() : await duMany(dirs);
    // Group per account/mailbox to keep the list readable.
    const perBox = new Map<string, { paths: string[]; bytes: number }>();
    for (const d of dirs) {
      const rel = path.relative(vdir, d);
      const box = rel.split("/").slice(0, 2).join("/");
      const entry = perBox.get(box) ?? { paths: [], bytes: 0 };
      entry.paths.push(d);
      entry.bytes += sizes.get(d) ?? 0;
      perBox.set(box, entry);
    }
    for (const [box, e] of perBox) {
      for (const d of e.paths) {
        const b = sizes.get(d) ?? 0;
        if (b === 0) continue;
        items.push(makeFinding({ module: MOD, group: g, title: `${box} attachments`, path: d, kind: "directory", bytes: b, autoSelect: false, action: "trash", note: "Mail re-downloads attachments from the server when you open the message. Quit Mail first." }));
      }
    }
  }
  const dl = path.join(HOME, "Library/Containers/com.apple.mail/Data/Library/Mail Downloads");
  if (await exists(dl)) {
    for (const e of await listDir(dl)) {
      const p = path.join(dl, e.name);
      items.push(makeFinding({ module: MOD, group: g, title: `Mail Downloads: ${e.name}`, path: p, kind: e.isDirectory() ? "directory" : "file", bytes: e.isDirectory() ? await duBytes(p) : (await statSafe(p))?.size ?? 0, autoSelect: true, action: "trash", note: "Attachments you opened from Mail (Quick Look copies)." }));
    }
  }
  return group(g, "Mail Attachments", "Local copies of email attachments. They stay available on the mail server.", items, warning);
};

/** Trash Bins: the user Trash, every mounted volume's .Trashes and Mail's deleted messages. */
export const trashBins: GroupScanner = async (opts) => {
  opts.onProgress?.("Trash bins");
  const g = "trash-bins";
  const items: Finding[] = [];
  const bins: { p: string; title: string }[] = [{ p: path.join(HOME, ".Trash"), title: "Trash" }];
  for (const v of await listDir("/Volumes")) {
    const p = path.join("/Volumes", v.name, ".Trashes", String(UID));
    if (await exists(p)) bins.push({ p, title: `Trash on ${v.name}` });
  }
  for (const b of bins) {
    const entries = (await listDir(b.p)).filter((e) => !e.name.startsWith("."));
    if (entries.length === 0) continue;
    const bytes = opts.sizes === false ? 0 : await duBytes(b.p);
    items.push(makeFinding({ module: MOD, group: g, title: `${b.title} (${entries.length} items)`, path: b.p, kind: "directory", bytes, autoSelect: true, action: "delete", note: "Emptying is permanent.", meta: { count: entries.length } }));
  }
  // Mail trash mailboxes: report-only. Deleting the .mbox breaks Mail's index; use Mailbox > Erase Deleted Items.
  const mailRoot = path.join(HOME, "Library/Mail");
  const versions = (await listDir(mailRoot)).filter((e) => /^V\d+$/.test(e.name));
  for (const v of versions) {
    for (const acct of await listDir(path.join(mailRoot, v.name))) {
      if (!acct.isDirectory() || acct.name === "MailData") continue;
      for (const name of ["Deleted Messages.mbox", "Trash.mbox", "Deleted Items.mbox"]) {
        const p = path.join(mailRoot, v.name, acct.name, name);
        if (!(await exists(p))) continue;
        const bytes = opts.sizes === false ? 0 : await duBytes(p);
        if (bytes < 1024 * 1024) continue;
        items.push(makeFinding({ module: MOD, group: g, title: `Mail trash: ${acct.name.slice(0, 8)}… ${name}`, path: p, kind: "directory", bytes, autoSelect: false, action: "report", note: "Empty from Mail: Mailbox > Erase Deleted Items. Deleting the mailbox file directly corrupts Mail's index." }));
      }
    }
  }
  return group(g, "Trash Bins", "Your Trash, the Trash on every external volume, and Mail's deleted messages.", items);
};
