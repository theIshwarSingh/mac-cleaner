import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ELECTRON_CACHE_DIRS,
  HARDCODED_CACHES,
  OLD_LOG_DAYS,
  PROTECTED_CONTAINERS,
  PROTECTED_USER_CACHES,
  XCODE_JUNK,
  CRASH_LOG_EXTENSIONS,
} from "../core/kb.js";
import type { Finding, GroupResult, GroupScanner, ScanOptions } from "../core/types.js";
import { HOME, daysAgo, duMany, exists, expandHome, group, listDir, makeFinding, pmap, readPlist, run, statSafe } from "../core/util.js";

const MOD = "cleanup" as const;

async function sized(opts: ScanOptions, items: Omit<Finding, "id" | "bytes">[]): Promise<Finding[]> {
  const sizes = opts.sizes === false ? new Map<string, number>() : await duMany(items.map((i) => i.path));
  const out: Finding[] = [];
  for (const i of items) {
    const bytes = sizes.get(i.path) ?? (await statSafe(i.path))?.size ?? 0;
    out.push(makeFinding({ ...i, bytes }));
  }
  return out;
}

/** User Cache Files: ~/Library/Caches, sandbox container caches, Darwin user cache dir, Electron caches, hard-coded app caches. */
export const userCaches: GroupScanner = async (opts) => {
  opts.onProgress?.("User cache files");
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const g = "user-caches";

  for (const e of await listDir(path.join(HOME, "Library/Caches"))) {
    if (e.name.startsWith(".") || PROTECTED_USER_CACHES.has(e.name)) continue;
    items.push({ module: MOD, group: g, title: e.name, path: path.join(HOME, "Library/Caches", e.name), kind: e.isDirectory() ? "directory" : "file", autoSelect: true, action: "trash" });
  }

  for (const c of await listDir(path.join(HOME, "Library/Containers"))) {
    if (!c.isDirectory() || PROTECTED_CONTAINERS.has(c.name)) continue;
    const p = path.join(HOME, "Library/Containers", c.name, "Data/Library/Caches");
    if (await exists(p)) items.push({ module: MOD, group: g, title: `${c.name} (sandbox)`, path: p, kind: "directory", autoSelect: true, action: "trash", note: "Contents of the sandboxed app's cache folder" });
  }

  const darwin = (await run("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"])).stdout.trim();
  if (darwin) {
    for (const e of await listDir(darwin)) {
      if (e.name.startsWith(".") || e.name === "com.apple.DeveloperTools" || e.name.startsWith("com.apple.")) continue;
      items.push({ module: MOD, group: g, title: `${e.name} (Darwin user cache)`, path: path.join(darwin, e.name), kind: e.isDirectory() ? "directory" : "file", autoSelect: true, action: "delete", note: "$TMPDIR/../C, rebuilt automatically" });
    }
  }

  // Electron apps keep Chromium caches inside Application Support/<App>/.
  for (const app of await listDir(path.join(HOME, "Library/Application Support"))) {
    if (!app.isDirectory()) continue;
    for (const dir of ELECTRON_CACHE_DIRS) {
      const p = path.join(HOME, "Library/Application Support", app.name, dir);
      if (await exists(p)) items.push({ module: MOD, group: g, title: `${app.name} / ${dir}`, path: p, kind: "directory", autoSelect: true, action: "trash", note: "Electron (Chromium) cache" });
    }
    // Chromium profiles: Application Support/Google/Chrome/<Profile>/Cache etc. live one level deeper.
    if (["Google", "BraveSoftware", "Microsoft Edge", "Arc", "Vivaldi", "Chromium"].includes(app.name)) {
      const inner = app.name === "Google" ? path.join(HOME, "Library/Application Support/Google/Chrome") : path.join(HOME, "Library/Application Support", app.name, app.name === "BraveSoftware" ? "Brave-Browser" : "");
      for (const prof of await listDir(inner)) {
        if (!prof.isDirectory()) continue;
        for (const dir of ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"]) {
          const p = path.join(inner, prof.name, dir);
          if (await exists(p)) items.push({ module: MOD, group: g, title: `${app.name} ${prof.name} / ${dir}`, path: p, kind: "directory", autoSelect: true, action: "trash", note: "Browser cache. Quit the browser first." });
        }
      }
    }
  }

  for (const h of HARDCODED_CACHES) {
    const p = expandHome(h.path);
    if (await exists(p)) items.push({ module: MOD, group: g, title: h.title, path: p, kind: "directory", autoSelect: h.auto !== false, action: "trash", note: h.auto === false ? "Developer cache: safe to remove, slow to re-download. Not pre-selected." : undefined });
  }

  return group(g, "User Cache Files", "Caches written by your applications. Safe to remove; apps rebuild them, which can make the first launch slower.", await sized(opts, items));
};

/** System Cache Files: /Library/Caches (root-owned entries need sudo). */
export const systemCaches: GroupScanner = async (opts) => {
  opts.onProgress?.("System cache files");
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const g = "system-caches";
  for (const e of await listDir("/Library/Caches")) {
    if (e.name.startsWith(".") || e.name === "com.apple.iconservices.store") continue;
    const p = path.join("/Library/Caches", e.name);
    const st = await statSafe(p);
    const mine = st?.uid === (process.getuid?.() ?? -1);
    items.push({ module: MOD, group: g, title: e.name, path: p, kind: e.isDirectory() ? "directory" : "file", autoSelect: false, action: mine ? "trash" : "delete", needsRoot: !mine });
  }
  return group(g, "System Cache Files", "Caches in /Library/Caches shared by all users. Most are root-owned, so removal needs sudo.", await sized(opts, items));
};

/** User & system logs, crash reports, diagnostics. */
export const logs: GroupScanner = async (opts) => {
  opts.onProgress?.("Log files");
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const g = "logs";
  const userLogs = path.join(HOME, "Library/Logs");
  for (const e of await listDir(userLogs)) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(userLogs, e.name);
    if (e.name === "DiagnosticReports") {
      for (const r of await listDir(p)) {
        if (!CRASH_LOG_EXTENSIONS.has(path.extname(r.name)) && !r.name.endsWith(".ips")) continue;
        items.push({ module: MOD, group: g, title: `Crash report: ${r.name}`, path: path.join(p, r.name), kind: "file", autoSelect: true, action: "trash" });
      }
      continue;
    }
    items.push({ module: MOD, group: g, title: e.name, path: p, kind: e.isDirectory() ? "directory" : "file", autoSelect: true, action: "trash" });
  }
  for (const c of await listDir(path.join(HOME, "Library/Containers"))) {
    if (!c.isDirectory()) continue;
    const p = path.join(HOME, "Library/Containers", c.name, "Data/Library/Logs");
    if (await exists(p)) items.push({ module: MOD, group: g, title: `${c.name} (sandbox logs)`, path: p, kind: "directory", autoSelect: true, action: "trash" });
  }
  // System logs: /Library/Logs and /var/log rotated files (root).
  for (const e of await listDir("/Library/Logs")) {
    if (e.name.startsWith(".")) continue;
    const p = path.join("/Library/Logs", e.name);
    const st = await statSafe(p);
    items.push({ module: MOD, group: g, title: `System: ${e.name}`, path: p, kind: e.isDirectory() ? "directory" : "file", autoSelect: false, action: "delete", needsRoot: st?.uid !== process.getuid?.() });
  }
  for (const e of await listDir("/private/var/log")) {
    const old = /\.(\d+|gz|bz2|\d+\.gz)$/.test(e.name) || ["fsck_apfs.log", "fsck_hfs.log", "install.log", "system.log", "wifi.log"].some((n) => e.name.startsWith(n) && e.name !== n);
    if (!old) continue;
    items.push({ module: MOD, group: g, title: `/var/log/${e.name}`, path: path.join("/private/var/log", e.name), kind: "file", autoSelect: false, action: "delete", needsRoot: true, note: "Rotated system log" });
  }
  const sized1 = await sized(opts, items);
  // Keep fresh logs (< OLD_LOG_DAYS) out of auto-select; they are useful for debugging.
  await Promise.all(sized1.map(async (f) => {
    const st = await statSafe(f.path);
    const age = daysAgo(st?.mtimeMs ?? null);
    if (age != null && age < OLD_LOG_DAYS && f.kind === "file") f.autoSelect = false;
  }));
  return group(g, "Log Files", "Application and system logs plus crash reports. Only useful when debugging a problem.", sized1);
};

export const xcodeJunk: GroupScanner = async (opts) => {
  opts.onProgress?.("Xcode junk");
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const g = "xcode-junk";
  for (const x of XCODE_JUNK) {
    const p = path.join(HOME, x.rel);
    if (!(await exists(p))) continue;
    if (x.rel.endsWith("DeviceSupport") || x.rel.endsWith("DerivedData") || x.rel.endsWith("Archives")) {
      for (const e of await listDir(p)) {
        if (e.name.startsWith(".") || !e.isDirectory()) continue;
        items.push({ module: MOD, group: g, title: `${x.title}: ${e.name}`, path: path.join(p, e.name), kind: "directory", autoSelect: x.auto, action: "trash", note: x.note });
      }
    } else {
      items.push({ module: MOD, group: g, title: x.title, path: p, kind: "directory", autoSelect: x.auto, action: "trash", note: x.note });
    }
  }
  // Simulator runtimes and unavailable devices (CMSystemJunkScanIdentifierXcodeSimulators / XcodeDownloadedRuntimes).
  const simctl = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl";
  if (await exists(simctl)) {
    const dev = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"], { timeoutMs: 60_000 });
    try {
      const j = JSON.parse(dev.stdout) as { devices: Record<string, { udid: string; name: string; isAvailable: boolean; dataPath?: string; state: string }[]> };
      for (const [rt, list] of Object.entries(j.devices)) {
        for (const d of list) {
          const dp = d.dataPath ?? path.join(HOME, "Library/Developer/CoreSimulator/Devices", d.udid);
          if (!d.isAvailable) items.push({ module: MOD, group: g, title: `Unavailable simulator ${d.name} (${rt.split(".").pop()})`, path: path.dirname(dp.endsWith("/data") ? dp : dp + "/data"), kind: "directory", autoSelect: true, action: "trash", note: "Runtime is gone; delete with `xcrun simctl delete unavailable`" });
        }
      }
    } catch { /* no simulators */ }
    const rts = await run("/usr/bin/xcrun", ["simctl", "runtime", "list", "-j"], { timeoutMs: 60_000 });
    try {
      const j = JSON.parse(rts.stdout) as Record<string, { identifier: string; version: string; build: string; platformIdentifier: string; sizeBytes?: number; state: string; path?: string }>;
      for (const r of Object.values(j)) {
        if (r.path) items.push({ module: MOD, group: g, title: `Simulator runtime ${r.platformIdentifier.split(".").pop()} ${r.version}`, path: r.path, kind: "directory", autoSelect: false, action: "report", note: `Remove with: xcrun simctl runtime delete ${r.identifier}` });
      }
    } catch { /* ignore */ }
  }
  return group(g, "Xcode Junk", "Derived data, device support symbols, simulator leftovers and caches that Xcode regenerates on demand.", await sized(opts, items));
};

/** iOS/iPadOS device backups kept by Finder/iTunes (MobileSync). Needs Full Disk Access to read. */
export const iosBackups: GroupScanner = async (opts) => {
  opts.onProgress?.("iOS device backups");
  const g = "ios-backups";
  const base = path.join(HOME, "Library/Application Support/MobileSync/Backup");
  const items: Omit<Finding, "id" | "bytes">[] = [];
  let warning: string | undefined;
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(base, e.name);
      const info = await readPlist<{ "Device Name"?: string; "Last Backup Date"?: string; "Product Name"?: string }>(path.join(p, "Info.plist"));
      items.push({ module: MOD, group: g, title: info?.["Device Name"] ? `${info["Device Name"]} (${info["Product Name"] ?? "device"})` : e.name, path: p, kind: "directory", autoSelect: false, action: "trash", note: info?.["Last Backup Date"] ? `Last backup ${info["Last Backup Date"]}` : "Backup date unknown", meta: { lastBackup: info?.["Last Backup Date"] ?? null } });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") warning = "Needs Full Disk Access for this terminal to read MobileSync backups.";
  }
  return group(g, "iOS Device Backups", "Local backups of iPhones and iPads. Remove old ones you no longer need; newer backups stay in Finder.", await sized(opts, items), warning);
};

/** Broken login items / launch agents whose program no longer exists. */
export const brokenLoginItems: GroupScanner = async (opts) => {
  opts.onProgress?.("Broken login items");
  const g = "broken-login-items";
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const dirs: { dir: string; root: boolean }[] = [
    { dir: path.join(HOME, "Library/LaunchAgents"), root: false },
    { dir: "/Library/LaunchAgents", root: true },
    { dir: "/Library/LaunchDaemons", root: true },
  ];
  for (const { dir, root } of dirs) {
    for (const e of await listDir(dir)) {
      if (!e.name.endsWith(".plist")) continue;
      const p = path.join(dir, e.name);
      const pl = await readPlist<{ Program?: string; ProgramArguments?: string[]; Label?: string; BundleProgram?: string }>(p);
      if (!pl) {
        items.push({ module: MOD, group: g, title: e.name, path: p, kind: "file", autoSelect: false, action: "trash", needsRoot: root, note: "Unreadable launchd plist" });
        continue;
      }
      let prog = pl.Program ?? pl.ProgramArguments?.[0] ?? pl.BundleProgram;
      if (!prog) continue;
      if (!prog.startsWith("/")) {
        const which = await run("/usr/bin/which", [prog]);
        if (which.code === 0) continue;
        prog = prog; // relative, non-resolvable
      }
      if (await exists(prog)) continue;
      items.push({ module: MOD, group: g, title: pl.Label ?? e.name, path: p, kind: "file", autoSelect: true, action: "trash", needsRoot: root, note: `Program missing: ${prog}` });
    }
  }
  return group(g, "Broken Login Items", "launchd agents and daemons that still point at programs that were deleted.", await sized(opts, items));
};

/** Preference files that fail plutil -lint. */
export const brokenPreferences: GroupScanner = async (opts) => {
  opts.onProgress?.("Broken preferences");
  const g = "broken-preferences";
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const dir = path.join(HOME, "Library/Preferences");
  const plists = (await listDir(dir)).filter((e) => e.isFile() && e.name.endsWith(".plist")).map((e) => path.join(dir, e.name));
  for (let i = 0; i < plists.length; i += 100) {
    const batch = plists.slice(i, i + 100);
    const { stdout, stderr } = await run("/usr/bin/plutil", ["-lint", ...batch], { timeoutMs: 60_000 });
    for (const line of (stdout + "\n" + stderr).split("\n")) {
      const m = /^(.*\.plist): (.*)$/.exec(line);
      if (!m || m[2] === "OK") continue;
      // TCC-protected plists (Messages, Mail, Safari...) fail plutil with a permission error: not broken, just unreadable.
      if (/permission|not permitted|couldn.t be opened/i.test(m[2])) continue;
      const st = await statSafe(m[1]);
      if (st && st.size === 0) continue; // reported below as empty
      items.push({ module: MOD, group: g, title: path.basename(m[1]), path: m[1], kind: "file", autoSelect: true, action: "trash", note: m[2] });
    }
  }
  // Empty / zero-byte preference files are also junk.
  for (const p of plists) {
    const st = await statSafe(p);
    if (st && st.size === 0) items.push({ module: MOD, group: g, title: path.basename(p), path: p, kind: "file", autoSelect: true, action: "trash", note: "Empty preference file" });
  }
  return group(g, "Broken Preferences", "Preference files that can no longer be parsed. Apps recreate them with defaults.", await sized(opts, items));
};

/** Document versions, deleted users, quarantine logs and other root-level groups. */
export const miscSystemJunk: GroupScanner = async (opts) => {
  opts.onProgress?.("Document versions & deleted users");
  const g = "system-misc";
  const items: Omit<Finding, "id" | "bytes">[] = [];
  if (await exists("/.DocumentRevisions-V100")) items.push({ module: MOD, group: g, title: "Document Versions store", path: "/.DocumentRevisions-V100", kind: "directory", autoSelect: false, action: "report", needsRoot: true, note: "Autosave history for all documents. Size needs sudo du; CleanMyMac prunes per-app revisions via its privileged helper. Reset per app in the Versions browser instead." });
  for (const e of await listDir("/Users/Deleted Users")) {
    if (e.name.startsWith(".")) continue;
    items.push({ module: MOD, group: g, title: `Deleted user: ${e.name}`, path: path.join("/Users/Deleted Users", e.name), kind: "directory", autoSelect: false, action: "delete", needsRoot: true, note: "Home folder image left after removing a user account" });
  }
  for (const n of ["com.apple.LaunchServices.QuarantineEventsV2", "com.apple.LaunchServices.QuarantineEvents"]) {
    const p = path.join(HOME, "Library/Preferences", n);
    if (await exists(p)) items.push({ module: MOD, group: g, title: "Quarantine download history", path: p, kind: "file", autoSelect: false, action: "delete", note: "SQLite log of every downloaded file (privacy)." });
  }
  // App Store download cache
  for (const p of ["/private/var/folders"].map(() => "")) void p;
  const appStoreCache = path.join(HOME, "Library/Caches/com.apple.appstore");
  if (await exists(appStoreCache)) items.push({ module: MOD, group: g, title: "App Store downloads cache", path: appStoreCache, kind: "directory", autoSelect: false, action: "trash" });
  return group(g, "Document Versions & Leftover Accounts", "Deep-system stores that are safe to clear but usually need administrator rights.", await sized(opts, items));
};

/** Language files: report-only inventory of .lproj folders you do not use. */
export const languageFiles: GroupScanner = async (opts) => {
  opts.onProgress?.("Language files");
  const g = "language-files";
  const langsRaw = (await run("/usr/bin/defaults", ["read", "-g", "AppleLanguages"])).stdout;
  const keep = new Set<string>(["en", "Base", "English"]);
  for (const m of langsRaw.matchAll(/"?([a-zA-Z]{2,3})(?:[-_][A-Za-z0-9]+)*"?/g)) keep.add(m[1].toLowerCase());
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const apps = (await listDir("/Applications")).filter((e) => e.name.endsWith(".app"));
  const perApp = await pmap(apps, 6, async (app) => {
    const res = path.join("/Applications", app.name, "Contents/Resources");
    const lprojs = (await listDir(res)).filter((e) => e.isDirectory() && e.name.endsWith(".lproj"));
    const extra = lprojs.filter((l) => {
      const code = l.name.slice(0, -6);
      const short = code.split(/[-_]/)[0].toLowerCase();
      return !keep.has(short) && !keep.has(code);
    });
    return { app: app.name, paths: extra.map((l) => path.join(res, l.name)) };
  });
  const sizes = opts.sizes === false ? new Map<string, number>() : await duMany(perApp.flatMap((p) => p.paths));
  for (const p of perApp) {
    if (p.paths.length === 0) continue;
    const bytes = p.paths.reduce((s, x) => s + (sizes.get(x) ?? 0), 0);
    items.push({ module: MOD, group: g, title: `${p.app.replace(/\.app$/, "")}: ${p.paths.length} unused localizations`, path: path.join("/Applications", p.app), kind: "directory", autoSelect: false, action: "report", note: `Removing .lproj folders from a signed app invalidates its code signature. Report-only. ${bytes} bytes across ${p.paths.length} folders.`, meta: { count: p.paths.length, bytes } });
  }
  const findings = items.map((i) => makeFinding({ ...i, bytes: Number(i.meta?.bytes ?? 0) }));
  return group(g, "Language Files", "Localizations your system language settings never use. Shown for information: stripping them breaks app signatures on modern macOS.", findings);
};

/** Universal binaries: report the size of the slice your CPU does not run. */
export const universalBinaries: GroupScanner = async (opts) => {
  opts.onProgress?.("Universal binaries");
  const g = "universal-binaries";
  const arch = (await run("/usr/bin/uname", ["-m"])).stdout.trim(); // arm64 or x86_64
  const items: Omit<Finding, "id" | "bytes">[] = [];
  const apps = (await listDir("/Applications")).filter((e) => e.name.endsWith(".app"));
  const results = await pmap(apps, 6, async (app) => {
    const appPath = path.join("/Applications", app.name);
    const info = await readPlist<{ CFBundleExecutable?: string }>(path.join(appPath, "Contents/Info.plist"));
    if (!info?.CFBundleExecutable) return null;
    const exe = path.join(appPath, "Contents/MacOS", info.CFBundleExecutable);
    const { code, stdout } = await run("/usr/bin/lipo", ["-detailed_info", exe], { timeoutMs: 20_000 });
    if (code !== 0 || !stdout.includes("Fat header")) return null;
    let foreign = 0;
    const archs: string[] = [];
    for (const m of stdout.matchAll(/architecture (\S+)[\s\S]*?size (\d+)/g)) {
      archs.push(m[1]);
      if (!m[1].startsWith(arch === "arm64" ? "arm64" : "x86_64")) foreign += Number(m[2]);
    }
    if (foreign === 0) return null;
    return { appPath, app: app.name, exe, foreign, archs };
  });
  for (const r of results) {
    if (!r) continue;
    items.push({ module: MOD, group: g, title: `${r.app.replace(/\.app$/, "")} (${r.archs.join("+")})`, path: r.exe, kind: "file", autoSelect: false, action: "report", note: `Main executable only. Thinning with lipo invalidates the signature; CleanMyMac re-signs via its helper. Report-only.`, meta: { foreignBytes: r.foreign } });
  }
  const findings = items.map((i) => makeFinding({ ...i, bytes: Number(i.meta?.foreignBytes ?? 0) }));
  return group(g, "Universal Binaries", `Apps that ship code for both Intel and Apple silicon. This Mac runs ${arch}; the other slice is dead weight. Report-only.`, findings);
};

export const SYSTEM_JUNK_SCANNERS: GroupScanner[] = [userCaches, systemCaches, logs, xcodeJunk, iosBackups, brokenLoginItems, brokenPreferences, miscSystemJunk, languageFiles, universalBinaries];

export function emptyGroup(id: string, title: string, description: string, warning?: string): GroupResult {
  return group(id, title, description, [], warning);
}
