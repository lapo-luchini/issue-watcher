// The page's view logic that needs no browser: which register and view are shown and how a subscription reads.
import { expect, test } from "bun:test";
import type { SubscriptionStatus } from "../src/core/following.ts";
import {
  clock, cursorText, orderSubscriptions, pickRegister, scopeText, totalUnseen, unseenText, viewFromHash, withRegister,
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
  expect(cursorText(sub({ cursor: 2, latest: 4 }))).toBe("Read up to update 2 of 4");
  expect(cursorText(sub({ cursor: 1234, latest: 1234 }))).toBe("Read up to update 1,234 of 1,234");
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

test("totalUnseen adds the updates of every subscription", () => {
  expect(totalUnseen([])).toBe(0);
  expect(totalUnseen([sub({ unseen: 2 }), sub({ unseen: 3 }), sub()])).toBe(5);
});

test("clock is a 24-hour time", () => {
  expect(clock(new Date(2026, 10, 4, 14, 5))).toBe("14:05");
  expect(clock(new Date(2026, 10, 4, 0, 9))).toBe("00:09");
});
