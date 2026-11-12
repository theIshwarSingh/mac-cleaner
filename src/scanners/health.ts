import os from "node:os";
import { run } from "../core/util.js";
import { diskUsage } from "./spacelens.js";

export interface HealthSnapshot {
  at: string;
  cpu: { loadAvg1: number; cores: number; userPct: number | null; sysPct: number | null; idlePct: number | null };
  memory: { totalBytes: number; usedBytes: number; appBytes: number; wiredBytes: number; compressedBytes: number; cachedBytes: number; pressure: "normal" | "warn" | "critical" | "unknown"; swapUsedBytes: number | null };
  disk: Awaited<ReturnType<typeof diskUsage>>;
  battery: { percent: number | null; charging: boolean | null; cycleCount: number | null; condition: string | null } | null;
  thermal: string | null;
  uptimeSec: number;
  topProcesses: { pid: number; cpu: number; mem: number; command: string }[];
}

/** Menu-bar style health snapshot (CleanMyMac's HealthMonitor login item shows the same numbers). */
export async function healthSnapshot(): Promise<HealthSnapshot> {
  const pageSize = Number((await run("/usr/sbin/sysctl", ["-n", "hw.pagesize"])).stdout.trim()) || 16384;
  const vm = (await run("/usr/bin/vm_stat", [])).stdout;
  // vm_stat labels: "Pages wired down:", "Pages purgeable:", "Anonymous pages:", "File-backed pages:", "Pages occupied by compressor:".
  const page = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(vm)?.[1] ?? 0) * pageSize;
  const anon = page("Anonymous pages"), wired = page("Pages wired down"), compressed = page("Pages occupied by compressor"), purgeable = page("Pages purgeable"), fileBacked = page("File-backed pages");
  const total = os.totalmem();
  const app = Math.max(0, anon - purgeable);
  const used = app + wired + compressed;
  const swap = /used = ([\d.]+)M/.exec((await run("/usr/sbin/sysctl", ["-n", "vm.swapusage"])).stdout);
  const pressureRaw = (await run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).stdout.trim();
  const pressure = pressureRaw === "1" ? "normal" : pressureRaw === "2" ? "warn" : pressureRaw === "4" ? "critical" : "unknown";

  const top = (await run("/usr/bin/top", ["-l", "2", "-n", "8", "-o", "cpu", "-stats", "pid,cpu,mem,command"], { timeoutMs: 20_000 })).stdout;
  const second = top.split("Processes:").pop() ?? "";
  const cpuLine = /CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/.exec(second);
  const procs: HealthSnapshot["topProcesses"] = [];
  for (const line of second.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (m && procs.length < 8) procs.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: parseMem(m[3]), command: m[4].trim() });
  }

  const batt = (await run("/usr/bin/pmset", ["-g", "batt"])).stdout;
  const pm = /(\d+)%; (\w[\w ]*?);/.exec(batt);
  let battery: HealthSnapshot["battery"] = null;
  if (pm) {
    const ioreg = (await run("/usr/sbin/ioreg", ["-rn", "AppleSmartBattery"])).stdout;
    battery = { percent: Number(pm[1]), charging: /charging|charged/.test(pm[2]) && !/discharging/.test(pm[2]), cycleCount: Number(/"CycleCount" = (\d+)/.exec(ioreg)?.[1] ?? NaN) || null, condition: /"PermanentFailureStatus" = 0/.test(ioreg) ? "Normal" : null };
  }
  const therm = (await run("/usr/bin/pmset", ["-g", "therm"])).stdout;
  const thermal = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm)?.[1];

  return {
    at: new Date().toISOString(),
    cpu: { loadAvg1: os.loadavg()[0], cores: os.cpus().length, userPct: cpuLine ? Number(cpuLine[1]) : null, sysPct: cpuLine ? Number(cpuLine[2]) : null, idlePct: cpuLine ? Number(cpuLine[3]) : null },
    memory: { totalBytes: total, usedBytes: used, appBytes: app, wiredBytes: wired, compressedBytes: compressed, cachedBytes: fileBacked, pressure, swapUsedBytes: swap ? Math.round(Number(swap[1]) * 1024 * 1024) : null },
    disk: await diskUsage(),
    battery,
    thermal: thermal ? `CPU speed limit ${thermal}%` : null,
    uptimeSec: os.uptime(),
    topProcesses: procs,
  };
}

function parseMem(s: string): number {
  const m = /^([\d.]+)([KMG]?)/.exec(s);
  if (!m) return 0;
  const mult = m[2] === "G" ? 1e9 : m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1;
  return Number(m[1]) * mult;
}
