import { beforeEach, expect, test } from "bun:test";
import { getItem, instanceStatus, itemEvents, itemLabel, listItems, markSeen, parseIntentChange } from "../src/core/api.ts";
import { DEFAULT_FILTER, type Config } from "../src/core/config.ts";
import { parseIntent } from "../src/core/intent.ts";
import { itemId, Store, type ItemRow } from "../src/core/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

function row(url: string, extra: Partial<ItemRow>): ItemRow {
  return {
    url, id: itemId(url), instance: "github", kind: "issue", repo: "foo/bar", title: url.slice(-1),
    state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [],
    lastSignalAt: null, lastSignalSummary: null, seenAt: null, baselineAt: "2026-11-01T00:00:00.000Z",
    fetchedAt: "2026-11-01T00:00:00.000Z", snapshotJson: null, ...extra,
  };
}

const A = "https://github.com/f/b/issues/A";
const B = "https://github.com/f/b/issues/B";
const C = "https://github.com/f/b/pull/C";
const M = "https://github.com/f/b/issues/M";

test("sorting, priority, unread, muted, manual", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  store.upsertItem(row(B, { lastSignalAt: "2026-11-04T00:00:00.000Z", seenAt: "2026-11-04T01:00:00.000Z" }));
  store.upsertItem(row(C, { kind: "pr", authoredByMe: true, lastSignalAt: "2026-11-01T00:00:00.000Z" }));
  store.upsertItem(row(M, { lastSignalAt: "2026-11-05T00:00:00.000Z" }));
  const intent = parseIntent(`items:
  - url: ${M}
    muted: true
  - url: https://lists.example.org/p1
    manual: true
    title: "[PATCH] x"
`);
  const all = listItems(store, intent);
  expect(all.map((v) => v.title)).toEqual(["C", "B", "A", "[PATCH] x"]);
  expect(all[0]).toMatchObject({ priority: "important", unread: true });
  expect(all[1]?.unread).toBe(false);
  expect(all[3]).toMatchObject({ kind: "manual", repo: "lists.example.org", instance: null });
  expect(listItems(store, intent, { unreadOnly: true }).map((v) => v.title)).toEqual(["C", "A"]);
  expect(listItems(store, intent, { includeMuted: true })).toHaveLength(5);
});

test("filters, lookup by id, separate state fields", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z", state: "closed", stateDetail: "completed", labels: ["bug"] }));
  store.upsertItem(row(C, { kind: "pr", authoredByMe: true, instance: "gitlab" }));
  const intent = parseIntent(`items:\n  - url: https://lists.example.org/p1\n    manual: true\n    priority: important`);
  expect(listItems(store, intent, { importantOnly: true }).map((v) => v.url)).toEqual([C, "https://lists.example.org/p1"]);
  expect(listItems(store, intent, { instance: "gitlab" }).map((v) => v.url)).toEqual([C]);
  const a = getItem(store, intent, itemId(A));
  expect(a).toMatchObject({ url: A, state: "closed (completed)", itemState: "closed", stateDetail: "completed", labels: ["bug"] });
  expect(getItem(store, intent, itemId("https://lists.example.org/p1"))).toMatchObject({ kind: "manual", itemState: "manual" });
  expect(getItem(store, intent, "nope")).toBeNull();
  // What the priority would be without an explicit setting, so the UI can go back to it.
  expect(getItem(store, intent, itemId(C))?.defaultPriority).toBe("important");
  expect(getItem(store, intent, itemId(A))?.defaultPriority).toBe("normal");
});

test("updatedAt: the item's own, else its latest event of any kind; quiet items sort by it", () => {
  const ev = (url: string, key: string, at: string, isSignal: boolean) => ({
    itemUrl: url, key, kind: "comment" as const, actor: "bob", actorRole: "contributor" as const, at, detectedAt: at,
    excerpt: null, details: null, isSignal, reason: isSignal ? "signal:comment" : "noise:+1", isBaseline: !isSignal,
  });
  store.upsertItem(row(A, { lastSignalAt: "2026-11-02T00:00:00.000Z" }));
  store.upsertItem(row(B, {})); // no news, no dates of its own (fetched before they were stored), but recent activity
  store.upsertItem(row(C, {})); // never any event
  store.upsertItem(row(M, { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" }));
  store.insertEvent(ev(A, "c:1", "2026-11-01T23:00:00.000Z", true));
  store.insertEvent(ev(B, "c:1", "2026-10-01T00:00:00.000Z", true));
  store.insertEvent(ev(B, "c:2", "2026-11-03T00:00:00.000Z", false));
  store.insertEvent(ev(M, "c:1", "2026-11-05T00:00:00.000Z", false)); // its own updatedAt wins
  const views = listItems(store, new Map());
  expect(views.map((v) => [v.title, v.updatedAt, v.createdAt])).toEqual([
    ["M", "2026-11-04T00:00:00.000Z", "2026-10-01T00:00:00.000Z"], ["B", "2026-11-03T00:00:00.000Z", null],
    ["A", "2026-11-01T23:00:00.000Z", null], ["C", null, null],
  ]);
});

test("itemEvents: signal only, or everything with reasons, newest first", () => {
  store.upsertItem(row(A, {}));
  const ev = (key: string, at: string, isSignal: boolean, reason: string) => ({
    itemUrl: A, key, kind: "comment" as const, actor: "bob", actorRole: "contributor" as const, at, detectedAt: at,
    excerpt: `text ${key}`, details: null, isSignal, reason, isBaseline: false,
  });
  store.insertEvent(ev("c:1", "2026-11-01T00:00:00.000Z", true, "signal:comment"));
  store.insertEvent(ev("c:2", "2026-11-02T00:00:00.000Z", false, "noise:+1"));
  expect(itemEvents(store, A, false).map((e) => e.key)).toEqual(["c:1"]);
  const all = itemEvents(store, A, true);
  expect(all.map((e) => e.key)).toEqual(["c:2", "c:1"]);
  expect(all[0]).toMatchObject({ summary: "comment by @bob: text c:2", isSignal: false, reason: "noise:+1", excerpt: "text c:2" });
});

test("approximate times: shown and ordered by the approximation, the reported time kept alongside", () => {
  store.upsertItem(row(A, {}));
  const ev = (key: string, at: string, approxAt: string | null) => ({
    itemUrl: A, key, kind: "comment" as const, actor: "bob", actorRole: "contributor" as const, at, detectedAt: at,
    excerpt: null, details: null, isSignal: true, reason: "signal:comment", isBaseline: false, approxAt,
  });
  store.insertEvent(ev("c:1", "2026-11-02T00:00:00.000Z", null));
  store.insertEvent(ev("c:2", "2026-10-01T00:00:00.000Z", "2026-11-03T00:00:00.000Z")); // arrived late
  expect(itemEvents(store, A, false).map((e) => [e.key, e.at, e.reportedAt])).toEqual([
    ["c:2", "2026-11-03T00:00:00.000Z", "2026-10-01T00:00:00.000Z"], ["c:1", "2026-11-02T00:00:00.000Z", null],
  ]);
  expect(listItems(store, new Map())[0]).toMatchObject({ updatedAt: "2026-11-03T00:00:00.000Z", updatedApprox: true });
  store.insertEvent(ev("c:3", "2026-11-04T00:00:00.000Z", null));
  expect(listItems(store, new Map())[0]).toMatchObject({ updatedAt: "2026-11-04T00:00:00.000Z", updatedApprox: false });
});

test("instanceStatus: last run and last success per configured instance", () => {
  const config: Config = {
    instances: [
      { id: "github", type: "github", url: "https://api.github.com", user: "u", emails: [] },
      { id: "kde", type: "gitlab", url: "https://invent.kde.org/api/v4", user: "u", emails: [], disabledReason: "missing KDE_TOKEN in .env" },
    ],
    filter: DEFAULT_FILTER,
    commitBranch: "config", mcpReadOnly: true,
  };
  store.recordRun({ instance: "github", startedAt: "2026-11-04T10:00:00.000Z", finishedAt: "2026-11-04T10:01:00.000Z", cursor: "c1", error: null });
  store.recordRun({ instance: "github", startedAt: "2026-11-04T11:00:00.000Z", finishedAt: "2026-11-04T11:01:00.000Z", cursor: "c1", error: "boom" });
  expect(instanceStatus(store, config)).toEqual([
    { id: "github", type: "github", disabledReason: null, lastRunAt: "2026-11-04T11:01:00.000Z", lastSuccessAt: "2026-11-04T10:01:00.000Z", error: "boom" },
    { id: "kde", type: "gitlab", disabledReason: "missing KDE_TOKEN in .env", lastRunAt: null, lastSuccessAt: null, error: null },
  ]);
});

test("itemLabel: short names for commit messages", () => {
  expect(itemLabel("https://github.com/foo/bar/pull/42")).toBe("foo/bar#42");
  expect(itemLabel("https://invent.kde.org/a/b/c/-/merge_requests/7")).toBe("a/b/c#7");
  expect(itemLabel("https://codeberg.org/o/r/issues/3", "o/r")).toBe("o/r#3");
  expect(itemLabel(`https://app.radicle.xyz/nodes/seed.radicle.garden/rad:z3gq/patches/${"ab".repeat(20)}`, "heartwood"))
    .toBe("heartwood#abababab");
  expect(itemLabel("https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=300512")).toBe("bugs.freebsd.org bug 300512");
  expect(itemLabel("https://lists.example.org/msg1.html")).toBe("https://lists.example.org/msg1.html");
});

test("markSeen by url or all", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  store.upsertItem(row(B, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  const now = new Date("2026-11-04T00:00:00.000Z");
  expect(markSeen(store, [A, "https://nope"], now)).toBe(1);
  expect(listItems(store, new Map(), { unreadOnly: true }).map((v) => v.url)).toEqual([B]);
  expect(markSeen(store, [], now)).toBe(2);
  expect(listItems(store, new Map(), { unreadOnly: true })).toEqual([]);
});

test("parseIntentChange: priority, muted and note, checked; says what is wrong", () => {
  expect(parseIntentChange({ priority: "important", muted: false, note: null })).toEqual({ priority: "important", muted: false, note: null });
  expect(parseIntentChange({ priority: null })).toEqual({ priority: null });
  expect(() => parseIntentChange({ priority: "urgent" })).toThrow("priority must be 'important', 'normal' or null");
  expect(() => parseIntentChange({ muted: "yes" })).toThrow("muted must be true or false");
  expect(() => parseIntentChange({ note: 3 })).toThrow("note must be text or null");
  expect(() => parseIntentChange({ title: "x" })).toThrow("unknown field 'title'");
  expect(() => parseIntentChange({})).toThrow("nothing to change");
});

test("a register other than default lists its own entries; default lists everything the cache has", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  store.upsertItem(row(B, { lastSignalAt: "2026-11-04T00:00:00.000Z" }));
  const inFoo = parseIntent(`items:\n  - url: ${A}\n    priority: important\n  - url: https://lists.example.org/p1\n    manual: true\n    title: "[PATCH] x"\n`);
  expect(listItems(store, inFoo, { register: "foo" }).map((v) => v.url)).toEqual([A, "https://lists.example.org/p1"]);
  expect(listItems(store, inFoo, { register: "foo" })[0]).toMatchObject({ priority: "important" });
  // `default` (or no register named) is the whole cache, as before registers.
  expect(listItems(store, inFoo, { register: "default" }).map((v) => v.url)).toEqual([A, B, "https://lists.example.org/p1"]);
  expect(listItems(store, inFoo).map((v) => v.url)).toEqual([A, B, "https://lists.example.org/p1"]);
});

test("an entry's mute counts in its own register only", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  const mutedInFoo = parseIntent(`items:\n  - url: ${A}\n    muted: true\n`);
  const plain = parseIntent("items: []");
  expect(listItems(store, mutedInFoo, { register: "foo" })).toEqual([]);
  expect(listItems(store, mutedInFoo, { register: "foo", includeMuted: true })).toHaveLength(1);
  expect(listItems(store, plain, { register: "default" })).toHaveLength(1);
});

test("getItem finds an item in a register only if it is an entry of it", () => {
  store.upsertItem(row(A, {}));
  store.upsertItem(row(B, {}));
  const inFoo = parseIntent(`items:\n  - url: ${A}\n`);
  expect(getItem(store, inFoo, itemId(A), "foo")?.url).toBe(A);
  expect(getItem(store, inFoo, itemId(B), "foo")).toBeNull();
  expect(getItem(store, inFoo, itemId(B))?.url).toBe(B);
});
