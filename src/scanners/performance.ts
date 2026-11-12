import path from "node:path";
import type { Finding, GroupScanner } from "../core/types.js";
import { HOME, exists, group, isProcessRunning, listDir, makeFinding, readPlist, run } from "../core/util.js";
import { shellQuote } from "../core/remover.js";

const MOD = "performance" as const;

export interface MaintenanceTask {
  id: string;
  title: string;
  description: string;
  /** Commands to run in order. `sudo: true` steps are printed, or run through sudo with --sudo. */
  steps: { cmd: string; args: string[]; sudo?: boolean; ignoreFailure?: boolean }[];
  recommendWhen?: () => Promise<string | null>;
}

const envelopeIndex = async (): Promise<string | null> => {
  for (const v of await listDir(path.join(HOME, "Library/Mail"))) {
    const p = path.join(HOME, "Library/Mail", v.name, "MailData/Envelope Index");
    if (await exists(p)) return p;
  }
  return null;
};

export const MAINTENANCE_TASKS: MaintenanceTask[] = [
  {
    id: "flush-dns",
    title: "Flush DNS Cache",
    description: "Clears the local resolver cache so changed DNS records take effect immediately.",
    steps: [
      { cmd: "/usr/bin/dscacheutil", args: ["-flushcache"] },
      { cmd: "/usr/bin/killall", args: ["-HUP", "mDNSResponder"], sudo: true },
    ],
  },
  {
    id: "free-ram",
    title: "Free Up RAM",
    description: "Forces the kernel to drop the disk cache and inactive pages (same as the `purge` command).",
    steps: [{ cmd: "/usr/sbin/purge", args: [], sudo: true }],
    recommendWhen: async () => {
      const { stdout } = await run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
      const m = /used = ([\d.]+)M/.exec(stdout);
      return m && Number(m[1]) > 2048 ? `${Math.round(Number(m[1]))} MB of swap in use` : null;
    },
  },
  {
    id: "thin-snapshots",
    title: "Thin Time Machine Snapshots",
    description: "Asks APFS to purge local Time Machine snapshots, releasing purgeable space.",
    steps: [{ cmd: "/usr/bin/tmutil", args: ["thinlocalsnapshots", "/", "999999999999", "4"], sudo: true }],
    recommendWhen: async () => {
      const { stdout } = await run("/usr/bin/tmutil", ["listlocalsnapshots", "/"]);
      const n = stdout.split("\n").filter((l) => l.includes("com.apple.TimeMachine")).length;
      return n > 0 ? `${n} local snapshot${n === 1 ? "" : "s"}` : null;
    },
  },
  {
    id: "periodic-scripts",
    title: "Run Periodic Scripts",
    description: "Runs the daily, weekly and monthly maintenance scripts (log rotation, locate db, etc.).",
    steps: [{ cmd: "/usr/sbin/periodic", args: ["daily", "weekly", "monthly"], sudo: true }],
  },
  {
    id: "reindex-spotlight",
    title: "Reindex Spotlight",
    description: "Erases and rebuilds the Spotlight index for the startup volume. Search is slow until it finishes.",
    steps: [{ cmd: "/usr/bin/mdutil", args: ["-E", "/"], sudo: true }],
  },
  {
    id: "speed-up-mail",
    title: "Speed Up Mail",
    description: "Vacuums Mail's Envelope Index SQLite database. Quit Mail first; needs Full Disk Access.",
    steps: [],
    recommendWhen: async () => {
      const p = await envelopeIndex();
      if (!p) return null;
      const st = await import("node:fs").then((m) => m.promises.stat(p).catch(() => null));
      return st && st.size > 500 * 1024 * 1024 ? `Envelope Index is ${Math.round(st.size / 1e6)} MB` : null;
    },
  },
  {
    id: "repair-permissions",
    title: "Repair Disk Permissions",
    description: "Resets permissions on your home folder (diskutil resetUserPermissions).",
    steps: [{ cmd: "/usr/sbin/diskutil", args: ["resetUserPermissions", "/", String(process.getuid?.() ?? 501)] }],
  },
  {
    id: "rebuild-launchservices",
    title: "Rebuild Launch Services",
    description: "Fixes duplicate entries in the Open With menu by re-registering applications.",
    steps: [
      { cmd: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", args: ["-kill", "-r", "-domain", "local", "-domain", "system", "-domain", "user"] },
      { cmd: "/usr/bin/killall", args: ["Finder"], ignoreFailure: true },
    ],
  },
];

export async function runMaintenance(id: string, opts: { sudo?: boolean; dryRun?: boolean } = {}): Promise<{ ok: boolean; log: string[] }> {
  const task = MAINTENANCE_TASKS.find((t) => t.id === id);
  if (!task) return { ok: false, log: [`unknown task ${id}`] };
  const log: string[] = [];
  let ok = true;
  if (task.id === "speed-up-mail") {
    if (await isProcessRunning("Mail")) return { ok: false, log: ["Quit Mail first."] };
    const p = await envelopeIndex();
    if (!p) return { ok: false, log: ["No Envelope Index found (or no Full Disk Access)."] };
    if (opts.dryRun) return { ok: true, log: [`would run: sqlite3 ${shellQuote(p)} vacuum`] };
    const r = await run("/usr/bin/sqlite3", [p, "vacuum; reindex;"], { timeoutMs: 600_000 });
    return { ok: r.code === 0, log: [r.code === 0 ? "Envelope Index vacuumed." : r.stderr.trim()] };
  }
  for (const s of task.steps) {
    const printable = `${s.sudo ? "sudo " : ""}${s.cmd} ${s.args.map(shellQuote).join(" ")}`;
    if (opts.dryRun) { log.push(`would run: ${printable}`); continue; }
    if (s.sudo && !opts.sudo) { log.push(`needs root, run manually: ${printable}`); ok = false; continue; }
    const r = s.sudo ? await run("/usr/bin/sudo", [s.cmd, ...s.args], { timeoutMs: 1_800_000 }) : await run(s.cmd, s.args, { timeoutMs: 1_800_000 });
    if (r.code !== 0 && !s.ignoreFailure) { ok = false; log.push(`${printable} -> exit ${r.code} ${r.stderr.trim()}`); }
    else log.push(`${printable} -> ok`);
  }
  return { ok, log };
}

export const maintenance: GroupScanner = async (opts) => {
  opts.onProgress?.("Maintenance tasks");
  const findings: Finding[] = [];
  for (const t of MAINTENANCE_TASKS) {
    const reason = t.recommendWhen ? await t.recommendWhen() : null;
    findings.push(makeFinding({ module: MOD, group: "maintenance", title: t.title, path: `task:${t.id}`, kind: "task", bytes: 0, autoSelect: Boolean(reason), action: "command", needsRoot: t.steps.some((s) => s.sudo), note: reason ?? t.description, meta: { recommended: Boolean(reason), taskId: t.id } }));
  }
  return group("maintenance", "Maintenance Tasks", "One-off tune-ups. Recommended ones are pre-selected. Run with `mac-cleaner perf run <task>`.", findings);
};

/** Login items and launch agents, flagged when disabled, duplicated or pointing at missing programs. */
export const loginItems: GroupScanner = async (opts) => {
  opts.onProgress?.("Login items");
  const findings: Finding[] = [];
  const osa = await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to get the path of every login item'], { timeoutMs: 20_000 });
  if (osa.code === 0) {
    for (const p of osa.stdout.split(", ").map((s) => s.trim()).filter(Boolean)) {
      const missing = !(await exists(p));
      findings.push(makeFinding({ module: MOD, group: "login-items", title: `Login item: ${path.basename(p)}`, path: `loginitem:${p}`, kind: "record", bytes: 0, autoSelect: missing, action: "report", note: missing ? "Target is missing" : "Opens at login. Remove in System Settings > General > Login Items.", meta: { target: p, missing } }));
    }
  }
  for (const dir of [path.join(HOME, "Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"]) {
    for (const e of await listDir(dir)) {
      if (!e.name.endsWith(".plist")) continue;
      const p = path.join(dir, e.name);
      const pl = await readPlist<{ Label?: string; Program?: string; ProgramArguments?: string[]; Disabled?: boolean; RunAtLoad?: boolean; KeepAlive?: unknown }>(p);
      const prog = pl?.Program ?? pl?.ProgramArguments?.[0] ?? "";
      findings.push(makeFinding({ module: MOD, group: "login-items", title: pl?.Label ?? e.name, path: p, kind: "file", bytes: 0, autoSelect: false, action: "trash", needsRoot: !dir.startsWith(HOME), note: `${dir.includes("Daemons") ? "Daemon" : "Agent"}${pl?.Disabled ? " (disabled)" : ""}${pl?.KeepAlive ? ", keeps alive" : ""}: ${prog}`, meta: { program: prog, disabled: Boolean(pl?.Disabled), runAtLoad: Boolean(pl?.RunAtLoad) } }));
    }
  }
  return group("login-items", "Login Items & Background Items", "Everything that starts automatically: login items plus launchd agents and daemons. Nothing is pre-selected.", findings);
};

export const PERFORMANCE_SCANNERS: GroupScanner[] = [maintenance, loginItems];
