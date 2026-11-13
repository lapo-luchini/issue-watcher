// End-to-end checks of CLI argument handling, against a throwaway WATCHER_HOME (no network).
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemId, Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "watcher-cli-"));
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

function watcher(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, WATCHER_HOME: home },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

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

test("mcp: a missing config is a message on stderr, exit 1 and nothing on stdout", () => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp"], { env: { ...process.env, WATCHER_HOME: join(home, "nowhere") } });
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toBe("");
  expect(p.stderr.toString()).toContain("config file not found");
});
