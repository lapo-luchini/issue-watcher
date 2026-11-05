import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_FILTER, type Config, type InstanceConfig } from "../src/core/config.ts";
import { GoneError, RateLimitError } from "../src/core/http.ts";
import { parseIntent } from "../src/core/intent.ts";
import type { Adapter, ItemRef, NormalizedEvent, Snapshot } from "../src/core/model.ts";
import { applySnapshot, CURSOR_OVERLAP_MS, pollAll, refilter, type PollContext } from "../src/core/poller.ts";
import { Store } from "../src/core/store.ts";

const PR = "https://github.com/foo/bar/pull/42";
const ISSUE = "https://github.com/foo/bar/issues/7";
const inst: InstanceConfig = { id: "github", type: "github", url: "https://api.github.com", user: "lapo", emails: [] };
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
  knownSeen: ItemRef[][] = [];
  refFromUrl(url: string): ItemRef | null {
    return url.startsWith("https://github.com/") ? { url, instance: "github", kind: url.includes("/pull/") ? "pr" : "issue" } : null;
  }
  async discover(since: Date | null, known: ItemRef[]) {
    this.sinceSeen.push(since);
    this.knownSeen.push(known);
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

test("first sight on a later run: with unreliable timestamps, nothing is baseline", () => {
  // Radicle: author clocks, and patches arrive late by gossip. An item new to discovery after
  // the first run is news, whatever its timestamps say.
  const since = minutes(-10);
  const old = comment("c:1", minutes(-600), "contributor", "A patch written offline last week.", "alice");
  expect(applySnapshot(snapshot(PR, [old], { timesUnreliable: true }), ctx, T0, since)).toBe(1);
  expect(unread(PR)).toBe(true);
  // The first run still starts quiet, and reliable timestamps keep the usual rule.
  const other = "https://github.com/x/y/pull/9";
  expect(applySnapshot(snapshot(other, [{ ...old }], { timesUnreliable: true }), ctx, T0, null)).toBe(0);
  const third = "https://github.com/x/y/pull/10";
  expect(applySnapshot(snapshot(third, [{ ...old }]), ctx, T0, since)).toBe(0);
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

test("CI briefly absent keeps the last settled state", () => {
  applySnapshot(snapshot(PR, [], { ciState: "failure" }), ctx, T0, null);
  expect(applySnapshot(snapshot(PR, [], { ciState: null }), ctx, minutes(5), null)).toBe(0);
  expect(store.getItem(PR)?.ciState).toBe("failure");
  expect(applySnapshot(snapshot(PR, [], { ciState: "success" }), ctx, minutes(10), null)).toBe(1);
  expect(store.getItem(PR)?.lastSignalSummary).toBe("CI → success");
});

test("unknown mergeability keeps the previous conflict state", () => {
  applySnapshot(snapshot(PR, []), ctx, T0, null);
  expect(applySnapshot(snapshot(PR, [], { hasConflicts: true }), ctx, minutes(5), null)).toBe(1);
  expect(applySnapshot(snapshot(PR, [], { hasConflicts: null }), ctx, minutes(10), null)).toBe(0);
  expect(store.getItem(PR)?.hasConflicts).toBe(true);
  expect(applySnapshot(snapshot(PR, [], { hasConflicts: true }), ctx, minutes(15), null)).toBe(0);
  expect(store.eventsFor(PR).filter((e) => e.kind === "conflict")).toHaveLength(1);
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

test("a patch on a repo I maintain is important by default, and the flag is stored", () => {
  const incoming = "https://github.com/me/mine/pull/3";
  applySnapshot(snapshot(incoming, [], { authoredByMe: false, maintainedByMe: true, ciState: "success" }), ctx, T0, null);
  expect(store.getItem(incoming)?.maintainedByMe).toBe(true);
  expect(applySnapshot(snapshot(incoming, [], { authoredByMe: false, maintainedByMe: true, ciState: "failure" }), ctx, minutes(5), null)).toBe(1);
  expect(store.eventsFor(incoming)[0]?.reason).toBe("signal:ci");
});

test("pollAll: changed discovery settings (a fixed user name, say) start over with a first run", async () => {
  const lines: string[] = [];
  ctx.log = (l) => lines.push(l);
  await pollAll(ctx); // e.g. with the wrong user: finds nothing, but succeeds and sets a cursor
  clock = minutes(30);
  ctx.config = { ...config, instances: [{ ...inst, user: "lapo-real" }] };
  await pollAll(ctx);
  // Not "updated since the last poll": that would never find the older items of the new user.
  expect(adapter.sinceSeen).toEqual([null, null]);
  expect(lines).toContain("github: discovery settings changed since the last poll: starting over as a first run");
  // Unchanged settings keep the cursor; the token is not part of them.
  clock = minutes(60);
  ctx.config = { ...config, instances: [{ ...inst, user: "lapo-real", token: "another" }] };
  await pollAll(ctx);
  expect(adapter.sinceSeen[2]?.getTime()).toBe(minutes(30).getTime() - CURSOR_OVERLAP_MS);
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
  expect(adapter.knownSeen).toEqual([[]]);
  clock = minutes(30);
  await pollAll(ctx);
  expect(adapter.sinceSeen[1]?.getTime()).toBe(T0.getTime() - CURSOR_OVERLAP_MS);
  // Discovery is told which items are already tracked, so it can check them for updates.
  expect(adapter.knownSeen[1]?.map((r) => r.url)).toEqual([ISSUE, PR]);
});

test("pollAll: a failed item is retried later without holding back the cursor; gone items get one signal", async () => {
  applySnapshot(snapshot(ISSUE, []), ctx, T0, null);
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }, { url: ISSUE, instance: "github", kind: "issue" }];
  adapter.snapshots.set(PR, new Error("boom"));
  adapter.snapshots.set(ISSUE, new GoneError(404, "x"));
  clock = minutes(10);
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: false, newSignals: 1, error: `1 item(s) failed; first: ${PR}: boom` });
  expect(store.getItem(ISSUE)).toMatchObject({ state: "gone", lastSignalSummary: "→ gone" });
  expect(store.getCursor("github")).toBe(minutes(10).toISOString());
  expect(store.listRetries("github")).toEqual([
    { instance: "github", itemUrl: PR, kind: "pr", attempts: 1, lastError: "boom", firstSince: null },
  ]);

  // Next run: discovery no longer reports the PR, but the retry list does.
  adapter.discovered = [];
  adapter.snapshots.set(PR, snapshot(PR, []));
  clock = minutes(20);
  const [r2] = await pollAll(ctx);
  expect(r2).toMatchObject({ ok: true, fetched: 1 });
  expect(store.getItem(PR)).not.toBeNull();
  expect(store.listRetries("github")).toEqual([]);
});

test("pollAll: a new item fetched only on retry is judged against the run where it first failed", async () => {
  await pollAll(ctx); // run 1 at T0: sets the cursor
  adapter.discovered = [{ url: ISSUE, instance: "github", kind: "issue" }];
  adapter.snapshots.set(ISSUE, new Error("boom"));
  clock = minutes(30);
  await pollAll(ctx); // run 2: since = T0 - overlap; the new item fails
  const since2 = new Date(T0.getTime() - CURSOR_OVERLAP_MS).toISOString();
  expect(store.listRetries("github")[0]).toMatchObject({ attempts: 1, firstSince: since2 });
  clock = minutes(60);
  await pollAll(ctx); // run 3: still fails; firstSince is kept
  expect(store.listRetries("github")[0]).toMatchObject({ attempts: 2, firstSince: since2 });

  adapter.discovered = [];
  adapter.snapshots.set(ISSUE, snapshot(ISSUE, [
    comment("c:1", minutes(-30), "maintainer", "Old history"),
    comment("c:2", minutes(10), "maintainer", "Posted between run 2 and run 3"), // before run 4's since
  ]));
  clock = minutes(90);
  const [r] = await pollAll(ctx); // run 4: since = minutes(55)
  expect(r).toMatchObject({ ok: true, newSignals: 1 });
  expect(unread(ISSUE)).toBe(true);
  expect(store.eventsFor(ISSUE).map((e) => [e.key, e.isBaseline])).toEqual([["c:2", false], ["c:1", true]]);
});

test("pollAll: an item that keeps failing is dropped after 5 attempts", async () => {
  const lines: string[] = [];
  ctx.log = (l) => lines.push(l);
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, new Error("boom"));
  for (let i = 1; i <= 5; i++) {
    clock = minutes(i * 10);
    const [r] = await pollAll(ctx);
    expect(r?.ok).toBe(false);
    adapter.discovered = [];
    expect(store.listRetries("github").length).toBe(i < 5 ? 1 : 0);
  }
  expect(lines).toEqual([`  giving up on ${PR} after 5 failed attempts: boom`]);
  clock = minutes(60);
  expect((await pollAll(ctx))[0]).toMatchObject({ ok: true, fetched: 0 });
});

test("pollAll: rate limit stops the instance without advancing the cursor; disabled instances report why", async () => {
  adapter.discovered = [{ url: PR, instance: "github", kind: "pr" }];
  adapter.snapshots.set(PR, new RateLimitError(403, "x", null));
  const [r] = await pollAll(ctx);
  expect(r).toMatchObject({ ok: false, error: "rate limited on x" });
  expect(store.getCursor("github")).toBeNull();
  expect(store.listRetries("github")).toEqual([]);
  ctx.config = { ...config, instances: [{ ...inst, disabledReason: "missing GITHUB_TOKEN in .env" }] };
  const [d] = await pollAll(ctx);
  expect(d).toMatchObject({ ok: false, error: "missing GITHUB_TOKEN in .env" });
});

test("pollAll: a rate limit waits for in-flight fetches, so a dry run still persists nothing", async () => {
  const urls = [1, 2, 3, 4].map((n) => `https://github.com/foo/bar/pull/${n}`);
  adapter.discovered = urls.map((url) => ({ url, instance: "github", kind: "pr" }));
  const release: (() => void)[] = [];
  adapter.fetch = async (ref: ItemRef) => {
    if (ref.url === urls[0]) throw new RateLimitError(403, "x", null);
    await new Promise<void>((resolve) => release.push(resolve)); // resolves only when the test says so
    return snapshot(ref.url, [comment("c:1", minutes(1), "maintainer", "Hello")]);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const run = pollAll(ctx, { dryRun: true });
  await tick();
  expect(release).toHaveLength(3);
  for (const r of release) r();
  const [res] = await run;
  await tick();
  expect(res).toMatchObject({ ok: false, error: "rate limited on x" });
  for (const url of urls) expect(store.getItem(url)).toBeNull();
  expect(store.eventsFor(urls[1] as string, true)).toEqual([]);
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
