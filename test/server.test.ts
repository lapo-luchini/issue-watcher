// The HTTP API against a temporary watcher home (a git repo) and a fake forge.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
