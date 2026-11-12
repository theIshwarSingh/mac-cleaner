import { promises as fs } from "node:fs";
import path from "node:path";
import { LEFTOVER_LOCATIONS, UNUSED_APP_DAYS } from "../core/kb.js";
import type { Finding, GroupResult, GroupScanner } from "../core/types.js";
import { HOME, daysAgo, duMany, exists, expandHome, group, listDir, makeFinding, mdfind, mdlsRaw, pmap, readPlist, run, statSafe } from "../core/util.js";

const MOD = "applications" as const;

export interface AppInfo {
  name: string;
  path: string;
  bundleId: string | null;
  version: string | null;
  executable: string | null;
  bytes: number;
  lastUsed: string | null;
  source: "app-store" | "direct" | "system";
}

let appCache: { at: number; apps: AppInfo[] } | null = null;

/** Installed applications in /Applications and ~/Applications (one level of subfolders). */
export async function listApps(withSizes = true): Promise<AppInfo[]> {
  if (appCache && Date.now() - appCache.at < 60_000 && withSizes) return appCache.apps;
  const roots = ["/Applications", path.join(HOME, "Applications")];
  const paths: string[] = [];
  for (const r of roots) {
    for (const e of await listDir(r)) {
      if (e.name.endsWith(".app")) paths.push(path.join(r, e.name));
      else if (e.isDirectory() && !e.name.startsWith(".")) {
        for (const s of await listDir(path.join(r, e.name))) if (s.name.endsWith(".app")) paths.push(path.join(r, e.name, s.name));
      }
    }
  }
  const sizes = withSizes ? await duMany(paths) : new Map<string, number>();
  const apps = await pmap(paths, 8, async (p): Promise<AppInfo> => {
    const info = await readPlist<{ CFBundleIdentifier?: string; CFBundleShortVersionString?: string; CFBundleVersion?: string; CFBundleExecutable?: string; CFBundleName?: string; CFBundleDisplayName?: string }>(path.join(p, "Contents/Info.plist"));
    const lastUsed = await mdlsRaw(p, "kMDItemLastUsedDate");
    const receipt = await exists(path.join(p, "Contents/_MASReceipt/receipt"));
    return {
      name: path.basename(p, ".app"),
      path: p,
      bundleId: info?.CFBundleIdentifier ?? null,
      version: info?.CFBundleShortVersionString ?? info?.CFBundleVersion ?? null,
      executable: info?.CFBundleExecutable ?? null,
      bytes: sizes.get(p) ?? 0,
      lastUsed,
      source: receipt ? "app-store" : info?.CFBundleIdentifier?.startsWith("com.apple.") ? "system" : "direct",
    };
  });
  apps.sort((a, b) => a.name.localeCompare(b.name));
  if (withSizes) appCache = { at: Date.now(), apps };
  return apps;
}

export async function findApp(query: string): Promise<AppInfo | null> {
  const apps = await listApps(false);
  const q = query.toLowerCase().replace(/\.app$/, "");
  return (
    apps.find((a) => a.path === query) ??
    apps.find((a) => a.name.toLowerCase() === q) ??
    apps.find((a) => a.bundleId?.toLowerCase() === q) ??
    apps.find((a) => a.name.toLowerCase().includes(q)) ??
    null
  );
}

function globToRegex(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}

/** Files and folders an app leaves behind (what the Uninstaller removes together with the bundle). */
export async function leftoversFor(app: AppInfo, withSizes = true): Promise<Finding[]> {
  const g = "uninstaller";
  const id = app.bundleId ?? "";
  const names = new Set<string>([app.name]);
  if (app.executable) names.add(app.executable);
  const found = new Map<string, { root: boolean }>();
  for (const loc of LEFTOVER_LOCATIONS) {
    const base = expandHome(loc.base);
    const entries = await listDir(base);
    if (entries.length === 0) continue;
    const regexes: RegExp[] = [];
    for (const pat of loc.patterns) {
      if (pat.includes("{id}") && !id) continue;
      if (pat.includes("{name}") || pat.includes("{exe}")) {
        for (const n of names) regexes.push(globToRegex(pat.replace("{name}", n).replace("{exe}", n)));
      } else regexes.push(globToRegex(pat.replace("{id}", id)));
    }
    for (const e of entries) {
      if (regexes.some((r) => r.test(e.name))) found.set(path.join(base, e.name), { root: Boolean(loc.root) });
    }
  }
  // Group containers are prefixed with the team id: <TEAMID>.<bundle-ish>.
  if (id) {
    for (const e of await listDir(path.join(HOME, "Library/Group Containers"))) {
      if (e.name.toLowerCase().includes(id.toLowerCase()) || e.name.toLowerCase().endsWith("." + app.name.toLowerCase())) found.set(path.join(HOME, "Library/Group Containers", e.name), { root: false });
    }
  }
  found.delete(app.path);
  const paths = [...found.keys()];
  const sizes = withSizes ? await duMany(paths) : new Map<string, number>();
  const out: Finding[] = [];
  for (const p of paths) {
    const st = await statSafe(p);
    out.push(makeFinding({ module: MOD, group: g, title: `${app.name}: ${path.relative(HOME, p).startsWith("..") ? p : "~/" + path.relative(HOME, p)}`, path: p, kind: st?.isDirectory() ? "directory" : "file", bytes: sizes.get(p) ?? st?.size ?? 0, autoSelect: true, action: "trash", needsRoot: found.get(p)?.root, meta: { app: app.name, bundleId: id } }));
  }
  return out;
}

/** Uninstall plan: the bundle plus its leftovers. */
export async function uninstallPlan(app: AppInfo): Promise<Finding[]> {
  const bundle = makeFinding({ module: MOD, group: "uninstaller", title: app.name, path: app.path, kind: "directory", bytes: app.bytes || (await duMany([app.path])).get(app.path) || 0, autoSelect: true, action: "trash", needsRoot: !(await fs.access(path.dirname(app.path), fs.constants.W_OK).then(() => true, () => false)), meta: { app: app.name, bundleId: app.bundleId } });
  return [bundle, ...(await leftoversFor(app))];
}

/** Leftovers: support folders, containers and preferences whose owning app is no longer installed. */
export const orphanedLeftovers: GroupScanner = async (opts) => {
  opts.onProgress?.("Application leftovers");
  const g = "leftovers";
  const installed = new Set<string>();
  for (const a of await listApps(false)) if (a.bundleId) installed.add(a.bundleId.toLowerCase());
  const candidates: { path: string; bundleId: string; title: string }[] = [];
  const seen = new Set<string>();
  const consider = (p: string, bundleId: string, title: string) => {
    const k = bundleId.toLowerCase();
    if (k.startsWith("com.apple.") || installed.has(k) || seen.has(p)) return;
    seen.add(p);
    candidates.push({ path: p, bundleId: k, title });
  };
  for (const e of await listDir(path.join(HOME, "Library/Containers"))) if (e.isDirectory() && e.name.includes(".")) consider(path.join(HOME, "Library/Containers", e.name), e.name, `Container ${e.name}`);
  for (const e of await listDir(path.join(HOME, "Library/Application Support"))) if (e.isDirectory() && /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9.-]+$/i.test(e.name)) consider(path.join(HOME, "Library/Application Support", e.name), e.name, `Application Support ${e.name}`);
  for (const e of await listDir(path.join(HOME, "Library/Saved Application State"))) if (e.name.endsWith(".savedState")) consider(path.join(HOME, "Library/Saved Application State", e.name), e.name.replace(/\.savedState$/, ""), `Saved state ${e.name}`);
  for (const e of await listDir(path.join(HOME, "Library/Preferences"))) {
    if (!e.name.endsWith(".plist") || e.name.startsWith("com.apple.") || e.name.startsWith(".")) continue;
    const bid = e.name.replace(/\.plist$/, "");
    if ((bid.match(/\./g) ?? []).length >= 2) consider(path.join(HOME, "Library/Preferences", e.name), bid, `Preferences ${e.name}`);
  }
  if (opts.slow === false) return group(g, "Leftover Files", "Traces of uninstalled applications.", [], "Skipped (slow scan disabled).");

  // Ask LaunchServices whether any app with that bundle id still exists anywhere (helpers, system apps, other volumes).
  const unique = [...new Set(candidates.map((c) => c.bundleId))];
  const stillPresent = new Set<string>();
  await pmap(unique, 8, async (bid) => {
    const hits = await mdfind(`kMDItemCFBundleIdentifier == "${bid}"c`);
    if (hits.length > 0) stillPresent.add(bid);
    else {
      // Embedded helpers are not always indexed; check the common suffix pattern (<parent>.helper etc).
      const parent = bid.split(".").slice(0, 3).join(".");
      if (parent !== bid && installed.has(parent)) stillPresent.add(bid);
      else if ((await mdfind(`kMDItemCFBundleIdentifier == "${parent}*"c`)).length > 0) stillPresent.add(bid);
    }
  });
  const orphans = candidates.filter((c) => !stillPresent.has(c.bundleId));
  const sizes = opts.sizes === false ? new Map<string, number>() : await duMany(orphans.map((o) => o.path));
  const findings = await Promise.all(orphans.map(async (o) => {
    const st = await statSafe(o.path);
    return makeFinding({ module: MOD, group: g, title: o.title, path: o.path, kind: st?.isDirectory() ? "directory" : "file", bytes: sizes.get(o.path) ?? st?.size ?? 0, autoSelect: false, action: "trash", note: `No installed app registers ${o.bundleId}. Review: command-line tools and VS Code extensions also use reverse-DNS folders.`, meta: { bundleId: o.bundleId } });
  }));
  return group(g, "Leftover Files", "Containers, support folders, saved state and preferences left by apps that are no longer installed. Review before cleaning: some belong to command-line tools.", findings);
};

/** Unused disk images: .dmg files (usually installers) you already ran. */
export const unusedDiskImages: GroupScanner = async (opts) => {
  opts.onProgress?.("Unused disk images");
  const g = "installers";
  const hits = await mdfind(`kMDItemContentType == "com.apple.disk-image-udif" || kMDItemContentType == "com.apple.disk-image" || kMDItemFSName == "*.dmg"c || kMDItemFSName == "*.pkg"c`, [HOME]);
  const files = hits.filter((p) => !p.includes("/Library/") && !p.includes("/.Trash/") && !p.includes("/node_modules/"));
  const findings: Finding[] = [];
  for (const p of files) {
    const st = await statSafe(p);
    if (!st || !st.isFile()) continue;
    const used = await mdlsRaw(p, "kMDItemLastUsedDate");
    findings.push(makeFinding({ module: MOD, group: g, title: path.basename(p), path: p, kind: "file", bytes: st.size, autoSelect: Boolean(used) && daysAgo(st.mtimeMs)! > 7, action: "trash", note: used ? `Opened ${used.slice(0, 10)}` : "Never opened", meta: { lastUsed: used } }));
  }
  return group(g, "Unused DMG Files", "Installer disk images and packages lying around your home folder.", findings);
};

/** Apps not launched for a long time (Spotlight kMDItemLastUsedDate). */
export const unusedApps: GroupScanner = async (opts) => {
  opts.onProgress?.("Unused applications");
  const g = "unused-apps";
  const apps = await listApps(opts.sizes !== false);
  const findings: Finding[] = [];
  for (const a of apps) {
    if (a.source === "system") continue;
    const age = a.lastUsed ? daysAgo(new Date(a.lastUsed)) : null;
    if (age != null && age < UNUSED_APP_DAYS) continue;
    findings.push(makeFinding({ module: MOD, group: g, title: a.name, path: a.path, kind: "directory", bytes: a.bytes, autoSelect: false, action: "report", note: age == null ? "Never launched (per Spotlight)" : `Last used ${age} days ago`, meta: { lastUsed: a.lastUsed, bundleId: a.bundleId, version: a.version } }));
  }
  return group(g, "Unused Applications", `Applications not opened in ${UNUSED_APP_DAYS}+ days. Use \`uninstall\` to remove one with its leftovers.`, findings);
};

/** Updates: Sparkle feeds and App Store updates are out of scope without network access; report what we can. */
export const updates: GroupScanner = async () => {
  const r = await run("/usr/sbin/softwareupdate", ["--list", "--no-scan"], { timeoutMs: 30_000 });
  const findings: Finding[] = [];
  for (const m of r.stdout.matchAll(/\* Label: (.+)\n\s+Title: (.+?), Version: (\S+),/g)) {
    findings.push(makeFinding({ module: MOD, group: "updates", title: `macOS: ${m[2]} ${m[3]}`, path: `task:softwareupdate:${m[1]}`, kind: "task", bytes: 0, autoSelect: false, action: "report", note: `sudo softwareupdate -i ${JSON.stringify(m[1])}` }));
  }
  return group("updates", "Updater", "Pending macOS updates from the last Software Update scan. Third-party app updates stay with each app's own updater.", findings);
};

export const APP_SCANNERS: GroupScanner[] = [orphanedLeftovers, unusedDiskImages, unusedApps, updates];
export type { GroupResult };
