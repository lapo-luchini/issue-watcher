// The cursor of a subscription (state in the cache, never in git) and the floors of its explicit scope.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { Store, type EventRow } from "../src/core/store.ts";

afterEach(cleanupTmp);

const U = "https://github.com/foo/bar/pull/42";
const ev = (key: string): EventRow => ({
  itemUrl: U, key, kind: "comment", actor: "maint", actorRole: "maintainer", at: "2026-11-02T00:00:00.000Z",
  detectedAt: "2026-11-02T00:05:00.000Z", excerpt: null, details: null, isSignal: true, reason: "signal:comment", isBaseline: false,
});
const fill = (s: Store, n: number) => { for (let i = 1; i <= n; i++) s.insertEvent(ev(`e${i}`)); };

test("a cursor that does not exist yet starts at the newest number: what came before is not its news", () => {
  const s = new Store(":memory:");
  fill(s, 3);
  expect(s.subscriptionCursor("houston")).toBeNull();
  expect(s.startCursor("houston")).toBe(3);
  s.insertEvent(ev("e4"));
  expect(s.startCursor("houston")).toBe(3); // already there: untouched
  expect(s.subscriptionCursor("houston")).toBe(3);
  expect(s.startCursor("other")).toBe(4); // its own, and later
});

test("advanceCursor moves the cursor to the number, forward only", () => {
  const s = new Store(":memory:");
  s.startCursor("houston");
  fill(s, 5);
  expect(s.advanceCursor("houston", 4)).toBe(4);
  expect(s.advanceCursor("houston", 2)).toBe(4); // an old token cannot take it back
  expect(s.advanceCursor("houston", 5)).toBe(5);
  expect(s.subscriptionCursor("houston")).toBe(5);
});

test("advanceCursor refuses a number no event has: it would swallow the news to come", () => {
  const s = new Store(":memory:");
  s.startCursor("houston");
  fill(s, 2);
  expect(s.advanceCursor("houston", 3)).toBeNull();
  expect(s.subscriptionCursor("houston")).toBe(0);
  expect(s.advanceCursor("nobody", 1)).toBeNull(); // and a cursor that does not exist stays absent
  expect(s.subscriptionCursor("nobody")).toBeNull();
});

test("the cursors live in the cache file: a second connection sees them", () => {
  const path = join(tmpDir("cur"), "cache.sqlite");
  const a = new Store(path);
  const b = new Store(path);
  a.startCursor("houston");
  fill(a, 2);
  a.advanceCursor("houston", 2);
  expect(b.subscriptionCursor("houston")).toBe(2);
});

test("a floor is the newest number when the item was followed; following again moves it, dropping removes it", () => {
  const s = new Store(":memory:");
  fill(s, 2);
  s.setFloor("houston", U);
  s.setFloor("houston", "https://x/other");
  expect(s.floors("houston")).toEqual(new Map([[U, 2], ["https://x/other", 2]]));
  s.insertEvent(ev("e3"));
  s.setFloor("houston", U);
  expect(s.floors("houston").get(U)).toBe(3);
  expect(s.floors("other").size).toBe(0);
  s.dropFloor("houston", U);
  expect([...s.floors("houston").keys()]).toEqual(["https://x/other"]);
});
