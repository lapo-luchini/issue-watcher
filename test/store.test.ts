import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FILTER } from "../src/core/config.ts";
import { refilter } from "../src/core/poller.ts";
import { itemId, lockHolder, Store, type EventRow, type ItemRow } from "../src/core/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

const url = "https://github.com/foo/bar/pull/42";
const item: ItemRow = {
  url, id: itemId(url), instance: "github", kind: "pr", repo: "foo/bar", title: "Fix build",
  state: "open", stateDetail: null, ciState: "success", hasConflicts: false, authoredByMe: true, maintainedByMe: false,
  labels: ["bug"], lastSignalAt: null, lastSignalSummary: null, seenAt: null,
  baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-01T00:00:00.000Z", snapshotJson: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
};
const event: EventRow = {
  itemUrl: url, key: "c:1", kind: "comment", actor: "maint", actorRole: "maintainer",
  at: "2026-11-02T00:00:00.000Z", detectedAt: "2026-11-02T00:05:00.000Z", excerpt: "LGTM",
  details: { x: 1 }, isSignal: true, reason: "signal:maintainer-comment", isBaseline: false,
  approxAt: "2026-11-02T00:03:00.000Z",
};

test("itemId is short and stable", () => {
  expect(itemId(url)).toHaveLength(10);
  expect(itemId(url)).toBe(itemId(url));
});

test("item upsert round-trips and updates", () => {
  store.upsertItem(item);
  expect(store.getItem(url)).toEqual(item);
  store.upsertItem({ ...item, state: "merged", labels: [] });
  expect(store.getItem(url)?.state).toBe("merged");
  expect(store.getItem(url)?.labels).toEqual([]);
  expect(store.listItems()).toHaveLength(1);
  expect(store.getItem("nope")).toBeNull();
});

test("events dedup by key and filter noise", () => {
  expect(store.insertEvent(event)).toBe(true);
  expect(store.insertEvent(event)).toBe(false);
  store.insertEvent({ ...event, key: "c:2", isSignal: false, reason: "noise:+1", details: null });
  expect(store.eventsFor(url)).toEqual([event]);
  expect(store.eventsFor(url, true)).toHaveLength(2);
  store.setVerdict(url, "c:2", { isSignal: true, reason: "signal:comment" });
  expect(store.eventsFor(url)).toHaveLength(2);
});

test("listKnown: open items, plus closed ones fetched recently, with their state; never gone ones or other instances", () => {
  const at = (u: string, state: ItemRow["state"], fetchedAt: string, instance = "github") =>
    store.upsertItem({ ...item, url: u, id: itemId(u), state, fetchedAt, instance });
  at("https://x/open-old", "open", "2026-01-01T00:00:00.000Z");
  at("https://x/merged-recent", "merged", "2026-11-01T00:00:00.000Z");
  at("https://x/closed-old", "closed", "2026-01-01T00:00:00.000Z");
  at("https://x/gone-recent", "gone", "2026-11-01T00:00:00.000Z");
  at("https://x/other", "open", "2026-11-01T00:00:00.000Z", "gitlab");
  expect(store.listKnown("github", "2026-10-01T00:00:00.000Z")).toEqual([
    { url: "https://x/merged-recent", instance: "github", kind: "pr", state: "merged" },
    { url: "https://x/open-old", instance: "github", kind: "pr", state: "open" },
  ]);
});

test("seen markers", () => {
  store.upsertItem(item);
  expect(store.markSeen(url, "2026-11-03T00:00:00.000Z")).toBe(true);
  expect(store.getItem(url)?.seenAt).toBe("2026-11-03T00:00:00.000Z");
  expect(store.markSeen("nope", "x")).toBe(false);
  expect(store.markAllSeen("2026-11-04T00:00:00.000Z")).toBe(1);
});

test("cursor is taken from the latest run", () => {
  expect(store.getCursor("github")).toBeNull();
  store.recordRun({ instance: "github", startedAt: "a", finishedAt: "b", cursor: "c1", error: null });
  store.recordRun({ instance: "github", startedAt: "a", finishedAt: "b", cursor: "c2", error: null });
  store.recordRun({ instance: "other", startedAt: "a", finishedAt: "b", cursor: "zz", error: null });
  expect(store.getCursor("github")).toBe("c2");
});

test("locks exclude, release, and expire", () => {
  const t0 = new Date("2026-11-04T10:00:00Z");
  expect(store.acquireLock("poll", "a", t0)).toBe(true);
  expect(store.acquireLock("poll", "b", t0)).toBe(false);
  store.releaseLock("poll");
  expect(store.acquireLock("poll", "b", t0)).toBe(true);
  const muchLater = new Date(t0.getTime() + 31 * 60_000);
  expect(store.acquireLock("poll", "c", muchLater)).toBe(true);
});

test("a cursor belongs to the discovery settings it was made with; runs from before scopes match any", () => {
  store.recordRun({ instance: "kde", startedAt: "a", finishedAt: "b", cursor: "c0", error: null }); // an old cache
  expect(store.getCursor("kde", "s1")).toBe("c0");
  store.recordRun({ instance: "kde", startedAt: "a", finishedAt: "b", cursor: "c1", error: null, scope: "s1" });
  expect(store.getCursor("kde", "s1")).toBe("c1");
  expect(store.getCursor("kde", "s2")).toBeNull();
  expect(store.getCursor("kde")).toBe("c1"); // without a scope: the latest, whatever its settings
});

test("a lock held by a process that no longer exists on this host is taken over at once", () => {
  const t0 = new Date("2026-11-04T10:00:00Z");
  // A pid that is certainly not running: spawn a process and wait for it to exit.
  const dead = lockHolder(Bun.spawnSync(["true"]).pid);
  expect(store.acquireLock("poll", dead, t0)).toBe(true);
  expect(store.acquireLock("poll", lockHolder(), t0)).toBe(true);
  // A live holder (this very process) keeps it.
  expect(store.acquireLock("poll", dead, t0)).toBe(false);
  store.releaseLock("poll");
  // On another host, or in another PID namespace (a container sharing the host name), liveness
  // cannot be checked: only the 30-minute expiry applies.
  for (const elsewhere of [dead.replace(/@[^#]+/, "@another-host"), `${dead.split("#")[0]}#pid:[1]/other-boot`]) {
    expect(store.acquireLock("poll", elsewhere, t0)).toBe(true);
    expect(store.acquireLock("poll", lockHolder(), t0)).toBe(false);
    expect(store.lockHeld("poll", t0)).toBe(true);
    expect(store.lockHeld("poll", new Date(t0.getTime() + 31 * 60_000))).toBe(false);
    store.releaseLock("poll");
  }
  expect(store.lockHeld("poll", t0)).toBe(false);
  store.acquireLock("poll", dead, t0);
  expect(store.lockHeld("poll", t0)).toBe(false); // its process is gone
});

test("taking over a dead holder's lock removes only that holder's row", () => {
  // Two pollers saw the same dead holder; the first took the lock. The second must not
  // delete the first one's fresh lock.
  const t0 = new Date("2026-11-04T10:00:00Z");
  const dead = lockHolder(Bun.spawnSync(["true"]).pid);
  store.acquireLock("poll", lockHolder(), t0);
  store.releaseLock("poll", dead); // what the slower poller would do
  expect(store.lockHeld("poll", t0)).toBe(true);
});

test("waits for a busy database instead of failing at once", () => {
  expect(store.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
});

test("caches from before is_baseline and first_since are upgraded in place", () => {
  const path = join(mkdtempSync(join(tmpdir(), "watcher-store-")), "cache.sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE items (url TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, instance TEXT NOT NULL, kind TEXT NOT NULL,
    repo TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, state_detail TEXT, ci_state TEXT,
    has_conflicts INTEGER NOT NULL DEFAULT 0, authored_by_me INTEGER NOT NULL DEFAULT 0,
    labels_json TEXT NOT NULL DEFAULT '[]', last_signal_at TEXT, last_signal_summary TEXT,
    seen_at TEXT, baseline_at TEXT NOT NULL, fetched_at TEXT NOT NULL, snapshot_json TEXT);
    CREATE TABLE events (item_url TEXT NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
    actor_role TEXT NOT NULL, at TEXT NOT NULL, detected_at TEXT NOT NULL, excerpt TEXT, details_json TEXT,
    is_signal INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (item_url, event_key));
    CREATE TABLE retry (instance TEXT NOT NULL, item_url TEXT NOT NULL, kind TEXT NOT NULL, attempts INTEGER NOT NULL,
    last_error TEXT NOT NULL, PRIMARY KEY (instance, item_url));
    INSERT INTO items (url, id, instance, kind, repo, title, state, baseline_at, fetched_at)
      VALUES ('${url}', '${itemId(url)}', 'github', 'pr', 'foo/bar', 'Fix build', 'open', '${item.baselineAt}', '${item.baselineAt}');
    INSERT INTO events VALUES ('${url}', 'c:old', 'comment', 'maint', 'maintainer', '2026-10-01T00:00:00.000Z',
      '${item.baselineAt}', 'Old history', NULL, 1, 'signal:maintainer-comment');
    INSERT INTO events VALUES ('${url}', 'c:late', 'comment', 'rando', 'contributor', '2026-11-02T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z', '+1', NULL, 0, 'noise:pattern:^\\+1$');
    INSERT INTO retry VALUES ('github', '${url}', 'pr', 1, 'boom');`);
  old.close();
  const upgraded = new Store(path);
  // History stored at the item's baseline becomes baseline; later events do not.
  expect(upgraded.eventsFor(url, true).map((e) => [e.key, e.isBaseline])).toEqual([["c:late", false], ["c:old", true]]);
  refilter(upgraded, { instances: [], filter: DEFAULT_FILTER, commitBranch: "config" }, new Map());
  expect(upgraded.getItem(url)?.lastSignalAt).toBeNull();
  expect(upgraded.listRetries("github")).toEqual([
    { instance: "github", itemUrl: url, kind: "pr", attempts: 1, lastError: "boom", firstSince: null },
  ]);
  expect(upgraded.insertEvent(event)).toBe(true);
  expect(upgraded.eventsFor(url).map((e) => e.key)).toEqual(["c:1", "c:old"]);
  upgraded.close();
  // Opening it again must not re-run the backfill on new events.
  const reopened = new Store(path);
  expect(reopened.eventsFor(url).find((e) => e.key === "c:1")?.isBaseline).toBe(false);
  reopened.close();
});

test("rollback discards writes", () => {
  store.begin();
  store.upsertItem(item);
  store.rollback();
  expect(store.getItem(url)).toBeNull();
});

test("transaction commits on return and rolls back on a throw", () => {
  store.transaction(() => store.upsertItem(item));
  expect(store.getItem(url)).not.toBeNull();
  expect(() => store.transaction(() => { store.markSeen(url, "2026-11-03T00:00:00.000Z"); throw new Error("boom"); })).toThrow("boom");
  expect(store.getItem(url)?.seenAt).toBeNull();
  expect(store.transaction(() => 42)).toBe(42);
});

test("transaction takes the write lock up front, so a read then write cannot fail on a concurrent commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-tx-"));
  const a = new Store(join(dir, "cache.sqlite"));
  const b = new Store(join(dir, "cache.sqlite"));
  b.db.exec("PRAGMA busy_timeout = 0;");
  try {
    a.upsertItem(item);
    let otherBlocked = false;
    a.transaction(() => {
      a.getItem(url); // a read first: a deferred transaction would now fail on the write below once b commits
      try {
        b.markSeen(url, "2026-11-03T00:00:00.000Z");
      } catch {
        otherBlocked = true;
      }
      a.markSeen(url, "2026-11-04T00:00:00.000Z");
    });
    expect(otherBlocked).toBe(true);
    expect(a.getItem(url)?.seenAt).toBe("2026-11-04T00:00:00.000Z");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
