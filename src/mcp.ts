#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cleanFindings } from "./core/remover.js";
import { humanBytes } from "./core/util.js";
import { findApp, listApps, uninstallPlan } from "./scanners/apps.js";
import { healthSnapshot } from "./scanners/health.js";
import { MAINTENANCE_TASKS, runMaintenance } from "./scanners/performance.js";
import { diskUsage, spaceLens } from "./scanners/spacelens.js";
import { MODULE_IDS, formatFindings, formatSummary, loadReport, mergeReports, parseModules, runScan, saveReport, selectFindings } from "./scan.js";

/**
 * MCP server so Claude (and its subagents) can drive mac-cleaner.
 * Every destructive tool defaults to a dry run and requires `confirm: true`.
 */
const server = new McpServer({ name: "mac-cleaner", version: "1.0.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (x: unknown) => text(JSON.stringify(x, null, 2));

const moduleEnum = z.enum(MODULE_IDS as [string, ...string[]]);

server.registerTool("scan", {
  description: "Scan this Mac for junk, privacy traces, maintenance needs, app leftovers and clutter. Saves the report to ~/.mac-cleaner/last-scan.json and returns a summary with group ids and byte counts. Pass `verbose` for per-item ids.",
  inputSchema: { modules: z.array(moduleEnum).optional().describe("Subset of modules; default all five."), fast: z.boolean().optional().describe("Skip slow scanners (duplicates hashing, orphan lookups)."), verbose: z.boolean().optional() },
}, async ({ modules, fast, verbose }) => {
  const mods = parseModules(modules ?? []);
  const report = mergeReports(mods.length ? await loadReport() : null, await runScan({ modules: mods, slow: !fast }));
  await saveReport(report);
  return text(formatSummary(report, { verbose: Boolean(verbose) }));
});

server.registerTool("findings", {
  description: "List findings from the last scan. Filter by group ids, modules or explicit finding ids. Only pre-selected (safe) items are returned unless `all` is true.",
  inputSchema: { groups: z.array(z.string()).optional(), modules: z.array(moduleEnum).optional(), ids: z.array(z.string()).optional(), all: z.boolean().optional(), json: z.boolean().optional().describe("Return raw JSON instead of a table.") },
}, async ({ groups, modules, ids, all, json: asJson }) => {
  const report = await loadReport();
  if (!report) return text("No scan yet. Call `scan` first.");
  const found = selectFindings(report, { groups, modules: parseModules(modules ?? []), ids, autoOnly: all ? false : !ids });
  return asJson ? json(found) : text(formatFindings(found));
});

server.registerTool("clean", {
  description: "Remove findings from the last scan. Dry run unless confirm=true; ask the user before confirming. Items go to the Trash unless permanent=true. Root-owned items are skipped with the sudo command to run by hand.",
  inputSchema: { ids: z.array(z.string()).optional().describe("Finding ids (from `findings`)."), groups: z.array(z.string()).optional().describe("Whole groups; only pre-selected items inside them."), modules: z.array(moduleEnum).optional(), confirm: z.boolean().optional(), permanent: z.boolean().optional() },
}, async ({ ids, groups, modules, confirm, permanent }) => {
  const report = await loadReport();
  if (!report) return text("No scan yet. Call `scan` first.");
  if (!ids?.length && !groups?.length && !modules?.length) return text("Nothing selected: pass ids, groups or modules.");
  const findings = selectFindings(report, { ids, groups, modules: parseModules(modules ?? []), autoOnly: !ids?.length });
  const result = await cleanFindings(findings, { dryRun: !confirm, permanent });
  const lines = result.items.map((i) => `${i.status.padEnd(10)} ${humanBytes(i.bytes).padStart(9)}  ${i.path}${i.detail ? `  (${i.detail})` : ""}`);
  lines.push(result.dryRun ? `Dry run: ${humanBytes(findings.reduce((s, f) => s + f.bytes, 0))} would be freed. Call again with confirm=true after the user agrees.` : `${humanBytes(result.bytesFreed)} freed.`);
  return text(lines.join("\n"));
});

server.registerTool("apps", {
  description: "Installed applications with size, version, source (App Store / direct / system) and last-used date.",
  inputSchema: { sizes: z.boolean().optional().describe("Compute sizes with du (slower). Default true.") },
}, async ({ sizes }) => json(await listApps(sizes !== false)));

server.registerTool("uninstall", {
  description: "Uninstall an app with its leftovers (support files, caches, preferences, containers, launch agents). Returns the plan unless confirm=true; ask the user first.",
  inputSchema: { app: z.string().describe("App name, bundle id or .app path"), confirm: z.boolean().optional() },
}, async ({ app, confirm }) => {
  const info = await findApp(app);
  if (!info) return text(`No installed app matches "${app}".`);
  const plan = await uninstallPlan(info);
  if (!confirm) return text(`Plan for ${info.name} ${info.version ?? ""} (${info.bundleId ?? "no bundle id"}):\n${formatFindings(plan)}\nCall again with confirm=true to move these to the Trash.`);
  const result = await cleanFindings(plan);
  return text(result.items.map((i) => `${i.status.padEnd(10)} ${i.path}${i.detail ? `  (${i.detail})` : ""}`).join("\n") + `\n${humanBytes(result.bytesFreed)} freed.`);
});

server.registerTool("health", { description: "CPU, memory, disk, battery and top-process snapshot (what CleanMyMac's menu-bar monitor shows).", inputSchema: {} }, async () => json(await healthSnapshot()));

server.registerTool("space_lens", {
  description: "Size tree of a folder (default home) to find what takes space.",
  inputSchema: { path: z.string().optional(), depth: z.number().int().min(1).max(4).optional(), top: z.number().int().min(5).max(100).optional() },
}, async ({ path, depth, top }) => json({ disk: await diskUsage(), tree: await spaceLens(path, depth ?? 2, top ?? 25) }));

server.registerTool("maintenance", {
  description: "List maintenance tasks, or run one. Dry run unless confirm=true. Root-only steps are returned as commands for the user to run; this server never calls sudo.",
  inputSchema: { task: z.string().optional().describe("Task id; omit to list."), confirm: z.boolean().optional() },
}, async ({ task, confirm }) => {
  if (!task) return json(MAINTENANCE_TASKS.map(({ id, title, description, steps }) => ({ id, title, description, needsRoot: steps.some((s) => s.sudo) })));
  const r = await runMaintenance(task, { dryRun: !confirm, sudo: false });
  return text(`${r.ok ? "ok" : "not completed"}\n${r.log.join("\n")}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
