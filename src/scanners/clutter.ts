import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { LARGE_FILE_BYTES, OLD_FILE_DAYS } from "../core/kb.js";
import type { Finding, GroupScanner } from "../core/types.js";
import { HOME, daysAgo, group, listDir, makeFinding, mdfind, mdlsRaw, pmap, statSafe } from "../core/util.js";

const MOD = "clutter" as const;

const SKIP_DIRS = new Set(["Library", ".Trash", "node_modules", ".git", ".cache", ".npm", ".cargo", ".rustup", ".gradle", "Applications", ".pyenv", ".nvm", ".docker", ".vscode", ".Trashes"]);

/** Large & Old Files: >100 MB not touched in 6 months, outside Library and dev caches. */
export const largeAndOld: GroupScanner = async (opts) => {
  opts.onProgress?.("Large & old files");
  const g = "large-old";
  const hits = await mdfind(`kMDItemFSSize > ${LARGE_FILE_BYTES} && kMDItemContentModificationDate < $time.now(-${OLD_FILE_DAYS * 86400})`, [HOME]);
  const files = hits.filter((p) => !p.slice(HOME.length + 1).split("/").some((seg) => SKIP_DIRS.has(seg)) && !p.includes("/Library/"));
  const findings = (await pmap(files, 8, async (p) => {
    const st = await statSafe(p);
    if (!st || !st.isFile()) return null;
    const used = await mdlsRaw(p, "kMDItemLastUsedDate");
    const usedDays = used ? daysAgo(new Date(used)) : null;
    if (usedDays != null && usedDays < OLD_FILE_DAYS) return null;
    return makeFinding({ module: MOD, group: g, title: path.basename(p), path: p, kind: "file", bytes: st.size, autoSelect: false, action: "trash", note: `Modified ${daysAgo(st.mtimeMs)} days ago${used ? `, last opened ${usedDays} days ago` : ", never opened"}`, meta: { modifiedDays: daysAgo(st.mtimeMs), lastUsedDays: usedDays, ext: path.extname(p).toLowerCase() } });
  })).filter((f): f is Finding => Boolean(f));
  return group(g, "Large & Old Files", `Files over ${Math.round(LARGE_FILE_BYTES / 1e6)} MB untouched for ${OLD_FILE_DAYS}+ days. Nothing is pre-selected: these are your documents.`, findings);
};

async function sha256(p: string, limit?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(p, limit ? { start: 0, end: limit - 1 } : {});
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function walkFiles(root: string, maxDepth: number): Promise<{ p: string; size: number; mtime: number }[]> {
  const out: { p: string; size: number; mtime: number }[] = [];
  const rec = async (dir: string, depth: number) => {
    for (const e of await listDir(dir)) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.endsWith(".app") && !e.name.endsWith(".photoslibrary")) await rec(p, depth + 1);
      } else if (e.isFile()) {
        const st = await statSafe(p);
        if (st) out.push({ p, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  await rec(root, 0);
  return out;
}

/** Duplicates: identical files (size, then partial, then full hash) in Downloads, Desktop and Documents. */
export const duplicates: GroupScanner = async (opts) => {
  opts.onProgress?.("Duplicate files");
  const g = "duplicates";
  if (opts.slow === false) return group(g, "Duplicates", "Identical files.", [], "Skipped (slow scan disabled).");
  const roots = ["Downloads", "Desktop", "Documents"].map((d) => path.join(HOME, d));
  const files = (await Promise.all(roots.map((r) => walkFiles(r, 4)))).flat().filter((f) => f.size >= 64 * 1024);
  const bySize = new Map<number, typeof files>();
  for (const f of files) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  const groups = [...bySize.values()].filter((l) => l.length > 1);
  const findings: Finding[] = [];
  await pmap(groups, 4, async (list) => {
    const byHead = new Map<string, typeof list>();
    for (const f of list) {
      const h = await sha256(f.p, 64 * 1024).catch(() => null);
      if (h) byHead.set(h, [...(byHead.get(h) ?? []), f]);
    }
    for (const sub of byHead.values()) {
      if (sub.length < 2) continue;
      const byFull = new Map<string, typeof sub>();
      for (const f of sub) {
        const h = await sha256(f.p).catch(() => null);
        if (h) byFull.set(h, [...(byFull.get(h) ?? []), f]);
      }
      for (const [hash, dupes] of byFull) {
        if (dupes.length < 2) continue;
        dupes.sort((a, b) => a.mtime - b.mtime); // keep the oldest copy
        const keep = dupes[0];
        for (const d of dupes.slice(1)) {
          findings.push(makeFinding({ module: MOD, group: g, title: path.basename(d.p), path: d.p, kind: "file", bytes: d.size, autoSelect: d.p.startsWith(path.join(HOME, "Downloads")), action: "trash", note: `Duplicate of ${d.p === keep.p ? "" : keep.p}`, meta: { keep: keep.p, hash: hash.slice(0, 12) } }));
        }
      }
    }
  });
  return group(g, "Duplicates", "Byte-identical copies in Downloads, Desktop and Documents. The oldest copy is kept; duplicates inside Downloads are pre-selected.", findings);
};

/** Downloads grouped by where they came from (kMDItemWhereFroms), like CleanMyMac's Safari / Chrome / Slack downloads groups. */
export const downloads: GroupScanner = async (opts) => {
  opts.onProgress?.("Downloads by source");
  const g = "downloads";
  const dl = path.join(HOME, "Downloads");
  const entries = (await listDir(dl)).filter((e) => !e.name.startsWith("."));
  const findings = (await pmap(entries, 8, async (e) => {
    const p = path.join(dl, e.name);
    const st = await statSafe(p);
    if (!st) return null;
    const raw = await mdlsRaw(p, "kMDItemWhereFroms");
    let source = "Other";
    if (raw) {
      const url = /"(https?:\/\/[^"]+)"/.exec(raw)?.[1];
      try { source = url ? new URL(url).hostname.replace(/^www\./, "") : "Other"; } catch { source = "Other"; }
      if (/slack\.com$/.test(source)) source = "Slack";
      if (/(^|\.)(googleusercontent|google)\.com$/.test(source)) source = "Google";
    }
    const bytes = e.isDirectory() ? (await import("../core/util.js")).duBytes(p) : Promise.resolve(st.size);
    const age = daysAgo(st.mtimeMs) ?? 0;
    return makeFinding({ module: MOD, group: g, title: `${e.name}`, path: p, kind: e.isDirectory() ? "directory" : "file", bytes: await bytes, autoSelect: false, action: "trash", note: `${source}, ${age} days old`, meta: { source, ageDays: age } });
  })).filter((f): f is Finding => Boolean(f));
  return group(g, "Downloads", "Everything in ~/Downloads with its origin (from the quarantine metadata). Sort by source in the UI.", findings);
};

export const CLUTTER_SCANNERS: GroupScanner[] = [largeAndOld, duplicates, downloads];
export { fs as _fs };
