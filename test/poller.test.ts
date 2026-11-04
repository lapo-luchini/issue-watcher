import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_FILTER, type Config, type InstanceConfig } from "../src/core/config.ts";
import { GoneError, RateLimitError } from "../src/core/http.ts";
import { parseIntent } from "../src/core/intent.ts";
import type { Adapter, ItemRef, NormalizedEvent, Snapshot } from "../src/core/model.ts";
import { applySnapshot, CURSOR_OVERLAP_MS, pollAll, refilter, type PollContext } from "../src/core/poller.ts";
import { Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
const ISSUE = "https://github.com/foo/bar/issues/7";
const inst: InstanceConfig = { id: "github", type: "github", url: "https://api.github.com", user: "lapo" };
const config: Config = { instances: [inst], filter: DEFAULT_FILTER };

const T0 = new Date("2026-11-04T10:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function comment(key: string, at: Date, actorRole: NormalizedEvent["actorRole"], body: string, actor = "maint"): NormalizedEvent {
  return { key, kind: "comment", actor, actorRole, at, body };
}

function snapshot(url: string, events: NormalizedEvent[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    ref: { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" },
    repo: "foo/bar", title: "Title", state: "open", authoredByMe: true, labels: [], events, ...extra,
  };
}

/** A fake adapter whose discover/fetch results are set per test. */
class FakeAdapter implements Adapter {
  discovered: ItemRef[] = [];
  snapshots = new Map<string, Snapshot | Error>();
  sinceSeen: (Date | null)[] = [];
  refFromUrl(url: string): ItemRef | null {
    return url.startsWith("https://github.com/") ? { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" } : null;
  }
  async discover(since: Date | null) {
    this.sinceSeen.push(since);
    return this.discovered;
  }
  async fetch(ref: ItemRef) {
    const s = this.snapshots.get(ref.url);
    if (!s) throw new Error(`no snapshot for ${ref.url}`);
    if (s instanceof Error) throw s;
    return s;
  }
}

let store: Store;
let adapter: FakeAdapter;
let clock: Date;
let ctx: PollContext;
beforeEach(() => {
  store = new Store(":memory:");
  adapter = new FakeAdapter();
  clock = T0;
  ctx = { store, config, intent: new Map(), adapterFor: () => adapter, now: () => clock };
});

const unread = (url: string) => {
  const i = store.getItem(url)!;
  return i.lastSignalAt !== null && (i.seenAt === null || i.lastSignalAt > i.seenAt);
};

test("first sight is baseline: history stored, nothing unread", () => {
  const n = applySnapshot(snapshot(PR, [comment("c:1", minutes(-60), "maintainer", "Please rebase")]), ctx, T0, null);
  expect(n).toBe(0);
  expect(store.eventsFor(PR)).toHaveLength(1);
  expect(store.getItem(PR)).toMatchObject({ baselineAt: T0.toISOString(), lastSignalAt: null });
  expect(unread(PR)).toBe(false);
});

test("new signal after baseline makes the item unread, noise does not", () => {
  applySnapshot(snapshot(PR, []), ctx, T0, null);
  expect(applySnapshot(snapshot(PR, [comment("c:2", minutes(5), "contributor", "+1", "rando")]), ctx, minutes(10), null)).toBe(0);
  expect(unread(PR)).toBe(false);
  expect(applySnapshot(snapshot(PR, [comment("c:3", minutes(15), "maintainer", "LGTM")]), ctx, minutes(20), null)).toBe(1);
  expect(store.getItem(PR)).toMatchObject({ lastSignalAt: minutes(20).toISOString(), lastSignalSummary: "comment by @maint: LGTM" });
  expect(unread(PR)).toBe(true);
});

test("re-fetching the same events is idempotent", () => {
  applySnapshot(snapshot(PR, []), ctx, T0, null);
  const s = snapshot(PR, [comment("c:3", minutes(15), "maintainer", "LGTM")]);
  expect(applySnapshot(s, ctx, minutes(20), null)).toBe(1);
  expect(applySnapshot(s, ctx, minutes(40), null)).toBe(0);
  expect(store.getItem(PR)?.lastSignalAt).toBe(minutes(20).toISOString());
});

test("my own reply after the latest signal marks the item seen", () => {
  applySnapshot(snapshot(PR, []), ctx, T0, null);
  applySnapshot(snapshot(PR, [
    comment("c:1", minutes(5), "maintainer", "Please rebase"),
    comment("c:2", minutes(8), "me", "Done, rebased.", "lapo"),
  ]), ctx, minutes(10), null);
  expect(unread(PR)).toBe(false);
  applySnapshot(snapshot(PR, [comment("c:3", minutes(12), "maintainer", "Thanks, merging after CI")]), ctx, minutes(15), null);
  expect(unread(PR)).toBe(true);
});

test("CI changes and conflicts are derived; pending keeps the last settled state", () => {
  applySnapshot(snapshot(PR, [], { ciState: "success" }), ctx, T0, null);
  expect(applySnapshot(snapshot(PR, [], { ciState: "pending" }), ctx, minutes(5), null)).toBe(0);
  expect(store.getItem(PR)?.ciState).toBe("success");
  expect(applySnapshot(snapshot(PR, [], { ciState: "failure" }), ctx, minutes(10), null)).toBe(1);
  expect(store.getItem(PR)?.lastSignalSummary).toBe("CI → failure");
  expect(applySnapshot(snapshot(PR, [], { ciState: "failure", hasConflicts: true }), ctx, minutes(15), null)).toBe(1);
  expect(store.getItem(PR)?.lastSignalSummary).toBe("merge conflict");
});

test("first green CI is not news; CI on a normal-priority item is stored as noise", () => {
  applySnapshot(snapshot(PR, []), ctx, T0, null);
  expect(applySnapshot(snapshot(PR, [], { ciState: "success" }), ctx, minutes(5), null)).toBe(0);
  const other = "https://github.com/x/y/pull/1";
  applySnapshot(snapshot(other, [], { authoredByMe: false, ciState: "success" }), ctx, T0, null);
  expect(applySnapshot(snapshot(other, [], { authoredByMe: false, ciState: "failure" }), ctx, minutes(5), null)).toBe(0);
  expect(store.eventsFor(other, true)[0]?.reason).toBe("low-priority:ci");
});

test("pollAll: discovery, intent-only items, cursor and overlap", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, snapshot(PR, []));
  adapter.snapshots.set(ISSUE, snapshot(ISSUE, []));
  ctx.intent = parseIntent(`items:\n  - url: ${ISSUE}\n    priority: important\n  - url: https://lists.example.org/x\n    manual: true`);
  const [r] = await pollAll(ctx);
  expect(r).toEqual({ instance: "github", ok: true, fetched: 2, newSignals: 0 });
  expect(store.getItem(ISSUE)).not.toBeNull();
  expect(store.getItem("https://lists.example.org/x")).toBeNull();
  expect(adapter.sinceSeen).toEqual([null]);
  clock = minutes(30);
  await pollAll(ctx);
  expect(adapter.sinceSeen[1]?.getTime()).toBe(T0.getTime() - CURSOR_OVERLAP_MS);
});

test("pollAll: a failed item keeps the cursor; gone items get one signal", async () => {
  applySnapshot(snapshot(ISSUE, []), ctx, T0, null);
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }, { url: ISSUE, instance: "github", kind: "issue" }];
  adapter.snapshots.set(PR, new Error("boom"));
  adapter.snapshots.set(ISSUE, new GoneError(404, "x"));
  clock = minutes(10);
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: false, newSignals: 1, error: `1 item(s) failed; first: ${PR}: boom` });
  expect(store.getItem(ISSUE)).toMatchObject({ state: "gone", lastSignalSummary: "→ gone" });
  expect(store.getCursor("github")).toBeNull();
});

test("pollAll: rate limit stops the instance; disabled instances report why", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, new RateLimitError(403, "x", null));
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: false, error: "rate limited on x" });
  ctx.config = { ...config, instances: [{ ...inst, disabledReason: "missing GITHUB_TOKEN in .env" }] };
  const [d] = await pollAll(ctx);
  expect(d).toMatchObject({ ok: false, error: "missing GITHUB_TOKEN in .env" });
});

test("pollAll: dry run writes nothing; lock prevents overlap", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, snapshot(PR, []));
  const [r] = await pollAll(ctx, { dryRun: true });
  expect(r?.fetched).toBe(1);
  expect(store.getItem(PR)).toBeNull();
  expect(store.getCursor("github")).toBeNull();
  store.acquireLock("poll", "other", T0);
  await expect(pollAll(ctx)).rejects.toThrow("a poll is already running");
  await expect(pollAll(ctx, { only: "nope" })).rejects.toThrow("unknown instance 'nope'");
});

test("refilter re-evaluates stored events with a new config", () => {
  applySnapshot(snapshot(PR, []), ctx, T0, null);
  applySnapshot(snapshot(PR, [comment("c:1", minutes(5), "contributor", "works for me on 14.1 amd64 with the patch applied", "user")]), ctx, minutes(10), null);
  expect(unread(PR)).toBe(true);
  const stricter: Config = { ...config, filter: { ...DEFAULT_FILTER, noisePatterns: ["^works for me"] } };
  expect(refilter(store, stricter, new Map())).toEqual({ changed: 1 });
  expect(store.getItem(PR)?.lastSignalAt).toBeNull();
  expect(unread(PR)).toBe(false);
});

test("pollAll: an item first seen on an incremental run reports events after the cursor", async () => {
  await pollAll(ctx); // first run: sets the cursor at T0
  const other = "https://github.com/x/y/issues/3";
  adapter.discovered = [{ url: ISSUE, instance: "github", kind: "issue" }, { url: other, instance: "github", kind: "issue" }];
  adapter.snapshots.set(ISSUE, snapshot(ISSUE, [
    comment("c:1", minutes(-60), "maintainer", "Old history"),
    comment("c:2", minutes(10), "maintainer", "Can you look at this?"),
    { key: "rr:3", kind: "review_request", actor: "maint", actorRole: "maintainer", at: minutes(20) },
  ]));
  adapter.snapshots.set(other, snapshot(other, [comment("c:9", minutes(-30), "maintainer", "Only old stuff")]));
  clock = minutes(30);
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: true, newSignals: 2 });
  expect(unread(ISSUE)).toBe(true);
  expect(store.getItem(ISSUE)?.lastSignalSummary).toBe("review request by @maint");
  expect(store.eventsFor(ISSUE).map((e) => [e.key, e.isBaseline])).toEqual([["rr:3", false], ["c:2", false], ["c:1", true]]);
  expect(unread(other)).toBe(false);
  refilter(store, config, new Map());
  expect(store.getItem(ISSUE)).toMatchObject({ lastSignalAt: minutes(30).toISOString(), lastSignalSummary: "review request by @maint" });
  expect(unread(other)).toBe(false);
});
