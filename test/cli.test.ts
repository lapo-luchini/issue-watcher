// End-to-end checks of CLI argument handling, against a throwaway WATCHER_HOME (no network).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { itemId, Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
let home: string;

afterEach(cleanupTmp);

beforeEach(() => {
  home = tmpDir("cli");
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "var"));
  writeFileSync(join(home, "data/config.yaml"), "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\n");
  const store = new Store(join(home, "var/cache.sqlite"));
  store.upsertItem({
    url: PR, id: itemId(PR), instance: "github", kind: "pr", repo: "foo/bar", title: "Fix build",
    state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: true, maintainedByMe: false, labels: [],
    lastSignalAt: "2026-11-04T10:00:00.000Z", lastSignalSummary: "comment by @maint: LGTM", seenAt: null,
    baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
  });
  store.close();
});

function watcherWith(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, WATCHER_REGISTER: "", WATCHER_HOME: home, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const watcher = (...args: string[]) => watcherWith({}, ...args);

function seenAt(): string | null {
  const store = new Store(join(home, "var/cache.sqlite"));
  try {
    return store.getItem(PR)?.seenAt ?? null;
  } finally {
    store.close();
  }
}

test("serve rejects a bad port", () => {
  const r = watcher("serve", "--port", "abc");
  expect(r.code).toBe(2);
  expect(r.err).toContain("invalid port 'abc'");
});

test("seen without URLs refuses to mark everything", () => {
  const r = watcher("seen");
  expect(r.code).toBe(2);
  expect(r.err).toContain("seen --all");
  expect(seenAt()).toBeNull();
});

test("seen --all marks every item", () => {
  const r = watcher("seen", "--all");
  expect(r).toMatchObject({ code: 0, out: "1 item(s) marked seen\n" });
  expect(seenAt()).not.toBeNull();
});

test("seen URL marks that item, also from a browser-copied URL; an unknown URL gets a hint", () => {
  expect(watcher("seen", PR)).toMatchObject({ code: 0, out: "1 item(s) marked seen\n" });
  expect(watcher("seen", `${PR}/files#diff-1`)).toMatchObject({ code: 0, out: "1 item(s) marked seen\n" });
  const r = watcher("seen", "https://github.com/foo/bar/pull/43");
  expect(r.code).toBe(1);
  expect(r.out).toContain("0 item(s) marked seen");
  expect(r.err).toContain("no item with URL https://github.com/foo/bar/pull/43");
  expect(r.err).toContain("canonical");
});

const ISSUE = "https://github.com/foo/bar/issues/7";

function addIssue() {
  const store = new Store(join(home, "var/cache.sqlite"));
  store.upsertItem({
    url: ISSUE, id: itemId(ISSUE), instance: "github", kind: "issue", repo: "foo/bar", title: "Crash",
    state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [],
    lastSignalAt: null, lastSignalSummary: null, seenAt: null,
    baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
  });
  return store;
}

function registerFiles(files: Record<string, string>) {
  mkdirSync(join(home, "data/registers"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, "data/registers", name), text);
}

test("registers lists default first, then the files of data/registers/", () => {
  expect(watcher("registers")).toMatchObject({ code: 0, out: "default\n" });
  registerFiles({ "zeta.yaml": "items:\n", "alpha.yaml": "items:\n" });
  expect(watcher("registers")).toMatchObject({ code: 0, out: "default\nalpha\nzeta\n" });
});

test("list shows one register: default is the whole cache, another its own entries; the environment names the default", () => {
  addIssue().close();
  registerFiles({ "houston.yaml": `items:\n  - url: ${ISSUE}\n` });
  const titles = (out: string) => (out.match(/https:\/\/github\.com\S+/g) ?? []).map((u) => (u.endsWith("/42") ? "Fix build" : "Crash"));
  expect(titles(watcher("list", "--all").out)).toEqual(["Fix build", "Crash"]);
  expect(titles(watcher("list", "--all", "--register", "default").out)).toEqual(["Fix build", "Crash"]);
  expect(titles(watcher("list", "--all", "--register", "houston").out)).toEqual(["Crash"]);
  expect(titles(watcherWith({ WATCHER_REGISTER: "houston" }, "list", "--all").out)).toEqual(["Crash"]);
  expect(titles(watcherWith({ WATCHER_REGISTER: "houston" }, "list", "--all", "--register", "default").out)).toEqual(["Fix build", "Crash"]);
});

test("a register that does not exist, or whose name is not a plain name, is refused", () => {
  const nope = watcher("list", "--register", "nope");
  expect(nope.code).toBe(2);
  expect(nope.err).toContain("no such register: nope (registers: default)");
  for (const bad of ["../x", "a/b", "A", ".h"]) {
    const r = watcher("list", "--register", bad);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`invalid register name '${bad}'`);
    expect(r.out).toBe("");
    const e = watcherWith({ WATCHER_REGISTER: bad }, "list");
    expect(e.code).toBe(1);
    expect(e.err).toContain(`invalid register name '${bad}'`);
  }
  // `mcp` too: stdout stays empty, the problem is on stderr.
  const m = watcherWith({ WATCHER_REGISTER: "../x" }, "mcp");
  expect(m).toMatchObject({ code: 1, out: "" });
  expect(m.err).toContain("invalid register name");
});

test("a register file that cannot be read is named in the error", () => {
  registerFiles({ "bad.yaml": "items:\n  - url: nope\n" });
  const r = watcher("list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("registers/bad.yaml: items[0]: invalid url");
});

test("a URL no instance recognizes is warned about with its register's file name", () => {
  registerFiles({ "houston.yaml": "items:\n  - url: https://unknown.example/x/1\n" });
  expect(watcher("list").err).toContain("warning: registers/houston.yaml: no configured instance recognizes https://unknown.example/x/1; ignored");
});

test("refilter judges an item by the entries of every register: important in one is important", () => {
  const store = addIssue();
  store.insertEvent({
    itemUrl: ISSUE, key: "ci:1", kind: "ci", actor: "ci", actorRole: "bot", at: "2026-11-04T09:00:00.000Z",
    detectedAt: "2026-11-04T10:00:00.000Z", excerpt: null, details: null, isSignal: false, reason: "low-priority:ci", isBaseline: false,
  });
  store.close();
  expect(watcher("refilter").out).toBe("0 event verdict(s) changed\n"); // normal everywhere
  registerFiles({ "houston.yaml": `items:\n  - url: ${ISSUE}\n    priority: important\n` });
  expect(watcher("refilter").out).toBe("1 event verdict(s) changed\n");
});

/** Runs `watcher mcp` with these lines on stdin; it ends at the end of stdin. */
function mcp(lines: unknown[]) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp"], {
    env: { ...process.env, WATCHER_HOME: home }, stdin: Buffer.from(lines.map((l) => JSON.stringify(l) + "\n").join("")),
  });
  const out = p.stdout.toString();
  return { code: p.exitCode, replies: out.split("\n").filter((l) => l).map((l) => JSON.parse(l)), err: p.stderr.toString() };
}

test("mcp: initialize, tools/list and tools/call over stdio; stdout is protocol only; read-only by default", () => {
  const r = mcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_items", arguments: { unread: true } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mark_seen", arguments: { all: true } } },
  ]);
  expect(r.code).toBe(0);
  expect(r.replies.map((x) => x.id)).toEqual([1, 2, 3, 4]);
  expect(r.replies[0].result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "watcher", version: "0.1.0" } });
  expect(r.replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["list_items", "get_item", "updates", "status"]);
  const items = JSON.parse(r.replies[2].result.content[0].text).items;
  expect(items).toMatchObject([{ url: PR, title: "Fix build", unread: true }]);
  expect(r.replies[3].error.code).toBe(-32602);
  expect(seenAt()).toBeNull();
});

test("mcp: a long reply is written whole before the process exits", () => {
  const store = new Store(join(home, "var/cache.sqlite"));
  for (let i = 0; i < 1500; i++) {
    const url = `https://github.com/foo/bar/issues/${i}`;
    store.upsertItem({
      url, id: itemId(url), instance: "github", kind: "issue", repo: "foo/bar", title: `${"long title ".repeat(10)}${i}`,
      state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [],
      lastSignalAt: null, lastSignalSummary: null, seenAt: null, baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
    });
  }
  store.close();
  const r = mcp([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_items", arguments: {} } }]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.replies[0].result.content[0].text).items).toHaveLength(1501);
});

test("mcp: a missing config is a message on stderr, exit 1 and nothing on stdout", () => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp"], { env: { ...process.env, WATCHER_HOME: join(home, "nowhere") } });
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toBe("");
  expect(p.stderr.toString()).toContain("config file not found");
});
