// The page's view logic that needs no browser: which register and view are shown and how a subscription reads.
import { expect, test } from "bun:test";
import type { SubscriptionStatus } from "../src/core/following.ts";
import {
  clock, cursorText, listProblem, orderSubscriptions, pickRegister, scopeText, totalUnseen, unseenText, viewFromHash, whileCurrent, withRegister,
} from "../web/view.ts";

const sub = (over: Partial<SubscriptionStatus> = {}): SubscriptionStatus => ({
  name: "proj", register: "default", scope: "all", exclude: [], cursor: 2, latest: 4, unseen: 0, items: [], error: null, ...over,
});

test("withRegister adds ?register= for a register other than default, and keeps the query it has", () => {
  expect(withRegister("/api/items", "default")).toBe("/api/items");
  expect(withRegister("/api/items", "houston")).toBe("/api/items?register=houston");
  expect(withRegister("/api/items?unread=1", "houston")).toBe("/api/items?unread=1&register=houston");
  expect(withRegister("/api/items?unread=1", "default")).toBe("/api/items?unread=1");
});

test("pickRegister keeps a remembered register only while it still exists", () => {
  expect(pickRegister("houston", ["default", "houston"])).toBe("houston");
  expect(pickRegister("gone", ["default", "houston"])).toBe("default");
  expect(pickRegister(null, ["default", "houston"])).toBe("default");
  expect(pickRegister("houston", [])).toBe("houston"); // the list is not known yet: ask for what was chosen
});

test("viewFromHash: #subscriptions is the subscription view, anything else the items", () => {
  expect(viewFromHash("#subscriptions")).toBe("subscriptions");
  expect(viewFromHash("")).toBe("items");
  expect(viewFromHash("#items")).toBe("items");
  expect(viewFromHash("#whatever")).toBe("items");
});

test("scopeText says what a subscription follows", () => {
  expect(scopeText(sub())).toBe("Every item of the register");
  expect(scopeText(sub({ exclude: ["a"] }))).toBe("Every item of the register except 1");
  expect(scopeText(sub({ exclude: ["a", "b"] }))).toBe("Every item of the register except 2");
  expect(scopeText(sub({ scope: [] }))).toBe("No item followed yet");
  expect(scopeText(sub({ scope: ["a"] }))).toBe("1 item");
  expect(scopeText(sub({ scope: ["a", "b", "c"] }))).toBe("3 items");
});

test("cursorText gives the number read up to against the newest, or says there is no cursor yet", () => {
  expect(cursorText(sub({ cursor: 2, latest: 4 }))).toBe("2 updates behind");
  expect(cursorText(sub({ cursor: 3, latest: 4 }))).toBe("1 update behind");
  expect(cursorText(sub({ cursor: 1234, latest: 1234 }))).toBe("Not behind");
  expect(cursorText(sub({ cursor: null }))).toBe("No cursor yet: it starts at the first read");
});

test("unseenText: a state in words, never only a colour", () => {
  expect(unseenText(sub())).toBe("Up to date");
  expect(unseenText(sub({ unseen: 1 }))).toBe("1 unseen update");
  expect(unseenText(sub({ unseen: 1500 }))).toBe("1,500 unseen updates");
  expect(unseenText(sub({ error: "no such register: x" }))).toBe("Cannot tell: no such register: x");
});

test("orderSubscriptions puts the ones with news first, keeping the file's order otherwise", () => {
  const list = [sub({ name: "a" }), sub({ name: "b", unseen: 1 }), sub({ name: "c" }), sub({ name: "d", unseen: 5 })];
  expect(orderSubscriptions(list).map((s) => s.name)).toEqual(["d", "b", "a", "c"]);
  expect(list.map((s) => s.name)).toEqual(["a", "b", "c", "d"]); // the input is left alone
});

test("orderSubscriptions puts the ones that cannot be told before all others", () => {
  const list = [sub({ name: "a", unseen: 9 }), sub({ name: "b" }), sub({ name: "x", error: "no such register: x" }), sub({ name: "y", error: "boom" })];
  expect(orderSubscriptions(list).map((s) => s.name)).toEqual(["x", "y", "a", "b"]);
});

test("totalUnseen adds the updates of every subscription", () => {
  expect(totalUnseen([])).toBe(0);
  expect(totalUnseen([sub({ unseen: 2 }), sub({ unseen: 3 }), sub()])).toBe(5);
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const record = () => {
  const log: string[] = [];
  return { log, done: { ok: (t: string) => log.push(`ok ${t}`), fail: (e: Error) => log.push(`fail ${e.message}`), always: () => log.push("always") } };
};

test("whileCurrent hands the answer over while the key is what it was when asked", async () => {
  const { log, done } = record();
  await whileCurrent(() => "default", async () => "a", done);
  expect(log).toEqual(["ok a", "always"]);
});

test("whileCurrent drops an answer that arrives after the key changed (an old register's items never show under the new one)", async () => {
  let key = "default";
  const slow = deferred<string>();
  const { log, done } = record();
  const pending = whileCurrent(() => key, () => slow.promise, done);
  key = "houston";
  slow.resolve("items of default");
  await pending;
  expect(log).toEqual([]);
});

test("whileCurrent drops a late failure too, and reports a current one", async () => {
  let key = "default";
  const late = deferred<string>();
  const a = record();
  const pending = whileCurrent(() => key, () => late.promise, a.done);
  key = "houston";
  late.reject(new Error("no such register"));
  await pending;
  expect(a.log).toEqual([]);
  const b = record();
  await whileCurrent(() => key, () => Promise.reject(new Error("down")), b.done);
  expect(b.log).toEqual(["fail down", "always"]);
});

test("whileCurrent: two asks out of order, only the one for the current key lands", async () => {
  let key = "default";
  const first = deferred<string>();
  const second = deferred<string>();
  const { log, done } = record();
  const p1 = whileCurrent(() => key, () => first.promise, done);
  key = "houston";
  const p2 = whileCurrent(() => key, () => second.promise, done);
  second.resolve("houston items");
  first.resolve("default items");
  await Promise.all([p1, p2]);
  expect(log).toEqual(["ok houston items", "always"]);
});

test("clock is a 24-hour time", () => {
  expect(clock(new Date(2026, 10, 4, 14, 5))).toBe("14:05");
  expect(clock(new Date(2026, 10, 4, 0, 9))).toBe("00:09");
});

test("a list the server answered with an error names what could not be read, and never says the server is down", () => {
  expect(listProblem("default", "boom")).toBe("The watcher could not list the items: boom");
  expect(listProblem("houston", "boom")).toBe("The watcher could not list the register houston: boom");
});
