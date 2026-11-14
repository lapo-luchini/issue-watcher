// The HTTP API against a temporary watcher home (a git repo) and a fake forge.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import type { Adapter, ItemRef, Snapshot } from "../src/core/model.ts";
import { itemId, lockHolder, Store } from "../src/core/store.ts";
import { startServer } from "../src/server.ts";

const PR = "https://github.com/foo/bar/pull/42";
const ISSUE = "https://github.com/foo/bar/issues/7";
let home: string;
let srv: Awaited<ReturnType<typeof startServer>>;
let fetched: string[];
/** Discovery waits for this, so a test can hold a poll open. */
let gate: Promise<void> = Promise.resolve();

/** Discovers the issue; its snapshot carries one maintainer comment. */
const adapter: Adapter = {
  refFromUrl: (url) => (url.startsWith("https://github.com/") ? { url: url.replace(/\/files$/, ""), instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" } : null),
  discover: async () => {
    await gate;
    return [{ url: ISSUE, instance: "github", kind: "issue" }];
  },
  fetch: async (ref: ItemRef): Promise<Snapshot> => {
    fetched.push(ref.url);
    return {
      ref, repo: "foo/bar", title: "Crash on start", state: "open", authoredByMe: false, labels: [],
      events: [{ key: "c:1", kind: "comment", actor: "maint", actorRole: "maintainer", at: new Date("2026-11-04T09:00:00Z"), body: "Can you test the fix?" }],
    };
  },
};

beforeEach(async () => {
  home = tmpDir("srv");
  for (const args of [["init", "-q"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) {
    Bun.spawnSync(["git", "-C", home, ...args]);
  }
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "var"));
  writeFileSync(join(home, "data/config.yaml"), "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\n");
  writeFileSync(join(home, "data/items.yaml"), "items:\n  - url: https://lists.example.org/p1\n    manual: true\n    title: '[PATCH] x'\n");
  const store = new Store(join(home, "var/cache.sqlite"));
  store.upsertItem({
    url: PR, id: itemId(PR), instance: "github", kind: "pr", repo: "foo/bar", title: "Fix build", state: "open",
    stateDetail: null, ciState: "failure", hasConflicts: false, authoredByMe: true, maintainedByMe: false, labels: ["bug"],
    lastSignalAt: "2026-11-04T10:00:00.000Z", lastSignalSummary: "review (approved) by @maint", seenAt: null,
    baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
  });
  store.insertEvent({
    itemUrl: PR, key: "r:1", kind: "review", actor: "maint", actorRole: "maintainer", at: "2026-11-04T09:59:00.000Z",
    detectedAt: "2026-11-04T10:00:00.000Z", excerpt: "LGTM", details: { state: "approved" }, isSignal: true, reason: "signal:review", isBaseline: false,
  });
  store.insertEvent({
    itemUrl: PR, key: "c:9", kind: "comment", actor: "rando", actorRole: "contributor", at: "2026-11-04T09:00:00.000Z",
    detectedAt: "2026-11-04T10:00:00.000Z", excerpt: "+1", details: null, isSignal: false, reason: "noise:+1", isBaseline: false,
  });
  store.close();
  fetched = [];
  srv = await startServer({ home, port: 0, adapterFor: () => adapter, now: () => new Date("2026-11-04T12:00:00.000Z") });
});

afterEach(async () => {
  await srv.stop();
  cleanupTmp();
});

const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, srv.url), init);
const send = (method: string, path: string, body: unknown) =>
  api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/items lists items, with filters", async () => {
  const { items } = await (await api("/api/items")).json();
  expect(items.map((i: { url: string }) => i.url)).toEqual([PR, "https://lists.example.org/p1"]);
  expect(items[0]).toMatchObject({ id: itemId(PR), priority: "important", unread: true, ciState: "failure", labels: ["bug"] });
  const unread = await (await api("/api/items?unread=1")).json();
  expect(unread.items).toHaveLength(1);
});

test("GET /api/items/:id/events, noise on request", async () => {
  const id = itemId(PR);
  expect((await (await api(`/api/items/${id}/events`)).json()).events.map((e: { key: string }) => e.key)).toEqual(["r:1"]);
  const all = (await (await api(`/api/items/${id}/events?noise=1`)).json()).events;
  expect(all.map((e: { key: string; reason: string }) => [e.key, e.reason])).toEqual([["r:1", "signal:review"], ["c:9", "noise:+1"]]);
  expect((await api("/api/items/nope/events")).status).toBe(404);
});

test("PATCH /api/items/:id writes items.yaml, commits, and returns the updated item", async () => {
  const res = await send("PATCH", `/api/items/${itemId(PR)}`, { priority: "normal", note: "after 1.4" });
  expect(res.status).toBe(200);
  const { item, warning } = await res.json();
  expect(item).toMatchObject({ priority: "normal", note: "after 1.4" });
  expect(warning).toBeNull();
  expect(readFileSync(join(home, "data/items.yaml"), "utf8")).toContain(`- url: ${PR}\n    priority: normal\n    note: after 1.4\n`);
  const log = Bun.spawnSync(["git", "-C", home, "log", "-1", "config", "--format=%s"]).stdout.toString();
  expect(log).toBe("watcher: mark foo/bar#42 normal; note on foo/bar#42\n");
  expect((await send("PATCH", `/api/items/${itemId(PR)}`, { priority: "high" })).status).toBe(400);
  expect((await send("PATCH", `/api/items/${itemId(PR)}`, { color: "red" })).status).toBe(400);
  expect((await send("PATCH", `/api/items/${itemId(PR)}`, {})).status).toBe(400);
});

test("POST /api/items adds a tracked or manual item", async () => {
  const tracked = await send("POST", "/api/items", { url: "https://github.com/x/y/issues/1" });
  expect(tracked.status).toBe(201);
  expect(await tracked.json()).toEqual({ url: "https://github.com/x/y/issues/1", manual: false, warning: null });
  const manual = await (await send("POST", "/api/items", { url: "https://lists.example.org/p2", title: "[PATCH v2] x" })).json();
  expect(manual.manual).toBe(true);
  const { items } = await (await api("/api/items")).json();
  expect(items.map((i: { title: string }) => i.title)).toContain("[PATCH v2] x");
  const dup = await send("POST", "/api/items", { url: "https://lists.example.org/p2" });
  expect(dup.status).toBe(400);
  expect((await dup.json()).error).toContain("already tracked");
});

const OTHER = "https://github.com/x/y/issues/1";
const houston = () => join(home, "data/registers/houston.yaml");
const addRegister = (text: string) => {
  mkdirSync(join(home, "data/registers"), { recursive: true });
  writeFileSync(houston(), text);
};

test("GET /api/registers lists them, default first", async () => {
  expect(await (await api("/api/registers")).json()).toEqual({ registers: ["default"] });
  addRegister("items:\n");
  expect(await (await api("/api/registers")).json()).toEqual({ registers: ["default", "houston"] });
});

test("?register= picks the register to list, read, change and mark: default is the whole cache", async () => {
  addRegister(`items:\n  - url: ${PR}\n    priority: normal\n    note: for houston\n`);
  const urls = async (path: string) => (await (await api(path)).json()).items.map((i: { url: string }) => i.url);
  expect(await urls("/api/items?register=houston")).toEqual([PR]);
  expect(await urls("/api/items?register=default")).toEqual([PR, "https://lists.example.org/p1"]);
  expect(await urls("/api/items")).toEqual([PR, "https://lists.example.org/p1"]);
  const id = itemId(PR);
  expect((await (await api(`/api/items/${id}?register=houston`)).json()).item).toMatchObject({ priority: "normal", note: "for houston" });
  expect((await (await api(`/api/items/${id}`)).json()).item).toMatchObject({ priority: "important", note: null });
  expect((await api(`/api/items/${itemId("https://lists.example.org/p1")}?register=houston`)).status).toBe(404);
  expect((await api(`/api/items/${id}/events?register=houston`)).status).toBe(200);
  expect((await send("POST", `/api/items/${id}/seen?register=houston`, {})).status).toBe(200);
  const patched = await send("PATCH", `/api/items/${id}?register=houston`, { muted: true });
  expect((await patched.json()).item).toMatchObject({ muted: true });
  expect(readFileSync(houston(), "utf8")).toContain("muted: true");
  expect(readFileSync(join(home, "data/items.yaml"), "utf8")).not.toContain(PR);
  expect(Bun.spawnSync(["git", "-C", home, "log", "-1", "config", "--format=%s"]).stdout.toString()).toBe("watcher: mute foo/bar#42 (register houston)\n");
});

test("a register that does not exist is a 404 to read; a bad name is a 400 on every route", async () => {
  expect((await api("/api/items?register=nope")).status).toBe(404);
  expect((await (await api("/api/items?register=nope")).json()).error).toBe("no such register: nope");
  expect((await api(`/api/items/${itemId(PR)}?register=nope`)).status).toBe(404);
  for (const bad of ["..", "a%2Fb", ".x", "A", ""]) {
    for (const path of ["/api/items", `/api/items/${itemId(PR)}`, `/api/items/${itemId(PR)}/events`]) {
      const res = await api(`${path}?register=${bad}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("invalid register name");
    }
    expect((await send("POST", `/api/items?register=${bad}`, { url: OTHER })).status).toBe(400);
    expect((await send("PATCH", `/api/items/${itemId(PR)}?register=${bad}`, { muted: true })).status).toBe(400);
  }
  expect(Bun.spawnSync(["ls", join(home, "data")]).stdout.toString()).not.toContain("registers");
});

test("POST /api/items?register= adds the item to that register, creating it; the same URL can be in several", async () => {
  const added = await send("POST", "/api/items?register=fresh", { url: PR });
  expect(added.status).toBe(201); // PR is in the cache, but not in `fresh`
  expect(readFileSync(join(home, "data/registers/fresh.yaml"), "utf8")).toBe(`items:\n  - url: ${PR}\n`);
  expect((await send("POST", "/api/items?register=fresh", { url: PR })).status).toBe(400);
  expect((await send("POST", "/api/items", { url: PR })).status).toBe(400); // default: the cache has it
  expect((await (await api("/api/registers")).json()).registers).toEqual(["default", "fresh"]);
});

test("a poll fetches the entries of every register, once", async () => {
  addRegister(`items:\n  - url: ${OTHER}\n  - url: ${ISSUE}\n`);
  mkdirSync(join(home, "data/registers"), { recursive: true });
  writeFileSync(join(home, "data/registers/second.yaml"), `items:\n  - url: ${OTHER}\n`); // default has neither
  await send("POST", "/api/poll", {});
  await srv.idle();
  expect(fetched.sort()).toEqual([ISSUE, OTHER].sort()); // OTHER is in both, ISSUE in a register and found by discovery
});

test("POST seen for one item and for all", async () => {
  expect(await (await send("POST", `/api/items/${itemId(PR)}/seen`, {})).json()).toEqual({ marked: 1 });
  expect((await (await api("/api/items?unread=1")).json()).items).toEqual([]);
  expect((await send("POST", "/api/seen", {})).status).toBe(200);
});

test("POST /api/poll runs a poll in the background; status reports it; a second one is refused", async () => {
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  const res = await send("POST", "/api/poll", {});
  expect(res.status).toBe(202);
  expect((await send("POST", "/api/poll", {})).status).toBe(409);
  expect((await (await api("/api/status")).json()).polling).toBe(true);
  release();
  gate = Promise.resolve();
  await srv.idle();
  expect(fetched).toEqual([ISSUE]);
  const status = await (await api("/api/status")).json();
  expect(status.polling).toBe(false);
  expect(status.lastPoll).toMatchObject({ error: null, results: [{ instance: "github", ok: true, fetched: 1 }] });
  expect(status.instances[0]).toMatchObject({ id: "github", type: "github", error: null, lastSuccessAt: "2026-11-04T12:00:00.000Z" });
});

test("POST /api/poll is refused while another process holds the poll lock", async () => {
  const s = new Store(join(home, "var/cache.sqlite"));
  s.acquireLock("poll", lockHolder(), new Date("2026-11-04T12:00:00.000Z"));
  s.close();
  expect((await send("POST", "/api/poll", {})).status).toBe(409);
});

test("guards: Host must be a loopback name; changes must be JSON from this origin", async () => {
  // DNS rebinding: a foreign name resolving to 127.0.0.1.
  expect((await api("/api/items", { headers: { host: "evil.example:8411" } })).status).toBe(403);
  // A cross-site form post (not JSON) and a JSON request from another origin.
  const form = await api("/api/seen", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
  expect(form.status).toBe(415);
  const cross = await api("/api/seen", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  expect(cross.status).toBe(403);
  const same = await api("/api/seen", { method: "POST", headers: { "content-type": "application/json", origin: new URL(srv.url).origin }, body: "{}" });
  expect(same.status).toBe(200);
  expect((await api("/api/nope")).status).toBe(404);
});

test("behind a reverse proxy: an allowed public Host, with a https origin, is accepted", async () => {
  await srv.stop();
  srv = await startServer({ home, port: 0, adapterFor: () => adapter, allowedHosts: ["Watcher.Example.org"] });
  expect((await api("/api/items", { headers: { host: "watcher.example.org" } })).status).toBe(200);
  const proxied = await api("/api/seen", {
    method: "POST", body: "{}",
    headers: { host: "watcher.example.org", origin: "https://watcher.example.org", "content-type": "application/json" },
  });
  expect(proxied.status).toBe(200);
  expect((await api("/api/items", { headers: { host: "evil.example" } })).status).toBe(403);
});

test("bound to all interfaces, the Host check still applies; allowed names may carry a port", async () => {
  await srv.stop();
  srv = await startServer({ home, port: 0, hostname: "0.0.0.0", adapterFor: () => adapter, allowedHosts: ["192.168.1.5:8411", ""] });
  const base = srv.url.replace("0.0.0.0", "127.0.0.1");
  const get = (host: string) => fetch(new URL("/api/items", base), { headers: { host } });
  expect((await get("evil.example:8411")).status).toBe(403); // DNS rebinding, even off loopback
  expect((await get("192.168.1.5:8411")).status).toBe(200);
  expect((await get("localhost")).status).toBe(200);
});

test("GET / serves the web UI", async () => {
  const res = await api("/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<div id="app"></div>');
  expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="[^"]*favicon[^"]*\.svg"/);
});

test("the script the page loads carries the register switcher and the subscription view", async () => {
  const html = await (await api("/")).text();
  const src = html.match(/<script[^>]*src="([^"]+)"/)?.[1];
  expect(src).toBeTruthy();
  const res = await api(src!);
  expect(res.status).toBe(200);
  const js = await res.text();
  for (const piece of ['aria-label="Register"', "/api/subscription-status", "/api/registers", "#subscriptions", "watcher ack"]) expect(js).toContain(piece);
});

test("subscriptions over HTTP: create, updates (never moving the cursor), ack, track, untrack, list", async () => {
  expect(await (await api("/api/subscriptions")).json()).toEqual({ subscriptions: [] });
  const made = await send("PUT", "/api/subscriptions/proj", { all: true });
  expect(made.status).toBe(200);
  expect(await made.json()).toMatchObject({ subscription: "proj" });
  const store = new Store(join(home, "var/cache.sqlite"));
  store.insertEvent({
    itemUrl: PR, key: "c:10", kind: "comment", actor: "maint", actorRole: "maintainer", at: "2026-11-04T11:00:00.000Z",
    detectedAt: "2026-11-04T11:01:00.000Z", excerpt: "ping", details: null, isSignal: true, reason: "signal:comment", isBaseline: false,
  });
  store.close();
  const read = async () => (await api("/api/subscriptions/proj/updates")).json();
  const r = await read();
  expect(r.token).toBe("proj.3");
  expect(r.items.map((g: { item: { url: string }; events: { key: string }[] }) => [g.item.url, g.events.map((e) => e.key)])).toEqual([[PR, ["c:10"]]]);
  expect(await read()).toEqual(r);
  expect(await (await send("POST", "/api/subscriptions/proj/ack", { token: r.token })).json()).toEqual({ subscription: "proj", cursor: 3 });
  expect((await read()).items).toEqual([]);
  const tracked = await send("POST", "/api/subscriptions/proj/track", { url: `${PR}/files` });
  expect(tracked.status).toBe(200);
  expect(await tracked.json()).toMatchObject({ url: PR, added: false }); // the cache knows it already
  expect((await (await api("/api/subscriptions")).json()).subscriptions).toMatchObject([{ name: "proj", register: "default" }]);
  expect(await (await send("POST", "/api/subscriptions/proj/untrack", { url: PR })).json()).toMatchObject({ url: PR });
});

test("subscription errors: a missing one is 404, a bad name, token or body 400, never a path", async () => {
  expect((await api("/api/subscriptions/nobody/updates")).status).toBe(404);
  expect((await send("PUT", "/api/subscriptions/Bad_Name!", {})).status).toBe(400);
  expect((await send("PUT", "/api/subscriptions/proj", { register: "nope" })).status).toBe(404);
  expect((await send("PUT", "/api/subscriptions/proj", { all: "yes" })).status).toBe(400);
  await send("PUT", "/api/subscriptions/proj", {});
  expect((await send("POST", "/api/subscriptions/proj/ack", {})).status).toBe(400);
  const bad = await send("POST", "/api/subscriptions/proj/ack", { token: "other.1" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("not from proj's updates");
  expect((await send("POST", "/api/subscriptions/proj/track", { url: 3 })).status).toBe(400);
  expect((await send("POST", "/api/subscriptions/proj/track", { url: "nonsense" })).status).toBe(400);
});

test("a subscriptions.yaml that does not parse is in /api/status problems, and the other endpoints still work", async () => {
  writeFileSync(join(home, "data/subscriptions.yaml"), "subscriptions:\n  - name: p\n    scope: some\n");
  const status = await (await api("/api/status")).json();
  expect(status.problems).toHaveLength(1);
  expect(JSON.stringify(status.problems)).toContain("subscriptions.yaml");
  expect((await api("/api/items")).status).toBe(200);
});

test("a poll started from the web runs the after_poll hook once", async () => {
  const dir = tmpDir("srv-hook");
  const ran = join(dir, "ran");
  const sh = join(dir, "h.sh");
  writeFileSync(sh, `#!/bin/sh\necho x >> ${ran}\n`);
  chmodSync(sh, 0o755);
  await srv.stop();
  writeFileSync(join(home, "data/config.yaml"), `instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\nafter_poll: [${sh}]\n`);
  srv = await startServer({ home, port: 0, adapterFor: () => adapter, now: () => new Date("2026-11-04T12:00:00.000Z") });
  expect((await send("POST", "/api/poll", {})).status).toBe(202);
  await srv.idle();
  expect(readFileSync(ran, "utf8")).toBe("x\n");
});

// The subscription view of the web page: where each subscription stands, never changing it.
const news = (itemUrl: string, key: string) => {
  const store = new Store(join(home, "var/cache.sqlite"));
  store.insertEvent({
    itemUrl, key, kind: "comment", actor: "maint", actorRole: "maintainer", at: "2026-11-04T11:00:00.000Z",
    detectedAt: "2026-11-04T11:01:00.000Z", excerpt: "ping", details: null, isSignal: true, reason: "signal:comment", isBaseline: false,
  });
  store.close();
};
const cursorOf = (name: string) => {
  const store = new Store(join(home, "var/cache.sqlite"));
  const c = store.subscriptionCursor(name);
  store.close();
  return c;
};
const standing = async () => (await (await api("/api/subscription-status")).json()).subscriptions;

test("GET /api/subscription-status is empty without subscriptions", async () => {
  expect(await (await api("/api/subscription-status")).json()).toEqual({ subscriptions: [] });
});

test("GET /api/subscription-status: scope, cursor, newest number and the unseen updates per item", async () => {
  await send("PUT", "/api/subscriptions/proj", { all: true }); // cursor at 2: the two events of the fixture
  news(PR, "c:10");
  news(PR, "c:11");
  expect(await standing()).toEqual([
    {
      name: "proj", register: "default", scope: "all", exclude: [], cursor: 2, latest: 4, error: null,
      unseen: 2, items: [{ url: PR, id: itemId(PR), title: "Fix build", count: 2 }],
    },
  ]);
});

test("reading the status never moves the cursor, nor starts one", async () => {
  await send("PUT", "/api/subscriptions/proj", { all: true });
  news(PR, "c:10");
  await standing();
  await standing();
  expect(cursorOf("proj")).toBe(2);
  writeFileSync(join(home, "data/subscriptions.yaml"), "subscriptions:\n  - name: proj\n    register: default\n    scope: all\n  - name: fresh\n    register: default\n    scope: all\n");
  const [, fresh] = await standing();
  expect(fresh).toMatchObject({ name: "fresh", cursor: null, unseen: 0, items: [] });
  expect(cursorOf("fresh")).toBeNull();
});

test("an acknowledgement empties the unseen count, and the number reported is the cursor", async () => {
  await send("PUT", "/api/subscriptions/proj", { all: true });
  news(PR, "c:10");
  const r = await (await api("/api/subscriptions/proj/updates")).json();
  await send("POST", "/api/subscriptions/proj/ack", { token: r.token });
  expect(await standing()).toMatchObject([{ cursor: 3, latest: 3, unseen: 0, items: [] }]);
});

test("the status follows the scope: only followed items count, exclusions and muted entries do not", async () => {
  await send("PUT", "/api/subscriptions/mine", { all: false });
  await send("POST", "/api/subscriptions/mine/track", { url: PR });
  await send("PUT", "/api/subscriptions/rest", { all: true });
  await send("POST", "/api/subscriptions/rest/untrack", { url: PR }); // all: an exclusion
  news(PR, "c:10");
  const [mine, rest] = await standing();
  expect(mine).toMatchObject({ name: "mine", scope: [PR], unseen: 1 });
  expect(rest).toMatchObject({ name: "rest", scope: "all", exclude: [PR], unseen: 0, items: [] });
  await send("PATCH", `/api/items/${itemId(PR)}`, { muted: true });
  expect((await standing())[0]).toMatchObject({ unseen: 0 });
});

test("a subscription on a register that is gone says so and does not fail the others", async () => {
  addRegister("items:\n");
  await send("PUT", "/api/subscriptions/gone", { register: "houston" });
  await send("PUT", "/api/subscriptions/proj", { all: true });
  rmSync(houston());
  const [gone, proj] = await standing();
  expect(gone).toMatchObject({ name: "gone", register: "houston", error: "no such register: houston", unseen: 0, items: [] });
  expect(proj).toMatchObject({ name: "proj", error: null });
});

test("a register file that does not parse is that subscription's error, not the whole view's", async () => {
  addRegister("items:\n");
  await send("PUT", "/api/subscriptions/mine", { register: "houston" });
  await send("PUT", "/api/subscriptions/proj", { all: true });
  writeFileSync(houston(), "items: 3\n");
  const res = await api("/api/subscription-status");
  expect(res.status).toBe(200);
  const [mine, proj] = (await res.json()).subscriptions;
  expect(mine).toMatchObject({ name: "mine", unseen: 0, items: [] });
  expect(mine.error).toContain("'items' must be a list");
  expect(proj).toMatchObject({ name: "proj", error: null });
});

test("a system error in the status carries no path", async () => {
  addRegister("items:\n");
  await send("PUT", "/api/subscriptions/mine", { register: "houston" });
  rmSync(houston());
  mkdirSync(houston()); // reading a directory: EISDIR, whose message names the path
  const [mine] = (await (await api("/api/subscription-status")).json()).subscriptions;
  expect(mine.error).toBeTruthy();
  expect(mine.error).not.toContain(home);
});

test("a subscriptions.yaml that does not parse is a 400 with its text on the status endpoint", async () => {
  writeFileSync(join(home, "data/subscriptions.yaml"), "subscriptions:\n  - name: p\n    scope: some\n");
  const res = await api("/api/subscription-status");
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("subscriptions.yaml");
});
