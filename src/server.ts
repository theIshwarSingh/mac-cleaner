import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanFindings } from "./core/remover.js";
import type { CleanResultItem, ScanReport } from "./core/types.js";
import { DATA_DIR, ensureDataDir, run } from "./core/util.js";
import { findApp, listApps, uninstallPlan } from "./scanners/apps.js";
import { healthSnapshot } from "./scanners/health.js";
import { MAINTENANCE_TASKS, runMaintenance } from "./scanners/performance.js";
import { diskUsage, spaceLens } from "./scanners/spacelens.js";
import { MODULES, loadReport, mergeReports, parseModules, runScan, saveReport, selectFindings } from "./scan.js";

/**
 * The UI page lives in ui/index.html next to src/ or dist/. Inside the
 * packaged Mac app the server is a single Node executable, so the page is
 * found via MAC_CLEANER_UI or as index.html beside the executable.
 */
type Theme = "light" | "dark" | "system";
interface Settings { theme: Theme }
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const isTheme = (t: unknown): t is Theme => t === "light" || t === "dark" || t === "system";

async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Partial<Settings>;
    return { theme: isTheme(raw.theme) ? raw.theme : "system" };
  } catch {
    return { theme: "system" };
  }
}
async function saveSettings(s: Settings): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

async function readUi(): Promise<string> {
  const candidates = [process.env.MAC_CLEANER_UI, path.join(path.dirname(process.execPath), "index.html")];
  try { candidates.push(fileURLToPath(new URL("../ui/index.html", import.meta.url))); } catch { /* bundled: import.meta.url is empty */ }
  for (const c of candidates) {
    if (!c) continue;
    try { return await fs.readFile(c, "utf8"); } catch { /* next */ }
  }
  throw new Error("ui/index.html not found; set MAC_CLEANER_UI");
}

interface Job {
  id: number;
  kind: "scan" | "clean" | "uninstall";
  startedAt: string;
  finishedAt?: string;
  progress: string[];
  error?: string;
  result?: unknown;
}

/**
 * Local-only JSON API behind the web UI. Binds to 127.0.0.1 and never
 * removes anything unless the request says `confirm: true`.
 */
export function createApp() {
  const app = new Hono();
  const jobs = new Map<number, Job>();
  let nextJob = 1;
  let busy: Job | null = null;

  const startJob = (kind: Job["kind"], work: (job: Job) => Promise<unknown>): Job => {
    if (busy && !busy.finishedAt) throw new Error(`a ${busy.kind} job is already running`);
    const job: Job = { id: nextJob++, kind, startedAt: new Date().toISOString(), progress: [] };
    jobs.set(job.id, job);
    busy = job;
    work(job)
      .then((r) => (job.result = r))
      .catch((err: Error) => (job.error = err.message))
      .finally(() => (job.finishedAt = new Date().toISOString()));
    return job;
  };

  app.get("/", async (c) => {
    const [html, settings] = await Promise.all([readUi(), loadSettings()]);
    // The theme attribute is set before the first paint so the window never flashes the wrong scheme.
    return c.html(settings.theme === "system" ? html : html.replace("<html lang=\"en\">", `<html lang="en" data-theme="${settings.theme}">`));
  });
  app.get("/api/settings", async (c) => c.json(await loadSettings()));
  app.post("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<Settings>;
    const current = await loadSettings();
    const next: Settings = { theme: isTheme(body.theme) ? body.theme : current.theme };
    await saveSettings(next);
    return c.json(next);
  });
  app.get("/api/modules", (c) => c.json(MODULES.map(({ id, title, description }) => ({ id, title, description }))));
  app.get("/api/report", async (c) => c.json((await loadReport()) ?? null));

  app.post("/api/scan", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { modules?: string[]; fast?: boolean; sizes?: boolean };
    const modules = parseModules(body.modules ?? []);
    const job = startJob("scan", async (j) => {
      const report = await runScan({ modules, slow: !body.fast, sizes: body.sizes !== false, onProgress: (m) => j.progress.push(m) });
      const merged = mergeReports(modules.length ? await loadReport() : null, report);
      await saveReport(merged);
      return merged;
    });
    return c.json({ job: job.id });
  });

  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(Number(c.req.param("id")));
    return job ? c.json(job) : c.json({ error: "no such job" }, 404);
  });

  app.post("/api/clean", async (c) => {
    const body = (await c.req.json()) as { ids: string[]; confirm?: boolean; permanent?: boolean };
    const report = await loadReport();
    if (!report) return c.json({ error: "scan first" }, 400);
    const findings = selectFindings(report, { ids: body.ids ?? [] });
    const job = startJob("clean", async (j) => {
      const items: CleanResultItem[] = [];
      const result = await cleanFindings(findings, { dryRun: !body.confirm, permanent: Boolean(body.permanent), onProgress: (it) => { items.push(it); j.progress.push(`${it.status} ${it.path}`); } });
      if (body.confirm) {
        // Drop removed items from the saved report so the UI stays truthful.
        const gone = new Set(result.items.filter((i) => i.status === "removed" || i.status === "trashed").map((i) => i.id));
        const next: ScanReport = { ...report, modules: report.modules.map((m) => ({ ...m, groups: m.groups.map((g) => { const f = g.findings.filter((x) => !gone.has(x.id)); return { ...g, findings: f, bytes: f.reduce((s, x) => s + x.bytes, 0) }; }) })) };
        for (const m of next.modules) m.bytes = m.groups.reduce((s, g) => s + g.bytes, 0);
        next.bytes = next.modules.reduce((s, m) => s + m.bytes, 0);
        await saveReport(next);
      }
      return result;
    });
    return c.json({ job: job.id, count: findings.length });
  });

  app.get("/api/apps", async (c) => c.json(await listApps(c.req.query("sizes") !== "0")));
  app.get("/api/apps/plan", async (c) => {
    const app_ = await findApp(c.req.query("q") ?? "");
    if (!app_) return c.json({ error: "no such app" }, 404);
    return c.json({ app: app_, plan: await uninstallPlan(app_) });
  });
  app.post("/api/uninstall", async (c) => {
    const body = (await c.req.json()) as { q: string; confirm?: boolean };
    const app_ = await findApp(body.q ?? "");
    if (!app_) return c.json({ error: "no such app" }, 404);
    const plan = await uninstallPlan(app_);
    const job = startJob("uninstall", (j) => cleanFindings(plan, { dryRun: !body.confirm, onProgress: (it) => j.progress.push(`${it.status} ${it.path}`) }));
    return c.json({ job: job.id, app: app_, count: plan.length });
  });

  app.get("/api/disk", async (c) => c.json(await diskUsage()));
  app.get("/api/health", async (c) => c.json(await healthSnapshot()));
  app.get("/api/space", async (c) => c.json({ disk: await diskUsage(), tree: await spaceLens(c.req.query("path") || undefined, Number(c.req.query("depth") ?? 2), Number(c.req.query("top") ?? 25)) }));
  app.get("/api/perf", (c) => c.json(MAINTENANCE_TASKS.map(({ id, title, description, steps }) => ({ id, title, description, needsRoot: steps.some((s) => s.sudo) }))));
  app.post("/api/perf/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    // The web UI never gets sudo; root-only steps come back as printed commands.
    return c.json(await runMaintenance(c.req.param("id"), { dryRun: !body.confirm, sudo: false }));
  });
  app.post("/api/reveal", async (c) => {
    const { path } = (await c.req.json()) as { path: string };
    if (!path?.startsWith("/")) return c.json({ error: "absolute path required" }, 400);
    await run("/usr/bin/open", ["-R", path]);
    return c.json({ ok: true });
  });

  return app;
}

export async function startServer(opts: { port?: number; open?: boolean } = {}) {
  const port = opts.port ?? 4747;
  const app = createApp();
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    const url = `http://127.0.0.1:${info.port}`;
    console.log(`mac-cleaner UI at ${url}`);
    if (opts.open) void run("/usr/bin/open", [url]);
  });
}
