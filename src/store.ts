import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Structural types shared with src/extract.ts and src/match.ts. These are
// declared locally because those modules live in other write lanes.
export type TipTemplate = { id: string; en: string; slots: number };
export type Entry = { en: string; tr: string };
export type Table = {
  prefix: string;
  pointer: string;
  entries: Record<string, Entry>;
};

export type StoreData = {
  version: 1;
  omoVersion: string;
  sourceHash: string;
  model: { provider: string; id: string };
  language: string;
  enabled: boolean;
  declinedHash?: string;
  table: Table;
  updatedAt: string;
};

const LOCK_STALE_MS = 10 * 60 * 1000;

export function storePath(agentDir: string): string {
  return join(agentDir, "omo-tips-translate.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoreData(value: unknown): value is StoreData {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.omoVersion !== "string") return false;
  if (typeof value.sourceHash !== "string") return false;
  if (typeof value.language !== "string") return false;
  if (typeof value.enabled !== "boolean") return false;
  if (typeof value.updatedAt !== "string") return false;
  if (value.declinedHash !== undefined && typeof value.declinedHash !== "string") return false;

  const model = value.model;
  if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
    return false;
  }

  const table = value.table;
  if (!isRecord(table)) return false;
  if (typeof table.prefix !== "string" || typeof table.pointer !== "string") return false;
  if (!isRecord(table.entries)) return false;

  for (const entry of Object.values(table.entries)) {
    if (!isRecord(entry) || typeof entry.en !== "string" || typeof entry.tr !== "string") {
      return false;
    }
  }

  return true;
}

export function readStore(path: string): { data?: StoreData; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (!isStoreData(parsed)) {
    return { error: "invalid store schema" };
  }

  return { data: parsed };
}

export function writeStore(path: string, data: StoreData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may not exist; the original error is what matters.
    }
    throw error;
  }
}

function lockAge(lock: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(lock, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.at === "number" && Number.isFinite(parsed.at)) {
      return parsed.at;
    }
  } catch {
    // Fall through to the file mtime for malformed lock files.
  }

  try {
    return statSync(lock).mtimeMs;
  } catch {
    return undefined;
  }
}

export function acquireLock(path: string, now = Date.now()): boolean {
  const lock = `${path}.lock`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        return false;
      }
    }

    const at = lockAge(lock);
    if (at === undefined || now - at <= LOCK_STALE_MS) {
      return false;
    }

    try {
      unlinkSync(lock);
    } catch {
      return false;
    }
  }

  return false;
}

export function releaseLock(path: string): void {
  try {
    unlinkSync(`${path}.lock`);
  } catch {
    // Releasing a missing lock is a no-op.
  }
}

export function diffTemplates(templates: TipTemplate[], table: Table): TipTemplate[] {
  return templates.filter((template) => {
    const entry = table.entries[template.id];
    return entry === undefined || entry.en !== template.en;
  });
}
