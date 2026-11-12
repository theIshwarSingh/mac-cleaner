import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Finding, GroupResult, ModuleId } from "./types.js";

const execFileP = promisify(execFile);

export const HOME = os.homedir();
export const UID = typeof process.getuid === "function" ? process.getuid() : 501;

export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

export function tildify(p: string): string {
  return p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

export async function listDir(p: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Run a command, never throw; returns stdout/stderr/code. */
export async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

/** Disk usage in bytes using native du (fast, follows no symlinks, stays on one filesystem). */
export async function duBytes(p: string): Promise<number> {
  const { stdout } = await run("/usr/bin/du", ["-skx", p], { timeoutMs: 300_000 });
  const m = /^(\d+)/.exec(stdout.trim());
  return m ? Number(m[1]) * 1024 : 0;
}

/** Sizes for many paths in one du call. Returns a map path -> bytes. */
export async function duMany(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (paths.length === 0) return out;
  const chunk = 200;
  for (let i = 0; i < paths.length; i += chunk) {
    const slice = paths.slice(i, i + chunk);
    const { stdout } = await run("/usr/bin/du", ["-skx", ...slice], { timeoutMs: 600_000 });
    for (const line of stdout.split("\n")) {
      const m = /^(\d+)\t(.*)$/.exec(line);
      if (m) out.set(m[2], Number(m[1]) * 1024);
    }
  }
  return out;
}

export async function sizeOf(p: string, deep = true): Promise<number> {
  const st = await statSafe(p);
  if (!st) return 0;
  if (st.isDirectory()) return deep ? duBytes(p) : 0;
  return st.size;
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function findingId(module: ModuleId, group: string, p: string): string {
  return createHash("sha1").update(`${module}\0${group}\0${p}`).digest("hex").slice(0, 16);
}

export function makeFinding(
  f: Omit<Finding, "id">,
): Finding {
  return { id: findingId(f.module, f.group, f.path), ...f };
}

export function group(
  id: string,
  title: string,
  description: string,
  findings: Finding[],
  warning?: string,
): GroupResult {
  findings.sort((a, b) => b.bytes - a.bytes);
  return {
    id,
    title,
    description,
    findings,
    bytes: findings.reduce((s, f) => s + f.bytes, 0),
    ...(warning ? { warning } : {}),
  };
}

/** Limited-concurrency map. */
export async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function daysAgo(d: Date | number | null | undefined): number | null {
  if (d == null) return null;
  const t = typeof d === "number" ? d : d.getTime();
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** Read a plist (binary or XML) as JSON via plutil. Returns null when unreadable. */
export async function readPlist<T = Record<string, unknown>>(p: string): Promise<T | null> {
  const { code, stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", p], {
    timeoutMs: 20_000,
  });
  if (code !== 0 || !stdout.trim()) return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export async function isProcessRunning(name: string): Promise<boolean> {
  const { code } = await run("/usr/bin/pgrep", ["-x", name]);
  return code === 0;
}

/** Spotlight query helper. Returns absolute paths. */
export async function mdfind(query: string, onlyIn?: string[]): Promise<string[]> {
  const args: string[] = [];
  for (const dir of onlyIn ?? []) args.push("-onlyin", dir);
  args.push(query);
  const { stdout } = await run("/usr/bin/mdfind", args, { timeoutMs: 180_000 });
  return stdout.split("\n").filter(Boolean);
}

/** Read one Spotlight attribute (raw mdls output, e.g. for kMDItemLastUsedDate). */
export async function mdlsRaw(p: string, attr: string): Promise<string | null> {
  const { code, stdout } = await run("/usr/bin/mdls", ["-raw", "-name", attr, "--", p], { timeoutMs: 20_000 });
  if (code !== 0) return null;
  const v = stdout.trim();
  return v === "(null)" ? null : v;
}

export const DATA_DIR = path.join(HOME, ".mac-cleaner");
export async function ensureDataDir(): Promise<string> {
  await fs.mkdir(path.join(DATA_DIR, "logs"), { recursive: true });
  return DATA_DIR;
}
