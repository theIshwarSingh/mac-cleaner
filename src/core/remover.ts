import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, HOME, UID, ensureDataDir, exists, run, statSafe } from "./util.js";
import type { CleanReport, CleanResultItem, Finding } from "./types.js";

/**
 * Mirrors CleanMyMac's CleaningCore removers: MoveToTrashFileRemover (default),
 * FileRemover (permanent) and PrivilegedFileRemover (we print the sudo command
 * instead of shipping a privileged helper).
 */
export interface CleanOptions {
  dryRun?: boolean;
  /** Delete instead of moving to Trash. Trash-bin findings are always permanent. */
  permanent?: boolean;
  /** Run root-only removals through sudo (interactive terminal only). */
  sudo?: boolean;
  onProgress?: (item: CleanResultItem) => void;
}

function trashDirFor(p: string): string {
  if (p.startsWith("/Volumes/")) {
    const vol = p.split("/").slice(0, 3).join("/");
    return path.join(vol, ".Trashes", String(UID));
  }
  return path.join(HOME, ".Trash");
}

async function uniqueTrashName(trash: string, name: string): Promise<string> {
  let candidate = path.join(trash, name);
  if (!(await exists(candidate))) return candidate;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  candidate = path.join(trash, `${base} ${stamp}${ext}`);
  let n = 2;
  while (await exists(candidate)) candidate = path.join(trash, `${base} ${stamp} ${n++}${ext}`);
  return candidate;
}

export async function moveToTrash(p: string): Promise<void> {
  const trash = trashDirFor(p);
  await fs.mkdir(trash, { recursive: true });
  const dest = await uniqueTrashName(trash, path.basename(p));
  try {
    await fs.rename(p, dest);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EXDEV: another volume (copy+delete would double the space use).
    // EACCES/EPERM: /Applications bundles owned by root, sandbox containers and
    // other protected folders. Finder can trash all of these and asks the user
    // for authorization itself when needed.
    if (e.code !== "EXDEV" && e.code !== "EACCES" && e.code !== "EPERM") throw err;
    const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(p)}`;
    const r = await run("/usr/bin/osascript", ["-e", script], { timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`${e.code}; Finder could not trash it either: ${r.stderr.trim() || "no reason given"}`);
  }
}

export async function deletePermanently(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 2 });
  if (await exists(p)) {
    // Locked file (uchg). Clear flags once and retry.
    await run("/usr/bin/chflags", ["-R", "nouchg", p]);
    await fs.rm(p, { recursive: true, force: true });
  }
}

/** Empty a directory without removing the directory itself (Trash bins). */
async function emptyDirectory(p: string): Promise<number> {
  let bytes = 0;
  const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(p, e.name);
    const st = await statSafe(full);
    if (st && !st.isDirectory()) bytes += st.size;
    await deletePermanently(full);
  }
  return bytes;
}

function isUnsafePath(p: string): string | null {
  const resolved = path.resolve(p);
  const forbidden = [
    "/", "/System", "/Library", "/Users", "/Applications", "/private", "/usr", "/bin", "/sbin", "/etc", "/var",
    HOME, path.join(HOME, "Library"), path.join(HOME, "Documents"), path.join(HOME, "Desktop"),
    path.join(HOME, "Downloads"), path.join(HOME, "Pictures"), path.join(HOME, "Movies"), path.join(HOME, "Music"),
    path.join(HOME, "Library/Application Support"), path.join(HOME, "Library/Caches"),
    path.join(HOME, "Library/Preferences"), path.join(HOME, "Library/Containers"), path.join(HOME, "Library/Mail"),
  ];
  if (forbidden.includes(resolved)) return `refusing to remove protected location ${resolved}`;
  if (resolved.startsWith("/System/")) return "inside /System (SIP)";
  if (!resolved.startsWith("/")) return "not an absolute path";
  return null;
}

export async function cleanFindings(findings: Finding[], opts: CleanOptions = {}): Promise<CleanReport> {
  const startedAt = new Date().toISOString();
  const items: CleanResultItem[] = [];
  let bytesFreed = 0;
  const emit = (it: CleanResultItem) => {
    items.push(it);
    opts.onProgress?.(it);
  };

  for (const f of findings) {
    const base = { id: f.id, path: f.path, bytes: f.bytes };
    if (f.action === "report") {
      emit({ ...base, status: "skipped", detail: f.note ?? "report-only item" });
      continue;
    }
    if (f.action === "command") {
      emit({ ...base, status: "skipped", detail: "task items run through `perf run`, not clean" });
      continue;
    }
    const unsafe = isUnsafePath(f.path);
    if (unsafe) {
      emit({ ...base, status: "skipped", detail: unsafe });
      continue;
    }
    if (!(await exists(f.path))) {
      emit({ ...base, status: "skipped", detail: "already gone" });
      continue;
    }
    if (opts.dryRun) {
      emit({ ...base, status: "dry-run" });
      continue;
    }
    const isTrashBin = f.group === "trash-bins";
    try {
      if (f.needsRoot) {
        if (!opts.sudo) {
          emit({ ...base, status: "needs-root", detail: `sudo rm -rf ${shellQuote(f.path)}` });
          continue;
        }
        const r = await run("/usr/bin/sudo", ["rm", "-rf", "--", f.path], { timeoutMs: 600_000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `sudo rm exited ${r.code}`);
        bytesFreed += f.bytes;
        emit({ ...base, status: "removed" });
      } else if (isTrashBin) {
        await emptyDirectory(f.path);
        bytesFreed += f.bytes;
        emit({ ...base, status: "removed" });
      } else if (opts.permanent || f.action === "delete") {
        await deletePermanently(f.path);
        bytesFreed += f.bytes;
        emit({ ...base, status: "removed" });
      } else {
        await moveToTrash(f.path);
        bytesFreed += f.bytes;
        emit({ ...base, status: "trashed" });
      }
    } catch (err) {
      emit({ ...base, status: "failed", detail: (err as Error).message });
    }
  }

  const report: CleanReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: Boolean(opts.dryRun),
    permanent: Boolean(opts.permanent),
    items,
    bytesFreed,
  };
  if (!opts.dryRun) {
    await ensureDataDir();
    const file = path.join(DATA_DIR, "logs", `clean-${startedAt.replace(/[:.]/g, "-")}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2));
  }
  return report;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
