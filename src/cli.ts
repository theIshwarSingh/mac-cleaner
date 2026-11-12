#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cleanFindings } from "./core/remover.js";
import type { Finding, ModuleId } from "./core/types.js";
import { humanBytes, tildify } from "./core/util.js";
import { findApp, listApps, uninstallPlan } from "./scanners/apps.js";
import { healthSnapshot } from "./scanners/health.js";
import { MAINTENANCE_TASKS, runMaintenance } from "./scanners/performance.js";
import { diskUsage, spaceLens, type SpaceNode } from "./scanners/spacelens.js";
import { MODULES, allFindings, formatFindings, formatSummary, groupIndex, loadReport, mergeReports, parseModules, runScan, saveReport, selectFindings } from "./scan.js";

const HELP = `mac-cleaner: open CleanMyMac-style cleaner for macOS

  scan        [--modules cleanup,protection,...] [--fast] [--no-sizes] [--verbose] [--json]
  list        [--group id] [--module id] [--all] [--json]       findings from the last scan (pre-selected by default)
  clean       [--ids a,b] [--groups g1,g2] [--modules m] [--all-auto] [--yes] [--permanent] [--sudo] [--json]
              dry run unless --yes. Items go to the Trash unless --permanent.
  uninstall   <app name|bundle id|path> [--yes] [--sudo] [--json]
  apps        [--json]                                           installed apps with size and last-used date
  perf        list | run <task-id> [--sudo] [--dry-run]           maintenance tasks
  health      [--json]                                           CPU, memory, disk, battery snapshot
  space       [path] [--depth 2] [--top 25] [--json]              Space Lens size tree
  serve       [--port 4747]                                      local web UI + JSON API on 127.0.0.1
  help

Reports and cleanup logs are written to ~/.mac-cleaner. Nothing is removed without --yes.`;

// `mac-cleaner list | head` closes the pipe early; exit quietly instead of throwing EPIPE.
process.stdout.on("error", (err: NodeJS.ErrnoException) => { if (err.code === "EPIPE") process.exit(0); throw err; });

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function opts(spec: Record<string, { type: "string" | "boolean"; short?: string }>) {
  const { values, positionals } = parseArgs({ args: args.slice(1), options: spec, allowPositionals: true, strict: true });
  return { v: values as Record<string, string | boolean | undefined>, p: positionals };
}

function printJson(x: unknown) {
  process.stdout.write(JSON.stringify(x, null, 2) + "\n");
}

async function needReport() {
  const r = await loadReport();
  if (!r) {
    console.error("No scan report yet. Run `mac-cleaner scan` first.");
    process.exit(2);
  }
  return r;
}

async function main() {
  switch (cmd) {
    case "scan": {
      const { v } = opts({ modules: { type: "string", short: "m" }, fast: { type: "boolean" }, "no-sizes": { type: "boolean" }, verbose: { type: "boolean", short: "v" }, json: { type: "boolean" }, quiet: { type: "boolean", short: "q" } });
      const modules = parseModules(v.modules as string | undefined);
      const t0 = Date.now();
      const report = await runScan({ modules, slow: !v.fast, sizes: !v["no-sizes"], onProgress: v.json || v.quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`) });
      const merged = mergeReports(modules.length ? await loadReport() : null, report);
      const file = await saveReport(merged);
      if (v.json) return printJson(merged);
      console.log(formatSummary(merged, { verbose: Boolean(v.verbose) }));
      console.log(`\nSaved to ${tildify(file)} in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      return;
    }
    case "list": {
      const { v } = opts({ group: { type: "string", short: "g" }, module: { type: "string", short: "m" }, all: { type: "boolean", short: "a" }, json: { type: "boolean" } });
      const report = await needReport();
      if (!v.group && !v.module && !v.all && !v.json) {
        console.log("Groups in the last scan (use --group <id> to list items, --all for everything pre-selected):\n");
        for (const { module, group } of groupIndex(report)) console.log(`  ${module.id.padEnd(13)} ${group.id.padEnd(22)} ${String(group.findings.length).padStart(5)} items  ${humanBytes(group.bytes).padStart(9)}  ${group.title}`);
        return;
      }
      const found = selectFindings(report, { groups: v.group ? String(v.group).split(",") : undefined, modules: v.module ? parseModules(String(v.module)) : undefined, autoOnly: !(v.group || v.module) });
      if (v.json) return printJson(found);
      console.log(formatFindings(found));
      return;
    }
    case "clean": {
      const { v } = opts({ ids: { type: "string" }, groups: { type: "string", short: "g" }, modules: { type: "string", short: "m" }, "all-auto": { type: "boolean" }, yes: { type: "boolean", short: "y" }, permanent: { type: "boolean" }, sudo: { type: "boolean" }, json: { type: "boolean" } });
      const report = await needReport();
      const ids = v.ids ? String(v.ids).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      if (!ids && !v.groups && !v.modules && !v["all-auto"]) {
        console.error("Choose what to clean: --ids, --groups, --modules or --all-auto (everything pre-selected).");
        process.exit(2);
      }
      const findings = selectFindings(report, { ids, groups: v.groups ? String(v.groups).split(",") : undefined, modules: v.modules ? parseModules(String(v.modules)) : undefined, autoOnly: !ids });
      if (ids) {
        const missing = ids.filter((id) => !findings.some((f) => f.id === id));
        if (missing.length) console.error(`Unknown ids (not in the last scan): ${missing.join(", ")}`);
      }
      const dryRun = !v.yes;
      const result = await cleanFindings(findings, { dryRun, permanent: Boolean(v.permanent), sudo: Boolean(v.sudo), onProgress: v.json ? undefined : (it) => process.stderr.write(`  ${it.status.padEnd(10)} ${humanBytes(it.bytes).padStart(9)}  ${tildify(it.path)}${it.detail ? `  ${it.detail}` : ""}\n`) });
      if (v.json) return printJson(result);
      const counts = result.items.reduce<Record<string, number>>((acc, it) => ((acc[it.status] = (acc[it.status] ?? 0) + 1), acc), {});
      console.log(`\n${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}; ${humanBytes(dryRun ? findings.reduce((s, f) => s + f.bytes, 0) : result.bytesFreed)} ${dryRun ? "would be freed" : "freed"}.`);
      if (dryRun) console.log("Dry run. Add --yes to remove (to Trash), --permanent to delete outright, --sudo for root-owned items.");
      return;
    }
    case "uninstall": {
      const { v, p } = opts({ yes: { type: "boolean", short: "y" }, sudo: { type: "boolean" }, json: { type: "boolean" } });
      const q = p.join(" ");
      if (!q) throw new Error("uninstall needs an app name, bundle id or path");
      const app = await findApp(q);
      if (!app) throw new Error(`no installed app matches "${q}"`);
      const plan = await uninstallPlan(app);
      if (!v.yes) {
        if (v.json) return printJson({ app, plan });
        console.log(`Uninstall plan for ${app.name} ${app.version ?? ""} (${app.bundleId ?? "no bundle id"}):\n`);
        console.log(formatFindings(plan));
        console.log("\nDry run. Add --yes to move these to the Trash.");
        return;
      }
      const result = await cleanFindings(plan, { sudo: Boolean(v.sudo), onProgress: v.json ? undefined : (it) => process.stderr.write(`  ${it.status.padEnd(10)} ${tildify(it.path)}${it.detail ? `  ${it.detail}` : ""}\n`) });
      if (v.json) return printJson(result);
      console.log(`\n${result.items.filter((i) => i.status === "trashed" || i.status === "removed").length}/${plan.length} items removed, ${humanBytes(result.bytesFreed)} freed.`);
      return;
    }
    case "apps": {
      const { v } = opts({ json: { type: "boolean" } });
      const apps = await listApps(true);
      if (v.json) return printJson(apps);
      for (const a of apps.sort((x, y) => y.bytes - x.bytes)) console.log(`${humanBytes(a.bytes).padStart(9)}  ${(a.lastUsed ?? "never").slice(0, 10).padEnd(10)}  ${a.source.padEnd(9)}  ${a.name}  ${a.version ?? ""}`);
      return;
    }
    case "perf": {
      const { v, p } = opts({ sudo: { type: "boolean" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } });
      const sub = p[0] ?? "list";
      if (sub === "list") {
        if (v.json) return printJson(MAINTENANCE_TASKS.map(({ id, title, description, steps }) => ({ id, title, description, needsRoot: steps.some((s) => s.sudo) })));
        for (const t of MAINTENANCE_TASKS) console.log(`  ${t.id.padEnd(24)} ${t.steps.some((s) => s.sudo) ? "(root) " : "       "} ${t.title}: ${t.description}`);
        return;
      }
      if (sub !== "run" || !p[1]) throw new Error("usage: perf run <task-id> [--sudo] [--dry-run]");
      const r = await runMaintenance(p[1], { sudo: Boolean(v.sudo), dryRun: Boolean(v["dry-run"]) });
      if (v.json) return printJson(r);
      console.log(r.log.join("\n"));
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "health": {
      const { v } = opts({ json: { type: "boolean" } });
      const h = await healthSnapshot();
      if (v.json) return printJson(h);
      console.log(`CPU     load ${h.cpu.loadAvg1.toFixed(2)} on ${h.cpu.cores} cores${h.cpu.userPct != null ? `, ${h.cpu.userPct}% user / ${h.cpu.sysPct}% sys` : ""}${h.thermal ? `, ${h.thermal}` : ""}`);
      console.log(`Memory  ${humanBytes(h.memory.usedBytes)} used of ${humanBytes(h.memory.totalBytes)} (apps ${humanBytes(h.memory.appBytes)}, wired ${humanBytes(h.memory.wiredBytes)}, compressed ${humanBytes(h.memory.compressedBytes)}), pressure ${h.memory.pressure}${h.memory.swapUsedBytes ? `, swap ${humanBytes(h.memory.swapUsedBytes)}` : ""}`);
      console.log(`Disk    ${humanBytes(h.disk.usedBytes)} used, ${humanBytes(h.disk.freeBytes)} free${h.disk.purgeableBytes != null ? ` (+${humanBytes(h.disk.purgeableBytes)} purgeable)` : ""} of ${humanBytes(h.disk.totalBytes)}`);
      if (h.battery) console.log(`Battery ${h.battery.percent}%${h.battery.charging ? " charging" : ""}${h.battery.cycleCount != null ? `, ${h.battery.cycleCount} cycles` : ""}${h.battery.condition ? `, ${h.battery.condition}` : ""}`);
      console.log(`Uptime  ${(h.uptimeSec / 3600).toFixed(1)} h`);
      console.log("Top processes:");
      for (const p of h.topProcesses) console.log(`  ${String(p.pid).padStart(6)}  ${p.cpu.toFixed(1).padStart(6)}%  ${humanBytes(p.mem).padStart(8)}  ${p.command}`);
      return;
    }
    case "space": {
      const { v, p } = opts({ depth: { type: "string", short: "d" }, top: { type: "string" }, json: { type: "boolean" } });
      const root = p[0] ? (p[0].startsWith("/") ? p[0] : `${process.cwd()}/${p[0]}`) : undefined;
      const tree = await spaceLens(root, Number(v.depth ?? 2), Number(v.top ?? 25));
      if (v.json) return printJson({ disk: await diskUsage(), tree });
      const print = (n: SpaceNode, indent: string) => {
        console.log(`${indent}${humanBytes(n.bytes).padStart(9)}  ${n.name}`);
        for (const c of n.children ?? []) print(c, indent + "  ");
      };
      print(tree, "");
      return;
    }
    case "serve": {
      const { v } = opts({ port: { type: "string", short: "p" }, open: { type: "boolean" } });
      const { startServer } = await import("./server.js");
      await startServer({ port: Number(v.port ?? 4747), open: Boolean(v.open) });
      return;
    }
    case "modules":
      for (const m of MODULES) console.log(`  ${m.id.padEnd(13)} ${m.title}: ${m.description}`);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

export type { Finding, ModuleId };
export { allFindings };
