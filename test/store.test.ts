import { beforeEach, expect, test } from "bun:test";
import { itemId, Store, type EventRow, type ItemRow } from "../src/core/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

const url = "https://github.com/foo/bar/pull/42";
const item: ItemRow = {
  url, id: itemId(url), instance: "github", kind: "pr", repo: "foo/bar", title: "Fix build",
  state: "open", stateDetail: null, ciState: "success", hasConflicts: false, authoredByMe: true,
  labels: ["bug"], lastSignalAt: null, lastSignalSummary: null, seenAt: null,
  baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-01T00:00:00.000Z", snapshotJson: null,
};
const event: EventRow = {
  itemUrl: url, key: "c:1", kind: "comment", actor: "maint", actorRole: "maintainer",
  at: "2026-11-02T00:00:00.000Z", detectedAt: "2026-11-02T00:05:00.000Z", excerpt: "LGTM",
  details: { x: 1 }, isSignal: true, reason: "signal:maintainer-comment", isBaseline: false,
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

test("waits for a busy database instead of failing at once", () => {
  expect(store.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
});

test("rollback discards writes", () => {
  store.begin();
  store.upsertItem(item);
  store.rollback();
  expect(store.getItem(url)).toBeNull();
});
