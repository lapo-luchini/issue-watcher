// Changes to a register other than `default`: its own file, its own commit, the same lock.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { addItem, changeIntent, type IntentRepo } from "../src/core/api.ts";
import type { ItemRef } from "../src/core/model.ts";
import { itemId, Store } from "../src/core/store.ts";

let home: string;
let where: IntentRepo;
let store: Store;
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString();
const file = (name: string) => readFileSync(join(home, name), "utf8");
const recognize = (url: string): ItemRef | null => {
  const m = url.match(/^(https:\/\/github\.com\/\w+\/\w+\/(pull|issues)\/\d+)(\/files)?$/);
  return m ? { url: m[1]!, instance: "github", kind: m[2] === "pull" ? "pr" : "issue" } : null;
};
const canonical = (url: string) => recognize(url)?.url ?? url;
const PR = "https://github.com/foo/bar/pull/42";

afterEach(cleanupTmp);

beforeEach(() => {
  home = tmpDir("regwrite");
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.org"]]) git(...args);
  mkdirSync(join(home, "data/registers"), { recursive: true });
  writeFileSync(join(home, "data/items.yaml"), `items:\n  - url: ${PR}\n    note: mine\n`);
  writeFileSync(join(home, "data/registers/houston.yaml"), `# houston's\nitems:\n  - url: ${PR}\n`);
  git("add", "-f", "."), git("commit", "-qm", "init");
  store = new Store(":memory:");
  where = { home, branch: "config" };
});

test("changeIntent on a register edits that file only, and commits it with the register in the message", async () => {
  const r = await changeIntent(where, PR, { priority: "important" }, canonical, undefined, "houston");
  expect(r).toEqual({ ok: true });
  expect(file("data/registers/houston.yaml")).toBe(`# houston's\nitems:\n  - url: ${PR}\n    priority: important\n`);
  expect(file("data/items.yaml")).toBe(`items:\n  - url: ${PR}\n    note: mine\n`);
  expect(git("log", "-1", "config", "--format=%s")).toBe("watcher: mark foo/bar#42 important (register houston)\n");
  expect(git("show", "--name-only", "--format=", "config")).toBe("data/registers/houston.yaml\n");
});

test("the message of a change to default has no register in it", async () => {
  await changeIntent(where, PR, { muted: true }, canonical, undefined, "default");
  expect(git("log", "-1", "config", "--format=%s")).toBe("watcher: mute foo/bar#42\n");
  expect(git("show", "--name-only", "--format=", "config")).toBe("data/items.yaml\n");
});

test("the same item has its own curation in each register", async () => {
  await changeIntent(where, PR, { muted: true }, canonical, undefined, "houston");
  await changeIntent(where, PR, { note: "for houston" }, canonical, undefined, "houston");
  expect(file("data/registers/houston.yaml")).toContain("muted: true");
  expect(file("data/items.yaml")).not.toContain("muted");
  expect(git("rev-list", "--count", "config")).toBe("3\n"); // init + one commit per change
});

test("uncommitted hand edits to a register file are mentioned with that file's name", async () => {
  writeFileSync(join(home, "data/registers/houston.yaml"), file("data/registers/houston.yaml") + "# by hand\n");
  await changeIntent(where, PR, { muted: true }, canonical, undefined, "houston");
  expect(git("log", "-1", "config", "--format=%B").trim()).toBe(
    "watcher: mute foo/bar#42 (register houston)\n\nAlso commits earlier changes to data/registers/houston.yaml that were not committed yet.");
});

test("addItem to a new register creates its file (and the directory) and commits it", async () => {
  rmDir("data/registers");
  const r = await addItem(where, store, new Map(), recognize, PR, undefined, "fresh");
  expect(r).toMatchObject({ url: PR, manual: false });
  expect(file("data/registers/fresh.yaml")).toBe(`items:\n  - url: ${PR}\n`);
  expect(git("show", "config:data/registers/fresh.yaml")).toBe(`items:\n  - url: ${PR}\n`);
  expect(git("log", "-1", "config", "--format=%s")).toBe("watcher: add foo/bar#42 (register fresh)\n");
});

function rmDir(rel: string) {
  Bun.spawnSync(["rm", "-rf", join(home, rel)]);
}

test("addItem refuses an item already in that register, not one only in another or in the cache", async () => {
  const row = {
    url: PR, id: itemId(PR), instance: "github", kind: "pr" as const, repo: "foo/bar", title: "t", state: "open" as const,
    stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [],
    lastSignalAt: null, lastSignalSummary: null, seenAt: null, baselineAt: "2026-11-01T00:00:00.000Z",
    fetchedAt: "2026-11-01T00:00:00.000Z", snapshotJson: null,
  };
  store.upsertItem(row);
  const other = "https://github.com/foo/bar/issues/7";
  // In the cache and in no entry of `houston`, so it can be added there; it is in the cache for `default` (as before).
  await expect(addItem(where, store, new Map(), recognize, other, undefined, "default")).resolves.toMatchObject({ url: other });
  store.upsertItem({ ...row, url: other, id: itemId(other) });
  await expect(addItem(where, store, new Map(), recognize, other, undefined, "default")).rejects.toThrow(`already tracked: ${other}`);
  await expect(addItem(where, store, new Map(), recognize, other, undefined, "houston")).resolves.toMatchObject({ url: other });
  const inHouston = new Map([[other, { url: other, muted: false, manual: false }]]);
  await expect(addItem(where, store, inHouston, recognize, other, undefined, "houston")).rejects.toThrow(`already tracked: ${other}`);
});

test("a manual item added to a register is listed there only", async () => {
  await addItem(where, store, new Map(), recognize, "https://lists.example.org/p1", "[PATCH] x", "houston");
  expect(file("data/registers/houston.yaml")).toContain("manual: true");
  expect(file("data/items.yaml")).not.toContain("lists.example.org");
});

test("a register name that is not a plain name never reaches the file system", async () => {
  for (const bad of ["../escape", "a/b", ".x", ""]) {
    await expect(changeIntent(where, PR, { muted: true }, canonical, undefined, bad)).rejects.toThrow("invalid register name");
    await expect(addItem(where, store, new Map(), recognize, PR, undefined, bad)).rejects.toThrow("invalid register name");
  }
  expect(existsSync(join(home, "data/escape.yaml"))).toBe(false);
  expect(Bun.spawnSync(["git", "-C", home, "rev-parse", "--verify", "-q", "refs/heads/config"]).exitCode).not.toBe(0); // nothing was committed
});

test("a link or a directory where a register's file should be is not written through", async () => {
  writeFileSync(join(home, "outside.yaml"), "items: []\n");
  symlinkSync(join(home, "outside.yaml"), join(home, "data/registers/link.yaml"));
  mkdirSync(join(home, "data/registers/dir.yaml"));
  for (const name of ["link", "dir"]) {
    await expect(changeIntent(where, PR, { muted: true }, canonical, undefined, name)).rejects.toThrow(`registers/${name}.yaml is not a regular file`);
    await expect(addItem(where, store, new Map(), recognize, PR, undefined, name)).rejects.toThrow("is not a regular file");
  }
  expect(file("outside.yaml")).toBe("items: []\n");
});

test("a duplicate found inside the lock names the register's file", async () => {
  // Two callers both saw the entry missing; the second one finds it in the file.
  await addItem(where, store, new Map(), recognize, PR.replace("42", "9"), undefined, "houston");
  await expect(addItem(where, store, new Map(), recognize, PR.replace("42", "9"), undefined, "houston")).rejects.toThrow("already listed in registers/houston.yaml");
});
