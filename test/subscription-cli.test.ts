// The subscription commands of the CLI, end to end against a throwaway WATCHER_HOME (no network).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmp, tmpDir } from "./tmp.ts";
import { itemId, Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
const OTHER = "https://github.com/foo/bar/pull/43";
let home: string;

afterEach(cleanupTmp);

const event = (itemUrl: string, key: string) => ({
  itemUrl, key, kind: "comment" as const, actor: "maint", actorRole: "maintainer" as const, at: "2026-11-04T09:00:00.000Z",
  detectedAt: "2026-11-04T10:00:00.000Z", excerpt: key, details: null, isSignal: true, reason: "signal:comment", isBaseline: false,
});

beforeEach(() => {
  home = tmpDir("subcli");
  for (const args of [["init", "-q"], ["config", "user.name", "T"], ["config", "user.email", "t@example.org"]]) Bun.spawnSync(["git", "-C", home, ...args]);
  mkdirSync(join(home, "data"));
  writeFileSync(join(home, "data/config.yaml"), "instances:\n  - {id: github, type: github, url: https://api.github.com, user: lapo}\n");
  writeFileSync(join(home, "data/items.yaml"), `items:\n  - url: ${PR}\n  - url: ${OTHER}\n`);
  Bun.spawnSync(["git", "-C", home, "add", "-f", "."]);
  Bun.spawnSync(["git", "-C", home, "commit", "-qm", "init"]);
  mkdirSync(join(home, "var"));
  const store = new Store(join(home, "var/cache.sqlite"));
  for (const url of [PR, OTHER]) {
    store.upsertItem({
      url, id: itemId(url), instance: "github", kind: "pr", repo: "foo/bar", title: `Fix ${url.split("/").pop()}`,
      state: "open", stateDetail: null, ciState: null, hasConflicts: false, authoredByMe: true, maintainedByMe: false, labels: [],
      lastSignalAt: null, lastSignalSummary: null, seenAt: null,
      baselineAt: "2026-11-01T00:00:00.000Z", fetchedAt: "2026-11-04T10:00:00.000Z", snapshotJson: null,
    });
  }
  store.close();
});

function watcherWith(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, WATCHER_REGISTER: "", WATCHER_SUBSCRIPTION: "", WATCHER_HOME: home, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const watcher = (...args: string[]) => watcherWith({}, ...args);
const insert = (...events: ReturnType<typeof event>[]) => {
  const store = new Store(join(home, "var/cache.sqlite"));
  for (const e of events) store.insertEvent(e);
  store.close();
};
const cursor = (name: string) => {
  const store = new Store(join(home, "var/cache.sqlite"));
  try {
    return store.subscriptionCursor(name);
  } finally {
    store.close();
  }
};

test("subscribe, then updates --peek prints the news and a token, and does not move the cursor; ack moves it", () => {
  expect(watcher("subscribe", "proj", "--all")).toMatchObject({ code: 0, out: "proj: subscribed\n" });
  insert(event(PR, "c1"), event(OTHER, "c2"));
  const r = watcher("updates", "--peek", "--subscription", "proj");
  expect(r.code).toBe(0);
  expect(r.out).toContain("foo/bar  Fix 43\n  comment by @maint: c2\n  " + OTHER);
  expect(r.out).toContain("foo/bar  Fix 42\n  comment by @maint: c1\n  " + PR);
  expect(r.out).toContain("token: proj.2  (watcher ack --subscription proj proj.2)");
  expect(cursor("proj")).toBe(0);
  expect(watcher("updates", "--subscription", "proj").out).toBe(r.out); // without --peek it is the same: reading never moves it
  expect(watcher("ack", "--subscription", "proj", "proj.2")).toMatchObject({ code: 0, out: "proj: read up to 2\n" });
  expect(cursor("proj")).toBe(2);
  expect(watcher("updates", "--subscription", "proj").out).toBe("proj: no updates\n");
});

test("updates --json prints the answer as JSON, with the token", () => {
  watcher("subscribe", "proj", "--all");
  insert(event(PR, "c1"));
  const j = JSON.parse(watcher("updates", "--json", "--subscription", "proj").out);
  expect(j.subscription).toBe("proj");
  expect(j.token).toBe("proj.1");
  expect(j.items[0].item.url).toBe(PR);
  expect(j.items[0].events[0].summary).toBe("comment by @maint: c1");
});

test("WATCHER_SUBSCRIPTION is the default subscription; without it and without a flag the command says so", () => {
  watcher("subscribe", "proj", "--all");
  insert(event(PR, "c1"));
  expect(watcherWith({ WATCHER_SUBSCRIPTION: "proj" }, "updates").out).toContain("token: proj.1");
  const none = watcher("updates");
  expect(none.code).toBe(1);
  expect(none.err).toContain("no subscription: name one with --subscription or WATCHER_SUBSCRIPTION");
  expect(watcherWith({ WATCHER_SUBSCRIPTION: "../x" }, "updates").err).toContain("invalid subscription name");
  // a bad value of the variable only matters to the commands that need it
  expect(watcherWith({ WATCHER_SUBSCRIPTION: "../x" }, "list").code).toBe(0);
});

test("track adds and follows; unsubscribe stops; subscriptions lists them", () => {
  watcher("subscribe", "proj");
  const t = watcher("track", "--subscription", "proj", `${PR}/files`);
  expect(t).toMatchObject({ code: 0 });
  expect(t.out).toBe(`proj: following ${PR}\nfoo/bar  Fix 42  [open]  no news yet\n`);
  expect(watcher("subscriptions").out).toBe("proj  register default  1 item(s)\n");
  expect(readFileSync(join(home, "data/subscriptions.yaml"), "utf8")).toBe(`subscriptions:\n  - name: proj\n    scope:\n      - ${PR}\n`);
  expect(watcher("unsubscribe", "--subscription", "proj", PR).out).toBe(`proj: no longer following ${PR}\n`);
  expect(watcher("subscriptions").out).toBe("proj  register default  0 item(s)\n");
});

test("ack with a token of another subscription or none is refused, and the cursor stays", () => {
  watcher("subscribe", "proj", "--all");
  watcher("subscribe", "other", "--all");
  insert(event(PR, "c1"));
  const r = watcher("ack", "--subscription", "other", "proj.1");
  expect(r.code).toBe(1);
  expect(r.err).toContain("not from other's updates");
  expect(cursor("other")).toBe(0);
  expect(watcher("ack", "--subscription", "other").err).toContain("ack takes exactly one token");
});
