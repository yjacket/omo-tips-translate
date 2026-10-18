import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  acquireLockToken,
  diffTemplates,
  readStore,
  releaseLock,
  storePath,
  writeStore,
} from "../src/store.ts";
import type { StoreData, Table, TipTemplate } from "../src/store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omo-tips-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(): StoreData {
  return {
    version: 1,
    omoVersion: "0.0.0-test",
    sourceHash: "abc123",
    model: { provider: "test", id: "model" },
    language: "한국어",
    enabled: true,
    table: {
      prefix: "팁: ",
      pointer: "전체 이야기",
      entries: { "computer.stop-chord": { en: "Press {0}", tr: "{0}를 누르세요" } },
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("storePath", () => {
  test("joins the agent directory with the store file name", () => {
    expect(storePath("/tmp/agent")).toBe(join("/tmp/agent", "omo-tips-translate.json"));
  });
});

describe("writeStore / readStore", () => {
  test("round-trips data and leaves no temporary file", () => {
    const path = storePath(dir);
    const data = sample();

    writeStore(path, data);

    expect(readStore(path)).toEqual({ data });
    expect(readdirSync(dir)).toEqual(["omo-tips-translate.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(data);
  });

  test("replaces an existing file atomically", () => {
    const path = storePath(dir);
    const first = sample();
    const second = { ...sample(), language: "日本語", table: { ...sample().table } };

    writeStore(path, first);
    writeStore(path, second);

    expect(readStore(path).data?.language).toBe("日本語");
    expect(readdirSync(dir)).toEqual(["omo-tips-translate.json"]);
  });

  test("creates missing parent directories", () => {
    const path = join(dir, "nested", "deeper", "omo-tips-translate.json");

    writeStore(path, sample());

    expect(readStore(path).data).toEqual(sample());
  });

  test("reports a missing file as an error", () => {
    const result = readStore(join(dir, "absent.json"));

    expect(result.data).toBeUndefined();
    expect(typeof result.error).toBe("string");
  });

  test("reports corrupted JSON as an error", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json", "utf8");

    const result = readStore(path);

    expect(result.data).toBeUndefined();
    expect(typeof result.error).toBe("string");
  });

  test("reports schema mismatches as an error", () => {
    const path = join(dir, "bad.json");
    const cases: unknown[] = [
      null,
      [],
      {},
      { ...sample(), version: 2 },
      { ...sample(), model: { provider: "p" } },
      { ...sample(), enabled: "yes" },
      { ...sample(), declinedHash: 7 },
      { ...sample(), table: { prefix: "p", pointer: "q", entries: [] } },
      { ...sample(), table: { prefix: "p", pointer: "q", entries: { x: { en: "a" } } } },
    ];

    for (const bad of cases) {
      writeFileSync(path, JSON.stringify(bad), "utf8");
      const result = readStore(path);
      expect(result.data).toBeUndefined();
      expect(typeof result.error).toBe("string");
    }
  });

  test("accepts an optional declinedHash", () => {
    const path = storePath(dir);
    const data = { ...sample(), declinedHash: "old-hash" };

    writeStore(path, data);

    expect(readStore(path).data?.declinedHash).toBe("old-hash");
  });
});

describe("acquireLock / releaseLock", () => {
  test("acquires a fresh lock and blocks a second owner", () => {
    const path = storePath(dir);
    const now = 1_000_000;

    expect(acquireLock(path, now)).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(acquireLock(path, now + 1)).toBe(false);
  });

  test("returns a unique owner token and records it in the lock file", () => {
    const path = storePath(dir);

    const token = acquireLockToken(path, 1_000);

    expect(typeof token).toBe("string");
    expect(token?.startsWith(`${process.pid}-`)).toBe(true);
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).token).toBe(token);
    expect(acquireLockToken(path, 1_001)).toBeUndefined();
  });

  test("releases only when the token matches", () => {
    const path = storePath(dir);
    const token = acquireLockToken(path, 1_000);

    releaseLock(path, "someone-else");
    expect(existsSync(`${path}.lock`)).toBe(true);

    releaseLock(path, token);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a token from a stale lock cannot release the new owner's lock", () => {
    const path = storePath(dir);
    const now = 2_000_000;
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({ pid: 123, token: "old", at: now - 10 * 60 * 1000 - 1 }),
      "utf8",
    );

    const token = acquireLockToken(path, now);
    expect(typeof token).toBe("string");

    releaseLock(path, "old");
    expect(existsSync(`${path}.lock`)).toBe(true);

    releaseLock(path, token);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("releases the lock so it can be acquired again", () => {
    const path = storePath(dir);

    expect(acquireLock(path, 1_000)).toBe(true);
    releaseLock(path);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(acquireLock(path, 1_001)).toBe(true);
  });

  test("treats a lock older than ten minutes as stale", () => {
    const path = storePath(dir);
    const now = 2_000_000;
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({ pid: 123, at: now - 10 * 60 * 1000 - 1 }),
      "utf8",
    );

    expect(acquireLock(path, now)).toBe(true);
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).at).toBe(now);
  });

  test("keeps a lock exactly at the ten minute boundary", () => {
    const path = storePath(dir);
    const now = 3_000_000;
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 123, at: now - 10 * 60 * 1000 }), "utf8");

    expect(acquireLock(path, now)).toBe(false);
  });

  test("does not replace a fresh malformed lock", () => {
    const path = storePath(dir);
    writeFileSync(`${path}.lock`, "not json", "utf8");

    expect(acquireLock(path)).toBe(false);
  });

  test("releasing a missing lock is a no-op", () => {
    expect(() => releaseLock(storePath(dir))).not.toThrow();
  });
});

describe("diffTemplates", () => {
  const table: Table = {
    prefix: "팁: ",
    pointer: "pointer",
    entries: {
      same: { en: "same text", tr: "같음" },
      changed: { en: "old text", tr: "옛것" },
    },
  };

  test("returns templates that are missing or whose English changed", () => {
    const templates: TipTemplate[] = [
      { id: "same", en: "same text", slots: 0 },
      { id: "changed", en: "new text", slots: 0 },
      { id: "missing", en: "brand new", slots: 1 },
    ];

    expect(diffTemplates(templates, table)).toEqual([
      { id: "changed", en: "new text", slots: 0 },
      { id: "missing", en: "brand new", slots: 1 },
    ]);
  });

  test("returns an empty list when every template is current", () => {
    expect(diffTemplates([{ id: "same", en: "same text", slots: 0 }], table)).toEqual([]);
  });
});
