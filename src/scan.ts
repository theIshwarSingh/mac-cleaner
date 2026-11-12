import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Finding, GroupResult, GroupScanner, ModuleId, ModuleResult, ScanOptions, ScanReport } from "./core/types.js";
import { DATA_DIR, ensureDataDir, humanBytes, pmap, tildify } from "./core/util.js";
import { SYSTEM_JUNK_SCANNERS } from "./scanners/system-junk.js";
import { mailAttachments, trashBins } from "./scanners/mail-trash.js";
import { PRIVACY_SCANNERS } from "./scanners/privacy.js";
import { PERFORMANCE_SCANNERS } from "./scanners/performance.js";
import { APP_SCANNERS } from "./scanners/apps.js";
import { CLUTTER_SCANNERS } from "./scanners/clutter.js";

/**
 * The five modules of CleanMyMac 5's sidebar (Smart Care runs all of them).
 * Cleanup = SystemJunkScanning + MailJunkScanning + TrashJunkScanning,
 * Protection = PrivacyScanning, Performance = PerformanceScanning,
 * Applications = UninstallerScanning + UnusedDiskImagesScanning + UpdaterScanning,
 * My Clutter = OrganizeScanning + DownloadsScanning.
 */
export interface ModuleSpec {
  id: ModuleId;
  title: string;
  description: string;
  scanners: GroupScanner[];
}

export const MODULES: ModuleSpec[] = [
  { id: "cleanup", title: "Cleanup", description: "System junk, mail attachments and trash bins.", scanners: [...SYSTEM_JUNK_SCANNERS, mailAttachments, trashBins] },
  { id: "protection", title: "Protection", description: "Browser traces, recent-items lists and app permissions.", scanners: PRIVACY_SCANNERS },
  { id: "performance", title: "Performance", description: "Maintenance tasks plus login and background items.", scanners: PERFORMANCE_SCANNERS },
  { id: "applications", title: "Applications", description: "Leftovers, installers, unused apps and pending updates.", scanners: APP_SCANNERS },
  { id: "clutter", title: "My Clutter", description: "Large and old files, duplicates and downloads.", scanners: CLUTTER_SCANNERS },
];

export const MODULE_IDS = MODULES.map((m) => m.id);

export function parseModules(input?: string | string[] | null): ModuleId[] {
  if (!input) return [];
  const parts = (Array.isArray(input) ? input : input.split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: ModuleId[] = [];
  for (const p of parts) {
    const hit = MODULES.find((m) => m.id === p || m.title.toLowerCase() === p || (p === "privacy" && m.id === "protection") || (p === "apps" && m.id === "applications"));
    if (!hit) throw new Error(`unknown module "${p}" (known: ${MODULE_IDS.join(", ")})`);
    if (!out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

export interface RunScanOptions extends ScanOptions {
  modules?: ModuleId[];
  /** Max scanners running at once inside a module. Default 3 (each may spawn du). */
  concurrency?: number;
}

export async function runScan(opts: RunScanOptions = {}): Promise<ScanReport> {
  const wanted = opts.modules?.length ? MODULES.filter((m) => opts.modules!.includes(m.id)) : MODULES;
  const modules: ModuleResult[] = [];
  for (const m of wanted) {
    opts.onProgress?.(`== ${m.title}`);
    const t0 = Date.now();
    const indexed = m.scanners.map((scanner, i) => ({ scanner, i }));
    const groups = await pmap(indexed, opts.concurrency ?? 3, async ({ scanner, i }): Promise<GroupResult> => {
      try {
        return await scanner(opts);
      } catch (err) {
        return { id: `${m.id}-scanner-${i}`, title: `Scanner ${i + 1} failed`, description: "", findings: [], bytes: 0, warning: (err as Error).message };
      }
    });
    const bytes = groups.reduce((s, g) => s + g.bytes, 0);
    modules.push({ id: m.id, title: m.title, groups, bytes, durationMs: Date.now() - t0 });
  }
  return { version: 1, createdAt: new Date().toISOString(), host: os.hostname(), modules, bytes: modules.reduce((s, m) => s + m.bytes, 0) };
}

export const REPORT_FILE = path.join(DATA_DIR, "last-scan.json");

export async function saveReport(report: ScanReport): Promise<string> {
  await ensureDataDir();
  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  return REPORT_FILE;
}

export async function loadReport(): Promise<ScanReport | null> {
  try {
    const raw = await fs.readFile(REPORT_FILE, "utf8");
    const r = JSON.parse(raw) as ScanReport;
    return r.version === 1 ? r : null;
  } catch {
    return null;
  }
}

/** Merge the groups of a partial scan into a previous report so `scan --modules x` keeps the rest. */
export function mergeReports(prev: ScanReport | null, next: ScanReport): ScanReport {
  if (!prev) return next;
  const ids = new Set(next.modules.map((m) => m.id));
  const modules = [...prev.modules.filter((m) => !ids.has(m.id)), ...next.modules];
  modules.sort((a, b) => MODULE_IDS.indexOf(a.id) - MODULE_IDS.indexOf(b.id));
  return { ...next, modules, bytes: modules.reduce((s, m) => s + m.bytes, 0) };
}

export function allFindings(report: ScanReport): Finding[] {
  return report.modules.flatMap((m) => m.groups.flatMap((g) => g.findings));
}

export interface Selection {
  ids?: string[];
  groups?: string[];
  modules?: ModuleId[];
  /** When true, only findings a scanner pre-selected. Default true unless ids are given. */
  autoOnly?: boolean;
}

export function selectFindings(report: ScanReport, sel: Selection): Finding[] {
  const ids = sel.ids ? new Set(sel.ids) : null;
  const groups = sel.groups ? new Set(sel.groups) : null;
  const modules = sel.modules?.length ? new Set(sel.modules) : null;
  const autoOnly = sel.autoOnly ?? !ids;
  return allFindings(report).filter((f) => {
    if (ids && !ids.has(f.id)) return false;
    if (groups && !groups.has(f.group)) return false;
    if (modules && !modules.has(f.module)) return false;
    if (autoOnly && !ids && !f.autoSelect) return false;
    return true;
  });
}

export function groupIndex(report: ScanReport): { module: ModuleResult; group: GroupResult }[] {
  return report.modules.flatMap((module) => module.groups.map((group) => ({ module, group })));
}

/** Plain-text summary: module, group, auto-selected bytes / total bytes, counts and warnings. */
export function formatSummary(report: ScanReport, opts: { verbose?: boolean; limit?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`Scan of ${report.host} at ${report.createdAt.replace("T", " ").slice(0, 19)}`);
  for (const m of report.modules) {
    const auto = m.groups.flatMap((g) => g.findings).filter((f) => f.autoSelect).reduce((s, f) => s + f.bytes, 0);
    lines.push("");
    lines.push(`${m.title}  ${humanBytes(auto)} selected of ${humanBytes(m.bytes)} found  (${(m.durationMs / 1000).toFixed(1)}s)`);
    for (const g of m.groups) {
      const n = g.findings.length;
      const a = g.findings.filter((f) => f.autoSelect);
      const abytes = a.reduce((s, f) => s + f.bytes, 0);
      lines.push(`  ${g.id.padEnd(22)} ${humanBytes(abytes).padStart(9)} / ${humanBytes(g.bytes).padStart(9)}   ${String(a.length).padStart(4)} / ${String(n).padStart(4)} items  ${g.title}`);
      if (g.warning) lines.push(`  ${"".padEnd(22)} ! ${g.warning}`);
      if (opts.verbose) {
        for (const f of g.findings.slice(0, opts.limit ?? 15)) lines.push(`      ${f.autoSelect ? "[x]" : "[ ]"} ${humanBytes(f.bytes).padStart(9)}  ${f.id}  ${tildify(f.path)}${f.note ? `  (${f.note})` : ""}`);
        if (n > (opts.limit ?? 15)) lines.push(`      ... ${n - (opts.limit ?? 15)} more, see \`mac-cleaner list --group ${g.id}\``);
      }
    }
  }
  const auto = allFindings(report).filter((f) => f.autoSelect).reduce((s, f) => s + f.bytes, 0);
  lines.push("");
  lines.push(`Total: ${humanBytes(auto)} pre-selected, ${humanBytes(report.bytes)} found. Run \`mac-cleaner clean\` for a dry run.`);
  return lines.join("\n");
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(nothing)";
  const lines = findings.map((f) => `${f.autoSelect ? "[x]" : "[ ]"} ${humanBytes(f.bytes).padStart(9)}  ${f.id}  ${f.module}/${f.group}  ${tildify(f.path)}${f.needsRoot ? "  (root)" : ""}${f.action === "report" ? "  (report-only)" : ""}${f.note ? `\n${"".padEnd(36)}${f.note}` : ""}`);
  lines.push(`${findings.length} items, ${humanBytes(findings.reduce((s, f) => s + f.bytes, 0))}`);
  return lines.join("\n");
}
