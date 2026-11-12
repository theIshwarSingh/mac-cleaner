import path from "node:path";
import { HOME, run } from "../core/util.js";

export interface SpaceNode {
  name: string;
  path: string;
  bytes: number;
  children?: SpaceNode[];
}

/**
 * Space Lens: a size tree for a folder, built from one `du` run so it is fast
 * even on a full home folder. CleanMyMac uses a privileged "Traverser" to reach
 * everything; we stay inside what the current user can read.
 */
export async function spaceLens(root = HOME, depth = 2, top = 25): Promise<SpaceNode> {
  const r = await run("/usr/bin/du", ["-kx", "-d", String(depth), root], { timeoutMs: 900_000 });
  const sizes = new Map<string, number>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(\d+)\t(.*)$/.exec(line);
    if (m) sizes.set(m[2], Number(m[1]) * 1024);
  }
  const build = (p: string, level: number): SpaceNode => {
    const node: SpaceNode = { name: p === root ? root : path.basename(p), path: p, bytes: sizes.get(p) ?? 0 };
    if (level >= depth) return node;
    const kids: SpaceNode[] = [];
    const prefix = p.endsWith("/") ? p : p + "/";
    for (const [k] of sizes) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) kids.push(build(k, level + 1));
    }
    kids.sort((a, b) => b.bytes - a.bytes);
    const kept = kids.slice(0, top);
    const rest = kids.slice(top).reduce((s, k) => s + k.bytes, 0);
    const files = node.bytes - kids.reduce((s, k) => s + k.bytes, 0);
    if (files > 0) kept.push({ name: "(files)", path: p, bytes: files });
    if (rest > 0) kept.push({ name: `(${kids.length - top} more)`, path: p, bytes: rest });
    node.children = kept;
    return node;
  };
  return build(root, 0);
}

export async function diskUsage(): Promise<{ mount: string; totalBytes: number; usedBytes: number; freeBytes: number; purgeableBytes: number | null }> {
  // "/" is the sealed system snapshot (~14 GB); user data lives on the Data volume.
  let df = await run("/bin/df", ["-k", "/System/Volumes/Data"]);
  if (df.code !== 0 || !/\d/.test(df.stdout)) df = await run("/bin/df", ["-k", "/"]);
  const line = df.stdout.trim().split("\n").pop() ?? "";
  const cols = line.split(/\s+/);
  const total = Number(cols[1]) * 1024;
  const used = Number(cols[2]) * 1024;
  const free = Number(cols[3]) * 1024;
  // Purgeable space comes from diskutil's APFS container info.
  const du = await run("/usr/sbin/diskutil", ["info", "-plist", "/"], { timeoutMs: 20_000 });
  const m = /<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/.exec(du.stdout);
  const containerFree = m ? Number(m[1]) : null;
  return { mount: "/", totalBytes: total, usedBytes: used, freeBytes: free, purgeableBytes: containerFree != null ? Math.max(0, containerFree - free) : null };
}
