/** A single removable (or report-only) item found by a scanner. */
export interface Finding {
  /** Stable id: sha1 of module/group/path, so `clean --ids` can target it across runs. */
  id: string;
  module: ModuleId;
  group: string;
  /** Human label, usually the leaf name or an app name. */
  title: string;
  /** Absolute path (or a synthetic `task:` / `tcc:` reference for non-file items). */
  path: string;
  /** Bytes reclaimable. 0 when unknown or not applicable. */
  bytes: number;
  kind: "file" | "directory" | "task" | "record";
  /** True when `clean` may act on it without extra flags. */
  autoSelect: boolean;
  /** How the remover should treat it. */
  action: "trash" | "delete" | "command" | "report";
  /** Needs root (sudo). The CLI prints the command instead of running it unless --sudo. */
  needsRoot?: boolean;
  /** Why we think it is junk, or why it is report-only. */
  note?: string;
  /** Extra data for the UI (device name, last-used date, ...). */
  meta?: Record<string, string | number | boolean | null>;
}

export type ModuleId =
  | "cleanup"
  | "applications"
  | "performance"
  | "protection"
  | "clutter";

export interface GroupResult {
  id: string;
  title: string;
  description: string;
  findings: Finding[];
  bytes: number;
  /** Set when the group could not be scanned fully (missing permission, tool). */
  warning?: string;
}

export interface ModuleResult {
  id: ModuleId;
  title: string;
  groups: GroupResult[];
  bytes: number;
  durationMs: number;
}

export interface ScanReport {
  version: 1;
  createdAt: string;
  host: string;
  modules: ModuleResult[];
  bytes: number;
}

export interface ScanOptions {
  /** Deep size calculation (du) for every directory. Default true. */
  sizes?: boolean;
  /** Include slow scanners (duplicates hashing, mdfind sweeps). Default true. */
  slow?: boolean;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
}

export interface CleanResultItem {
  id: string;
  path: string;
  bytes: number;
  status: "removed" | "trashed" | "skipped" | "failed" | "dry-run" | "needs-root";
  detail?: string;
}

export interface CleanReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  permanent: boolean;
  items: CleanResultItem[];
  bytesFreed: number;
}

export type GroupScanner = (opts: ScanOptions) => Promise<GroupResult>;
