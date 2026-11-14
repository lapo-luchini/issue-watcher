// What a subscription reads and changes: updates after the cursor, ack, track, subscribe, unsubscribe.
// The expectations are worked out by hand from the events inserted in `open`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { openContext, type Context } from "../src/core/context.ts";
import { acknowledge, defineSubscription, subscriptionUpdates, trackItem, untrackItem } from "../src/core/following.ts";
import { itemId, type EventRow } from "../src/core/store.ts";
import { SubscriptionError } from "../src/core/subscriptions.ts";

const pr = (n: number) => `https://github.com/foo/bar/pull/${n}`;
const [A, B, C, D] = [pr(1), pr(2), pr(3), pr(4)];

let home: string;
let ctx: Context;
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", home, ...args]).stdout.toString();
const file = (name: string) => readFileSync(join(home, name), "utf8");

const row = (url: string) => ({
  url, id: itemId(url), instance: "github", kind: "pr" as const, repo: "foo/bar", title: `PR ${url.split("/").pop()}`, state: "open" as const,
  stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: false, maintainedByMe: false, labels: [],
  lastSignalAt: null, lastSignalSummary: null, seenAt: null, baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
});
const ev = (itemUrl: string, key: string, over: Partial<EventRow> = {}): EventRow => ({
  itemUrl, key, kind: "comment", actor: "maint", actorRole: "maintainer", at: "2026-11-04T09:00:00.000Z",
  detectedAt: "2026-11-04T10:00:00.000Z", excerpt: key, details: null, isSignal: true, reason: "signal:comment", isBaseline: false, ...over,
});
/** Stores events for the items in this order; the first is number 1 (when nothing was stored before). */
const store = (...events: [string, string, Partial<EventRow>?][]) => { for (const [u, k, o] of events) ctx.store.insertEvent(ev(u, k, o)); };
const keys = (r: { items: { events: { summary: string }[] }[] }) => r.items.flatMap((g) => g.events.map((e) => e.summary.replace(/^comment by @maint: /, "")));
const urls = (r: { items: { item: { url: string } }[] }) => r.items.map((g) => g.item.url);

beforeEach(async () => {
  home = tmpDir("follow");
  for (const args of [["init", "-q"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) git(...args);
  mkdirSync(join(home, "data/registers"), { recursive: true });
  writeFileSync(join(home, "data/config.yaml"), "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\nmcp:\n  read_only: false\n");
  // default: A, B and (muted) C; the cache also has D, which no register lists (default shows the whole cache). houston lists A and D, and mutes D.
  writeFileSync(join(home, "data/items.yaml"), `items:\n  - url: ${A}\n  - url: ${B}\n  - url: ${C}\n    muted: true\n`);
  writeFileSync(join(home, "data/registers/houston.yaml"), `items:\n  - url: ${A}\n  - url: ${D}\n    muted: true\n`);
  git("add", "-f", "."), git("commit", "-qm", "init");
  ctx = await openContext(home);
  for (const u of [A, B, C, D]) ctx.store.upsertItem(row(u));
});

afterEach(() => {
  ctx.store.close();
  cleanupTmp();
});

const define = (name: string, register = "default", all = true) => defineSubscription(ctx, name, { register, all });

test("scope all on default: the news of every item the cache has, except what the register mutes; the cursor does not move", async () => {
  await define("p");
  expect(await subscriptionUpdates(ctx, "p")).toEqual({ subscription: "p", token: "p.0", items: [] });
  store([A, "a1"], [B, "b1"], [C, "c1"], [D, "d1"], [A, "a2"]); // numbers 1 to 5
  const r = await subscriptionUpdates(ctx, "p");
  expect(urls(r)).toEqual([A, D, B]); // the item with the newest number first (A: 5, D: 4, B: 2); C is muted
  expect(keys(r)).toEqual(["a2", "a1", "d1", "b1"]);
  expect(r.token).toBe("p.5");
  expect(ctx.store.subscriptionCursor("p")).toBe(0);
  expect(await subscriptionUpdates(ctx, "p")).toEqual(r); // reading again changes nothing
});

test("ack moves the cursor to the token; the next read has only what came after", async () => {
  await define("p");
  store([A, "a1"], [B, "b1"]);
  const r = await subscriptionUpdates(ctx, "p");
  expect(await acknowledge(ctx, "p", r.token)).toEqual({ subscription: "p", cursor: 2 });
  expect(await subscriptionUpdates(ctx, "p")).toEqual({ subscription: "p", token: "p.2", items: [] });
  store([B, "b2"]);
  expect(keys(await subscriptionUpdates(ctx, "p"))).toEqual(["b2"]);
});

test("an event stored between the read and the ack is not lost", async () => {
  await define("p");
  store([A, "a1"]);
  const r = await subscriptionUpdates(ctx, "p");
  store([B, "b1"]); // the poll stores it while the reader is thinking
  await acknowledge(ctx, "p", r.token);
  expect(keys(await subscriptionUpdates(ctx, "p"))).toEqual(["b1"]);
});

test("noise, baseline and muted events are numbered, so the ack passes them; they are never news", async () => {
  await define("p");
  store([A, "n1", { isSignal: false, reason: "noise:+1" }], [A, "base", { isBaseline: true }], [C, "muted"]);
  const r = await subscriptionUpdates(ctx, "p");
  expect(r.items).toEqual([]);
  expect(r.token).toBe("p.3");
});

test("a late event with an old forge time is news by the number it was stored under", async () => {
  await define("p");
  store([A, "now", { at: "2026-11-09T00:00:00.000Z" }]);
  await acknowledge(ctx, "p", (await subscriptionUpdates(ctx, "p")).token);
  store([A, "late", { at: "2026-01-01T00:00:00.000Z" }]);
  expect(keys(await subscriptionUpdates(ctx, "p"))).toEqual(["late"]);
});

test("exclusions are subtracted from all; an explicit scope is just its URLs", async () => {
  await define("p");
  await trackItem(ctx, "p", A); // scope all: following A lifts nothing here
  await untrackItem(ctx, "p", B); // excludes B
  store([A, "a1"], [B, "b1"], [D, "d1"]);
  expect(urls(await subscriptionUpdates(ctx, "p"))).toEqual([D, A]);
  await define("q", "default", false);
  await trackItem(ctx, "q", B);
  store([A, "a2"], [B, "b2"]);
  expect(urls(await subscriptionUpdates(ctx, "q"))).toEqual([B]);
});

test("a register of its own: only its entries, and its mutes; another subscription of default does not see them", async () => {
  await define("h", "houston");
  store([A, "a1"], [B, "b1"], [D, "d1"]); // B is not in houston; D is muted there
  const r = await subscriptionUpdates(ctx, "h");
  expect(urls(r)).toEqual([A]);
  await define("p");
  expect(urls(await subscriptionUpdates(ctx, "p"))).toEqual([]); // p started after: nothing yet
  store([D, "d2"]);
  expect(urls(await subscriptionUpdates(ctx, "p"))).toEqual([D]); // not muted in default
});

test("track: the item's past events are not news, the ones after are; the cursor does not skip other news", async () => {
  await define("p", "default", false);
  store([A, "a-old"]); // 1, before p follows A
  const r = await trackItem(ctx, "p", `${A}/files`);
  expect(r).toMatchObject({ subscription: "p", url: A, added: false, warning: null });
  expect(r.item).toMatchObject({ url: A, id: itemId(A) });
  expect(await subscriptionUpdates(ctx, "p")).toMatchObject({ items: [] });
  store([A, "a-new"]); // 2
  expect(keys(await subscriptionUpdates(ctx, "p"))).toEqual(["a-new"]);
});

test("track on an item a cursor is already behind: only events after the track count for that item, the rest of the scope keeps its own", async () => {
  await define("p", "default", false);
  await trackItem(ctx, "p", B);
  store([B, "b-before-A"], [A, "a-before"]); // 1, 2
  await trackItem(ctx, "p", A); // floor of A is 2
  store([A, "a-after"]); // 3
  const r = await subscriptionUpdates(ctx, "p");
  expect(keys(r)).toEqual(["a-after", "b-before-A"]);
});

test("track adds the item to the register when it is not there, as one commit", async () => {
  await define("p");
  const E = pr(5);
  const r = await trackItem(ctx, "p", E);
  expect(r).toMatchObject({ url: E, added: true, item: null }); // not fetched yet
  expect(file("data/items.yaml")).toContain(E);
  expect(git("log", "--format=%s", "config").split("\n").slice(0, 2)).toEqual(["watcher: add foo/bar#5", "watcher: subscribe p"]); // scope all: following changes nothing
});

test("track on a register of its own adds the item to that register, and to nothing else", async () => {
  await define("h", "houston");
  await trackItem(ctx, "h", B);
  expect(file("data/registers/houston.yaml")).toContain(B);
  expect(file("data/items.yaml")).toBe(`items:\n  - url: ${A}\n  - url: ${B}\n  - url: ${C}\n    muted: true\n`);
});

test("track creates the subscription when there is none, on default, with an explicit scope", async () => {
  await trackItem(ctx, "fresh", A);
  expect(file("data/subscriptions.yaml")).toBe(`subscriptions:\n  - name: fresh\n    scope:\n      - ${A}\n`);
  expect((await ctx.subscriptions()).get("fresh")).toEqual({ name: "fresh", register: "default", scope: [A], exclude: [] });
  expect(git("log", "-1", "--format=%s", "config")).toBe("watcher: follow foo/bar#1 in fresh\n");
  expect(ctx.store.subscriptionCursor("fresh")).toBe(0);
});

test("track refuses what is not a web URL, and changes nothing", async () => {
  await expect(trackItem(ctx, "p", "not a url")).rejects.toThrow("not a web URL");
  expect(Bun.file(join(home, "data/subscriptions.yaml")).size).toBe(0);
});

test("unsubscribe takes the item out of the scope and forgets its floor; the register keeps it", async () => {
  await define("p", "default", false);
  await trackItem(ctx, "p", A);
  await untrackItem(ctx, "p", A);
  expect((await ctx.subscriptions()).get("p")!.scope).toEqual([]);
  expect(ctx.store.floors("p").size).toBe(0);
  expect(file("data/items.yaml")).toContain(A);
  await expect(untrackItem(ctx, "nope", A)).rejects.toThrow("no such subscription: nope");
});

test("subscribe on a register that does not exist is refused; on an existing subscription it changes the register", async () => {
  await expect(define("p", "nowhere")).rejects.toThrow("no such register: nowhere");
  await define("p");
  await define("p", "houston", false);
  expect((await ctx.subscriptions()).get("p")).toEqual({ name: "p", register: "houston", scope: [], exclude: [] });
});

test("a token is refused when it is another subscription's, malformed, or beyond the newest number", async () => {
  await define("p");
  await define("q");
  store([A, "a1"]);
  const bad = async (name: string, token: string, message: string) => {
    const err = await acknowledge(ctx, name, token).catch((e) => e);
    expect(err).toBeInstanceOf(SubscriptionError);
    expect(err.message).toContain(message);
  };
  await bad("q", "p.1", "not from q's updates");
  await bad("p", "1", "not from p's updates");
  await bad("p", "p.-1", "not from p's updates");
  await bad("p", "p.2", "unknown token");
  expect(ctx.store.subscriptionCursor("p")).toBe(0);
  await bad("ghost", "ghost.0", "no such subscription: ghost");
});

test("an old token cannot take the cursor back", async () => {
  await define("p");
  store([A, "a1"]);
  const first = await subscriptionUpdates(ctx, "p");
  store([A, "a2"]);
  const second = await subscriptionUpdates(ctx, "p");
  await acknowledge(ctx, "p", second.token);
  expect(await acknowledge(ctx, "p", first.token)).toEqual({ subscription: "p", cursor: 2 });
});

test("a subscription written by hand, with no cursor yet, starts at the newest number: it is given what comes after", async () => {
  store([A, "a1"]);
  writeFileSync(join(home, "data/subscriptions.yaml"), `subscriptions:\n  - name: hand\n    scope: all\n`);
  expect(await subscriptionUpdates(ctx, "hand")).toEqual({ subscription: "hand", token: "hand.1", items: [] });
  store([A, "a2"]);
  expect(keys(await subscriptionUpdates(ctx, "hand"))).toEqual(["a2"]);
});

test("a subscription whose register has no file is an error the caller can read, not a crash", async () => {
  writeFileSync(join(home, "data/subscriptions.yaml"), `subscriptions:\n  - name: lost\n    register: gone\n    scope: all\n`);
  await expect(subscriptionUpdates(ctx, "lost")).rejects.toThrow("no such register: gone");
});
