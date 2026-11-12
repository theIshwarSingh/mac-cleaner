import path from "node:path";
import { RECENT_ITEM_LISTS, TCC_SERVICES } from "../core/kb.js";
import type { Finding, GroupScanner } from "../core/types.js";
import { HOME, exists, group, isProcessRunning, listDir, makeFinding, run, statSafe } from "../core/util.js";

const MOD = "protection" as const;

async function sqliteCount(db: string, sql: string): Promise<number | null> {
  if (!(await exists(db))) return null;
  // Copy-free read: open immutable so a locked browser DB still answers.
  const r = await run("/usr/bin/sqlite3", ["-readonly", `file:${db}?immutable=1`, sql], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

async function item(opts: { group: string; title: string; p: string; count?: number | null; running: boolean; note: string; auto?: boolean; action?: Finding["action"] }): Promise<Finding | null> {
  const st = await statSafe(opts.p);
  if (!st) return null;
  return makeFinding({ module: MOD, group: opts.group, title: opts.count != null ? `${opts.title} (${opts.count})` : opts.title, path: opts.p, kind: st.isDirectory() ? "directory" : "file", bytes: st.size, autoSelect: opts.auto ?? false, action: opts.action ?? "delete", note: opts.running ? `${opts.note} Browser is running: quit it before cleaning.` : opts.note, meta: { count: opts.count ?? null, running: opts.running } });
}

export const safari: GroupScanner = async (opts) => {
  opts.onProgress?.("Safari privacy items");
  const g = "safari";
  const running = await isProcessRunning("Safari");
  const base = path.join(HOME, "Library/Safari");
  const containers = path.join(HOME, "Library/Containers/com.apple.Safari/Data/Library");
  const out: (Finding | null)[] = [];
  let warning: string | undefined;
  if (!(await exists(base)) || (await listDir(base)).length === 0) warning = "~/Library/Safari is unreadable without Full Disk Access.";
  out.push(await item({ group: g, title: "Browsing History", p: path.join(base, "History.db"), count: await sqliteCount(path.join(base, "History.db"), "select count(*) from history_items"), running, note: "History.db (plus -wal/-shm journals)." }));
  out.push(await item({ group: g, title: "Downloads History", p: path.join(base, "Downloads.plist"), running, note: "List of downloaded files, not the files themselves." }));
  out.push(await item({ group: g, title: "Tabs From Last Session", p: path.join(base, "LastSession.plist"), running, note: "Restored windows and tabs." }));
  out.push(await item({ group: g, title: "Top Sites", p: path.join(base, "TopSites.plist"), running, note: "Frequently visited sites shown on the start page." }));
  out.push(await item({ group: g, title: "Cookies", p: path.join(HOME, "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"), running, note: "Signs you out of every site." }));
  out.push(await item({ group: g, title: "HTML5 Local Storage", p: path.join(containers, "Safari/LocalStorage"), running, note: "Site data stored by web apps." }));
  out.push(await item({ group: g, title: "Website Cache", p: path.join(HOME, "Library/Containers/com.apple.Safari/Data/Library/Caches/com.apple.Safari"), running, note: "Cached pages and images.", auto: true, action: "trash" }));
  return group(g, "Safari", "Browsing traces kept by Safari. Nothing is pre-selected except the cache.", out.filter((f): f is Finding => Boolean(f)), warning);
};

export const chrome: GroupScanner = async (opts) => {
  opts.onProgress?.("Chrome privacy items");
  const g = "chrome";
  const running = await isProcessRunning("Google Chrome");
  const root = path.join(HOME, "Library/Application Support/Google/Chrome");
  const out: (Finding | null)[] = [];
  for (const prof of await listDir(root)) {
    if (!prof.isDirectory() || !(prof.name === "Default" || prof.name.startsWith("Profile "))) continue;
    const p = path.join(root, prof.name);
    const label = (t: string) => `${t} [${prof.name}]`;
    out.push(await item({ group: g, title: label("Browsing History"), p: path.join(p, "History"), count: await sqliteCount(path.join(p, "History"), "select count(*) from urls"), running, note: "History SQLite db (includes typed search queries)." }));
    out.push(await item({ group: g, title: label("Downloads History"), p: path.join(p, "History"), count: await sqliteCount(path.join(p, "History"), "select count(*) from downloads"), running, note: "Stored in the same History db; removing it clears both.", action: "report" }));
    out.push(await item({ group: g, title: label("Cookies"), p: path.join(p, "Cookies"), count: await sqliteCount(path.join(p, "Cookies"), "select count(*) from cookies"), running, note: "Signs you out of every site." }));
    out.push(await item({ group: g, title: label("Autofill Values"), p: path.join(p, "Web Data"), count: await sqliteCount(path.join(p, "Web Data"), "select count(*) from autofill"), running, note: "Form autofill entries. Also holds saved addresses and cards." }));
    out.push(await item({ group: g, title: label("Saved Passwords"), p: path.join(p, "Login Data"), count: await sqliteCount(path.join(p, "Login Data"), "select count(*) from logins"), running, note: "Encrypted with the login keychain. Never pre-selected.", action: "report" }));
    out.push(await item({ group: g, title: label("Tabs From Last Session"), p: path.join(p, "Sessions"), running, note: "Session restore data." }));
    out.push(await item({ group: g, title: label("Cache"), p: path.join(p, "Cache"), running, note: "Website cache.", auto: true, action: "trash" }));
  }
  return group(g, "Google Chrome", "Chrome signed into a Google account syncs most of this back; sign out of sync first if you want it gone for good.", out.filter((f): f is Finding => Boolean(f)));
};

export const firefox: GroupScanner = async (opts) => {
  opts.onProgress?.("Firefox privacy items");
  const g = "firefox";
  const running = await isProcessRunning("firefox");
  const root = path.join(HOME, "Library/Application Support/Firefox/Profiles");
  const out: (Finding | null)[] = [];
  for (const prof of await listDir(root)) {
    if (!prof.isDirectory()) continue;
    const p = path.join(root, prof.name);
    const label = (t: string) => `${t} [${prof.name}]`;
    out.push(await item({ group: g, title: label("Browsing & Downloads History"), p: path.join(p, "places.sqlite"), count: await sqliteCount(path.join(p, "places.sqlite"), "select count(*) from moz_places"), running, note: "places.sqlite also stores bookmarks. Export bookmarks first." }));
    out.push(await item({ group: g, title: label("Cookies"), p: path.join(p, "cookies.sqlite"), count: await sqliteCount(path.join(p, "cookies.sqlite"), "select count(*) from moz_cookies"), running, note: "Signs you out of every site." }));
    out.push(await item({ group: g, title: label("Autofill Values"), p: path.join(p, "formhistory.sqlite"), running, note: "Form history." }));
    out.push(await item({ group: g, title: label("Saved Passwords"), p: path.join(p, "logins.json"), running, note: "Never pre-selected.", action: "report" }));
    for (const s of ["sessionstore.jsonlz4", "sessionstore.js", "sessionstore.bak"]) out.push(await item({ group: g, title: label("Tabs From Last Session"), p: path.join(p, s), running, note: "Session restore." }));
    out.push(await item({ group: g, title: label("Session backups"), p: path.join(p, "sessionstore-backups"), running, note: "Session restore backups." }));
  }
  const cache = path.join(HOME, "Library/Caches/Firefox/Profiles");
  for (const prof of await listDir(cache)) out.push(await item({ group: g, title: `Cache [${prof.name}]`, p: path.join(cache, prof.name, "cache2"), running, note: "Website cache.", auto: true, action: "trash" }));
  return group(g, "Firefox", "Firefox profile data.", out.filter((f): f is Finding => Boolean(f)));
};

export const recentItems: GroupScanner = async (opts) => {
  opts.onProgress?.("Recent items lists");
  const g = "recent-items";
  const base = path.join(HOME, "Library/Application Support/com.apple.sharedfilelist");
  const out: (Finding | null)[] = [];
  for (const r of RECENT_ITEM_LISTS) out.push(await item({ group: g, title: r.title, p: path.join(base, r.file), running: false, note: "Clears the Apple menu > Recent Items list." }));
  // Per-app recent documents live in com.apple.LSSharedFileList.ApplicationRecentDocuments/<bundle id>.sfl3
  const perApp = path.join(base, "com.apple.LSSharedFileList.ApplicationRecentDocuments");
  const entries = await listDir(perApp);
  if (entries.length > 0) {
    const st = await statSafe(perApp);
    out.push(makeFinding({ module: MOD, group: g, title: `Per-app recent documents (${entries.length} apps)`, path: perApp, kind: "directory", bytes: st?.size ?? 0, autoSelect: false, action: "delete", note: "Clears File > Open Recent in every app." }));
  }
  const wifi = await run("/usr/sbin/networksetup", ["-listpreferredwirelessnetworks", "en0"], { timeoutMs: 20_000 });
  const nets = wifi.stdout.split("\n").slice(1).map((s) => s.trim()).filter(Boolean);
  if (nets.length > 0) out.push(makeFinding({ module: MOD, group: g, title: `Remembered Wi-Fi networks (${nets.length})`, path: "record:wifi-networks", kind: "record", bytes: 0, autoSelect: false, action: "report", note: `Forget one with: networksetup -removepreferredwirelessnetwork en0 <name>`, meta: { sample: nets.slice(0, 10).join(", ") } }));
  return group(g, "Recent Items Lists", "Lists of recently used apps, documents and servers kept by macOS.", out.filter((f): f is Finding => Boolean(f)));
};

/** Application permissions from the user TCC database (needs Full Disk Access to read). */
export const appPermissions: GroupScanner = async (opts) => {
  opts.onProgress?.("Application permissions");
  const g = "app-permissions";
  const db = path.join(HOME, "Library/Application Support/com.apple.TCC/TCC.db");
  const r = await run("/usr/bin/sqlite3", ["-readonly", "-separator", "\t", `file:${db}?immutable=1`, "select service, client, auth_value, last_modified from access where auth_value > 0 order by service, client"], { timeoutMs: 30_000 });
  if (r.code !== 0) return group(g, "Application Permissions", "Which apps may use your camera, microphone, folders and more.", [], "Reading the TCC database needs Full Disk Access for this terminal. Review in System Settings > Privacy & Security instead.");
  const findings: Finding[] = [];
  for (const line of r.stdout.split("\n")) {
    const [service, client, auth, modified] = line.split("\t");
    if (!service || !client) continue;
    const label = TCC_SERVICES[service] ?? service.replace(/^kTCCService/, "");
    findings.push(makeFinding({ module: MOD, group: g, title: `${label}: ${client}`, path: `tcc:${service}:${client}`, kind: "record", bytes: 0, autoSelect: false, action: "report", note: `Revoke with: tccutil reset ${service.replace(/^kTCCService/, "")} ${client}`, meta: { service, client, auth: Number(auth), modified: Number(modified) } }));
  }
  return group(g, "Application Permissions", "Permissions granted in Privacy & Security. Revoke with the printed tccutil command.", findings);
};

export const PRIVACY_SCANNERS: GroupScanner[] = [safari, chrome, firefox, recentItems, appPermissions];
