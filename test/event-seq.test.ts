// Every event gets a sequence number when it is stored: a counter of detection, never a forge time.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { Store, type EventRow } from "../src/core/store.ts";

afterEach(cleanupTmp);

const U = "https://github.com/foo/bar/pull/42";
const ev = (key: string, over: Partial<EventRow> = {}): EventRow => ({
  itemUrl: U, key, kind: "comment", actor: "maint", actorRole: "maintainer", at: "2026-11-02T00:00:00.000Z",
  detectedAt: "2026-11-02T00:05:00.000Z", excerpt: null, details: null, isSignal: true, reason: "signal:comment", isBaseline: false,
  ...over,
});

test("the numbers count stored events from 1 in storing order, whatever the forge time says", () => {
  const s = new Store(":memory:");
  expect(s.maxSeq()).toBe(0);
  s.insertEvent(ev("a", { at: "2026-11-09T00:00:00.000Z" }));
  s.insertEvent(ev("b", { at: "2026-01-01T00:00:00.000Z" })); // a late-paged old event still comes after
  expect(s.maxSeq()).toBe(2);
  expect(s.signalEventsBetween(0, 2).map((e) => e.key)).toEqual(["b", "a"]); // newest number first
  expect(s.signalEventsBetween(1, 2).map((e) => e.key)).toEqual(["b"]);
  expect(s.signalEventsBetween(0, 1).map((e) => e.key)).toEqual(["a"]);
});

test("a duplicate takes no number", () => {
  const s = new Store(":memory:");
  expect(s.insertEvent(ev("a"))).toBe(true);
  expect(s.insertEvent(ev("a"))).toBe(false);
  expect(s.insertEvent(ev("b"))).toBe(true);
  expect(s.maxSeq()).toBe(2);
});

test("baseline and noise events are numbered but never news", () => {
  const s = new Store(":memory:");
  s.insertEvent(ev("base", { isBaseline: true }));
  s.insertEvent(ev("noise", { isSignal: false, reason: "noise:+1" }));
  s.insertEvent(ev("news"));
  expect(s.maxSeq()).toBe(3);
  expect(s.signalEventsBetween(0, 3).map((e) => e.key)).toEqual(["news"]);
});

test("a cache from before the numbers gets them in detection order, and the rest continue after", () => {
  const dir = tmpDir("seq");
  const path = join(dir, "cache.sqlite");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE events (item_url TEXT NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
    actor_role TEXT NOT NULL, at TEXT NOT NULL, detected_at TEXT NOT NULL, excerpt TEXT, details_json TEXT,
    is_signal INTEGER NOT NULL, reason TEXT NOT NULL, is_baseline INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_url, event_key))`);
  const put = old.query(`INSERT INTO events (item_url, event_key, kind, actor, actor_role, at, detected_at, is_signal, reason)
    VALUES ($u, $k, 'comment', 'm', 'maintainer', '2026-11-01T00:00:00.000Z', $d, 1, 'signal:comment')`);
  put.run({ u: U, k: "late", d: "2026-11-03T00:00:00.000Z" });
  put.run({ u: U, k: "early", d: "2026-11-02T00:00:00.000Z" });
  old.close();
  const s = new Store(path);
  expect(s.maxSeq()).toBe(2);
  expect(s.signalEventsBetween(0, 2).map((e) => e.key)).toEqual(["late", "early"]); // early is 1, late is 2
  s.insertEvent(ev("new"));
  expect(s.maxSeq()).toBe(3);
  expect(new Store(path).maxSeq()).toBe(3); // opening again changes nothing
  s.close();
});
