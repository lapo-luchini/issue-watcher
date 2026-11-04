import { beforeEach, expect, test } from "bun:test";
import { listItems, markSeen } from "../src/core/api.ts";
import { parseIntent } from "../src/core/intent.ts";
import { itemId, Store, type ItemRow } from "../src/core/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

function row(url: string, extra: Partial<ItemRow>): ItemRow {
  return {
    url, id: itemId(url), instance: "github", kind: "issue", repo: "foo/bar", title: url.slice(-1),
    state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, labels: [],
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

test("markSeen by url or all", () => {
  store.upsertItem(row(A, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  store.upsertItem(row(B, { lastSignalAt: "2026-11-03T00:00:00.000Z" }));
  const now = new Date("2026-11-04T00:00:00.000Z");
  expect(markSeen(store, [A, "https://nope"], now)).toBe(1);
  expect(listItems(store, new Map(), { unreadOnly: true }).map((v) => v.url)).toEqual([B]);
  expect(markSeen(store, [], now)).toBe(2);
  expect(listItems(store, new Map(), { unreadOnly: true })).toEqual([]);
});
