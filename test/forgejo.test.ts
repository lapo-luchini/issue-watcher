// Forgejo adapter against a fake API: responses are minimal, sanitized shapes of real Codeberg payloads.
import { expect, test } from "bun:test";
import { ForgejoAdapter } from "../src/adapters/forgejo.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError, RateLimitError } from "../src/core/http.ts";
import { expectAdapterContract } from "./contract.ts";
import { fakeApi, type Route } from "./fake-http.ts";

const API = "https://codeberg.org/api/v1";
const inst: InstanceConfig = { id: "codeberg", type: "forgejo", url: API, user: "lapo", emails: [], token: "dummy" };

function fake(routes: Record<string, Route>, extra: Partial<InstanceConfig> = {}) {
  const api = fakeApi(API, routes);
  return { ...api, adapter: new ForgejoAdapter({ ...inst, ...extra }, api.http) };
}

const PR = "https://codeberg.org/foo/bar/pulls/42";
const prRef = { url: PR, instance: "codeberg", kind: "pr" as const };
const user = (login: string) => ({ login });
/** A timeline entry with the fields every type carries. */
const ev = (id: number, type: string, login: string, extra: Record<string, unknown> = {}) =>
  ({ id, type, user: user(login), created_at: "2026-11-01T10:00:00+01:00", body: "", ...extra });

const prRoutes: Record<string, Route> = {
  "/repos/foo/bar/issues/42": {
    title: "Fix build on FreeBSD", state: "closed", user: user("Lapo"), labels: [{ name: "bug" }],
  },
  "/repos/foo/bar/issues/42/timeline": [
    ev(1, "comment", "writer", { body: "Please rebase onto main" }),
    ev(2, "comment", "rando", { body: "+1" }),
    ev(3, "comment", "rando", { body: "@lapo wrote in https://codeberg.org/foo/bar/pulls/42:\n> ...\nWhat about NetBSD?" }),
    ev(4, "comment", "lapo", { body: "cc @lapo" }), // my own mention of myself is no mention
    ev(5, "label", "rando", { body: "1", label: { name: "ready" } }),
    ev(6, "label", "writer", { body: "", label: { name: "wip" } }),
    ev(7, "milestone", "foo", { milestone: { title: "v2.0" } }),
    ev(8, "milestone", "foo", { milestone: null, old_milestone: { title: "v1.9" } }),
    ev(9, "assignees", "writer", { assignee: user("lapo"), removed_assignee: false }),
    ev(10, "assignees", "writer", { assignee: user("other"), removed_assignee: false }),
    ev(11, "assignees", "writer", { assignee: user("lapo"), removed_assignee: true }),
    ev(12, "review_request", "writer", { assignee: user("LAPO"), removed_assignee: false }),
    ev(13, "review_request", "writer", { assignee: user("other"), removed_assignee: false }),
    ev(14, "pull_push", "lapo", { body: '{"is_force_push":false,"commit_ids":["aaa","bbb"]}' }),
    ev(15, "pull_push", "writer", { body: '{"is_force_push":true,"commit_ids":["bbb","ccc"]}' }),
    ev(16, "close", "writer"),
    ev(17, "reopen", "lapo"),
    ev(18, "merge_pull", "writer"),
    ev(19, "review", "writer", { body: "LGTM" }), // reported via the reviews endpoint instead
    ev(20, "change_title", "lapo"),
    ev(21, "comment", "renovate-bot", { body: "Dependency dashboard updated" }),
  ],
  "/repos/foo/bar/pulls/42": { merged: true, mergeable: true, draft: false, head: { sha: "abc123" } },
  "/repos/foo/bar/pulls/42/reviews": [
    { id: 100, user: user("other"), state: "REQUEST_REVIEW", official: false, body: "", submitted_at: "2026-11-01T09:00:00Z" },
    { id: 101, user: user("reviewer"), state: "APPROVED", official: true, body: "Thanks @lapo!", submitted_at: "2026-11-01T12:00:00Z" },
    { id: 102, user: user("rando"), state: "REQUEST_CHANGES", official: false, body: "nit", submitted_at: "2026-11-01T12:30:00Z" },
    { id: 103, user: user("writer"), state: "COMMENT", official: false, body: "", submitted_at: "2026-11-01T12:40:00Z" },
    { id: 104, user: user("lapo"), state: "PENDING", official: false, body: "draft", submitted_at: "2026-11-01T12:50:00Z" },
  ],
  "/repos/foo/bar/commits/abc123/status": { state: "failure", total_count: 18 },
  "/repos/foo/bar/assignees": [user("Writer"), user("foo")],
};

test("refFromUrl accepts only this instance's PR/issue URLs", () => {
  const { adapter } = fake({});
  expect(adapter.refFromUrl(PR)).toEqual(prRef);
  expect(adapter.refFromUrl("https://codeberg.org/foo/bar/issues/7/")).toEqual(
    { url: "https://codeberg.org/foo/bar/issues/7", instance: "codeberg", kind: "issue" });
  expect(adapter.refFromUrl("https://github.com/foo/bar/pull/42")).toBeNull();
  expect(adapter.refFromUrl("https://codeberg.org/foo/bar/pull/42")).toBeNull(); // GitHub spelling
  expect(adapter.refFromUrl("https://codeberg.org/foo/bar")).toBeNull();
});

test("refFromUrl canonicalizes URLs copied from the browser", () => {
  const { adapter } = fake({});
  for (const u of [
    `${PR}/`, `${PR}/files`, `${PR}/commits/`, `${PR}/files?style=split`, `${PR}#issuecomment-123`,
    "https://Codeberg.org/foo/bar/pulls/42", `${PR}/files#diff-abc`,
  ]) {
    expect(adapter.refFromUrl(u)?.url).toBe(PR);
  }
  expect(adapter.refFromUrl(`${PR}/other`)).toBeNull();
  expect(adapter.refFromUrl("https://codeberg.org.evil.example/foo/bar/pulls/42")).toBeNull();
  expect(adapter.refFromUrl("not a url")).toBeNull();
});

test("refFromUrl and fetch handle a web UI under a path prefix", async () => {
  const api = fakeApi("https://example.org/git/api/v1", {
    "/repos/o/r/issues/3": { title: "T", state: "open", user: user("x"), labels: [] },
    "/repos/o/r/issues/3/timeline": [],
    "/repos/o/r/assignees": [],
  });
  const adapter = new ForgejoAdapter({ ...inst, url: "https://example.org/git/api/v1" }, api.http);
  const ref = adapter.refFromUrl("https://example.org/git/o/r/issues/3#top");
  expect(ref?.url).toBe("https://example.org/git/o/r/issues/3");
  expect(adapter.refFromUrl("https://example.org/o/r/issues/3")).toBeNull();
  expect((await adapter.fetch(ref!)).repo).toBe("o/r");
});

test("fetch normalizes a merged PR", async () => {
  const { adapter } = fake(prRoutes);
  const snap = await adapter.fetch(prRef);
  expect(snap).toMatchObject({
    repo: "foo/bar", title: "Fix build on FreeBSD", state: "merged", ciState: "failure",
    hasConflicts: false, authoredByMe: true, labels: ["bug"],
  });
  expect(snap.stateDetail).toBeUndefined();
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual([
    "a:9", "c:1", "c:2", "c:21", "c:3", "c:4", "l:5", "l:6", "m:3", "ms:7", "ms:8", "p:14", "p:15",
    "r:101", "r:102", "r:103", "rm:101", "rr:12", "s:16", "s:17", "s:18",
  ]);
  expect(byKey["c:1"]).toMatchObject({ kind: "comment", actor: "writer", actorRole: "maintainer", body: "Please rebase onto main" });
  expect(byKey["c:1"]?.at.toISOString()).toBe("2026-11-01T09:00:00.000Z");
  expect(byKey["c:2"]?.actorRole).toBe("contributor");
  expect(byKey["c:4"]?.actorRole).toBe("me");
  expect(byKey["c:21"]?.actorRole).toBe("bot");
  expect(byKey["m:3"]).toMatchObject({ kind: "mention", actor: "rando", actorRole: "contributor" });
  // Labels and milestones need write access, so even an unlisted human setting them is a maintainer.
  expect(byKey["l:5"]).toMatchObject({ kind: "label", actorRole: "maintainer", details: { action: "added", label: "ready" } });
  expect(byKey["l:6"]?.details).toEqual({ action: "removed", label: "wip" });
  expect(byKey["ms:7"]).toMatchObject({ kind: "milestone", actorRole: "maintainer", details: { action: "added", milestone: "v2.0" } });
  expect(byKey["ms:8"]?.details).toEqual({ action: "removed", milestone: "v1.9" });
  expect(byKey["a:9"]).toMatchObject({ kind: "assign", actor: "writer" });
  expect(byKey["rr:12"]).toMatchObject({ kind: "review_request", actor: "writer" });
  expect(byKey["p:14"]).toMatchObject({ kind: "push", actorRole: "me", details: { force: false, commits: 2 } });
  expect(byKey["p:15"]).toMatchObject({ kind: "push", actor: "writer", actorRole: "maintainer", details: { force: true } });
  expect(byKey["s:16"]?.details).toEqual({ to: "closed" });
  expect(byKey["s:17"]).toMatchObject({ actorRole: "me", details: { to: "reopened" } });
  expect(byKey["s:18"]).toMatchObject({ kind: "state", details: { to: "merged" } });
  // An official review needs write access, so its author is a maintainer even if not listed.
  expect(byKey["r:101"]).toMatchObject({ kind: "review", actorRole: "maintainer", body: "Thanks @lapo!", details: { state: "approved" } });
  expect(byKey["r:101"]?.at.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  expect(byKey["rm:101"]).toMatchObject({ kind: "mention", actor: "reviewer" });
  expect(byKey["r:102"]).toMatchObject({ actorRole: "contributor", details: { state: "changes_requested" } });
  expect(byKey["r:103"]?.details).toEqual({ state: "commented" });
});

test("the repo owner is a maintainer and the writers list is fetched once per repo", async () => {
  const { adapter, calls } = fake({
    ...prRoutes,
    "/repos/foo/bar/issues/42/timeline": [ev(1, "comment", "Foo", { body: "ok" })],
    "/repos/foo/bar/assignees": [],
  });
  expect((await adapter.fetch(prRef)).events[0]?.actorRole).toBe("maintainer");
  await adapter.fetch(prRef);
  expect(calls.filter((c) => c.endsWith("/assignees"))).toHaveLength(1);
});

test("without a readable writers list, other users are unknown rather than contributors", async () => {
  const forbidden = fake({ ...prRoutes, "/repos/foo/bar/assignees": 403 }); // token without repository scope
  const anonymous = fake(prRoutes, { token: undefined }); // the endpoint needs a token
  for (const { adapter } of [forbidden, anonymous]) {
    const byKey = Object.fromEntries((await adapter.fetch(prRef)).events.map((e) => [e.key, e]));
    expect(byKey["c:2"]?.actorRole).toBe("unknown");
    expect(byKey["c:1"]?.actorRole).toBe("unknown"); // "writer" is only known from the list
    expect(byKey["r:101"]?.actorRole).toBe("maintainer");
  }
  expect(anonymous.calls).not.toContain("/repos/foo/bar/assignees");
});

test("mergeable maps to hasConflicts; drafts are unknown", async () => {
  const cases = [
    [{ merged: false, mergeable: false, draft: false }, "open", "Fix", true],
    [{ merged: false, mergeable: true, draft: false }, "open", "Fix", false],
    [{ merged: false, mergeable: false, draft: true }, "open", "WIP: Fix", null], // drafts are never mergeable
    [{ merged: false, mergeable: false }, "open", "[WIP] Fix", null], // older Gitea: no draft field
    [{ merged: false, mergeable: false }, "closed", "Fix", false],
    [{ merged: true, mergeable: false, draft: false }, "closed", "Fix", false],
  ] as const;
  for (const [pr, state, title, expected] of cases) {
    const { adapter } = fake({
      ...prRoutes,
      "/repos/foo/bar/issues/42": { title, state, user: user("lapo"), labels: [] },
      "/repos/foo/bar/pulls/42": { ...pr, head: { sha: "abc123" } },
    });
    expect((await adapter.fetch(prRef)).hasConflicts).toBe(expected);
  }
});

test("the combined commit status maps to a CI state", async () => {
  const cases = [
    [{ state: "success", total_count: 3 }, "success"],
    [{ state: "warning", total_count: 1 }, "success"],
    [{ state: "skipped", total_count: 1 }, "success"],
    [{ state: "pending", total_count: 2 }, "pending"],
    [{ state: "error", total_count: 1 }, "failure"],
    [{ state: "failure", total_count: 1 }, "failure"],
    [{ state: "", total_count: 0 }, null], // what Forgejo returns for a commit without statuses
    [403, null],
    [404, null],
  ] as const;
  for (const [status, expected] of cases) {
    const { adapter } = fake({ ...prRoutes, "/repos/foo/bar/commits/abc123/status": status });
    expect((await adapter.fetch(prRef)).ciState).toBe(expected);
  }
});

test("a rate limit on CI still stops the fetch", async () => {
  const { adapter } = fake({
    ...prRoutes,
    "/repos/foo/bar/commits/abc123/status": new Response("", { status: 429, headers: { "retry-after": "60" } }),
  });
  expect(await adapter.fetch(prRef).catch((e) => e)).toBeInstanceOf(RateLimitError);
});

test("fetch normalizes an issue and skips PR-only calls", async () => {
  const { adapter, calls } = fake({
    "/repos/foo/bar/issues/7": { title: "Crash", state: "open", user: user("x"), labels: [{ name: "a" }] },
    "/repos/foo/bar/issues/7/timeline": [ev(1, "comment", "x", { body: "Still crashing on 1.2" })],
    "/repos/foo/bar/assignees": [],
  });
  const snap = await adapter.fetch({ url: "https://codeberg.org/foo/bar/issues/7", instance: "codeberg", kind: "issue" });
  expect(snap).toMatchObject({ state: "open", ciState: null, hasConflicts: false, authoredByMe: false, labels: ["a"] });
  expect(snap.events.map((e) => [e.key, e.actorRole])).toEqual([["c:1", "contributor"]]);
  expect(calls).toEqual(["/repos/foo/bar/issues/7", "/repos/foo/bar/issues/7/timeline", "/repos/foo/bar/assignees"]);
});

test("only a 404 on the item itself means gone; a 404 on a sub-request is a plain error", async () => {
  const gone = await fake({ "/repos/foo/bar/issues/42": 404 }).adapter.fetch(prRef).catch((e) => e);
  expect(gone).toBeInstanceOf(GoneError);
  for (const path of ["/repos/foo/bar/issues/42/timeline", "/repos/foo/bar/pulls/42", "/repos/foo/bar/pulls/42/reviews"]) {
    const err = await fake({ ...prRoutes, [path]: 404 }).adapter.fetch(prRef).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(GoneError);
    expect(err.status).toBe(404);
  }
});

test("requests send the token and JSON headers", async () => {
  const { adapter, headers } = fake(prRoutes);
  await adapter.fetch(prRef);
  for (const h of headers) {
    expect(h).toMatchObject({ authorization: "token dummy", accept: "application/json", "user-agent": "watcher" });
  }
  const anon = fake(prRoutes, { token: undefined });
  await anon.adapter.fetch(prRef);
  expect(anon.headers.every((h) => !("authorization" in h))).toBe(true);
});

/** The search path discover() requests for one involvement flag. */
const search = (flag: string, when: string) => `/repos/issues/search?${flag}=true&${when}&limit=50`;
const FLAGS = ["created", "assigned", "mentioned", "review_requested", "reviewed"];
const noSearchHits = (when: string) => Object.fromEntries(FLAGS.map((f) => [search(f, when), []]));

test("discover: first run searches open items and adds open notified items", async () => {
  const { adapter, calls } = fake({
    ...noSearchHits("state=open"),
    [search("created", "state=open")]: [{ html_url: PR }, { html_url: "https://codeberg.org/x/y/issues/1" }],
    [search("review_requested", "state=open")]: [{ html_url: "https://codeberg.org/r/q/pulls/5" }],
    [search("reviewed", "state=open")]: [{ html_url: PR }],
    "/notifications?all=true&limit=50": [
      { subject: { type: "Issue", state: "open", html_url: "https://codeberg.org/k/l/issues/9" } },
      { subject: { type: "Pull", state: "closed", html_url: "https://codeberg.org/k/l/pulls/10" } },
    ],
  });
  const refs = await adapter.discover(null);
  expect(refs.map((r) => r.url)).toEqual([
    PR, "https://codeberg.org/x/y/issues/1", "https://codeberg.org/r/q/pulls/5", "https://codeberg.org/k/l/issues/9",
  ]);
  expect(refs.map((r) => r.kind)).toEqual(["pr", "issue", "pr", "issue"]);
  expect(calls).toHaveLength(6);
});

test("discover: incremental run asks for all states since the cursor, plus notifications", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = `state=all&since=${encodeURIComponent(since.toISOString())}`;
  const { adapter } = fake({
    ...noSearchHits(when),
    [search("mentioned", when)]: [{ html_url: PR }],
    [search("assigned", when)]: [{ html_url: PR }],
    [`/notifications?all=true&since=${encodeURIComponent(since.toISOString())}&limit=50`]: [
      { subject: { type: "Issue", state: "closed", html_url: "https://codeberg.org/k/l/issues/9" } }, // closed is a change too
      { subject: { type: "Pull", state: "open", html_url: "https://codeberg.org/k/l/pulls/10" } },
      { subject: { type: "Commit", html_url: "https://codeberg.org/k/l/commit/abc" } },
      { subject: { type: "Pull", state: "open", html_url: PR } },
    ],
  });
  const refs = await adapter.discover(since);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://codeberg.org/k/l/issues/9", "https://codeberg.org/k/l/pulls/10"]);
});

test("discover: without notifications, known items are checked per repo instead", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const iso = encodeURIComponent(since.toISOString());
  const when = `state=all&since=${iso}`;
  const known = [
    prRef, // also found by a search: not checked again
    { url: "https://codeberg.org/foo/bar/issues/7", instance: "codeberg", kind: "issue" as const },
    { url: "https://codeberg.org/foo/bar/issues/8", instance: "codeberg", kind: "issue" as const },
    { url: "https://codeberg.org/gone/repo/issues/1", instance: "codeberg", kind: "issue" as const },
  ];
  const { adapter, calls } = fake({
    ...noSearchHits(when),
    [search("created", when)]: [{ html_url: PR }],
    [`/notifications?all=true&since=${iso}&limit=50`]: 403,
    [`/repos/foo/bar/issues?state=all&since=${iso}&limit=50`]: [
      { html_url: "https://codeberg.org/foo/bar/issues/7" }, // known and updated
      { html_url: "https://codeberg.org/foo/bar/pulls/99" }, // updated, but not mine
    ],
    [`/repos/gone/repo/issues?state=all&since=${iso}&limit=50`]: 404,
  });
  expect((await adapter.discover(since, known)).map((r) => r.url)).toEqual([PR, "https://codeberg.org/foo/bar/issues/7"]);
  expect(calls.filter((c) => c.includes("/issues?state=all"))).toHaveLength(2); // one per repo
});

test("discover: unreadable notifications are skipped, a rate limit is not", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const when = `state=all&since=${encodeURIComponent(since.toISOString())}`;
  const notes = `/notifications?all=true&since=${encodeURIComponent(since.toISOString())}&limit=50`;
  for (const status of [401, 403]) {
    const { adapter } = fake({ ...noSearchHits(when), [search("created", when)]: [{ html_url: PR }], [notes]: status });
    expect((await adapter.discover(since)).map((r) => r.url)).toEqual([PR]);
  }
  const { adapter } = fake({ ...noSearchHits(when), [notes]: new Response("", { status: 429 }) });
  expect(await adapter.discover(since).catch((e) => e)).toBeInstanceOf(RateLimitError);
});

test("adapter contract", async () => {
  await expectAdapterContract(fake(prRoutes).adapter, prRef);
});

test("a bot's @-mention is only a comment", async () => {
  const { adapter } = fake({
    ...prRoutes,
    "/repos/foo/bar/issues/42/timeline": [ev(1, "comment", "ci-bot", { body: "@lapo the build failed" })],
  });
  const snap = await adapter.fetch(prRef);
  expect(snap.events.filter((e) => e.key === "c:1" || e.key === "m:1").map((e) => e.key)).toEqual(["c:1"]);
});

test("discover: refuses to run without a token", async () => {
  // Anonymous searches ignore the "…by the authenticated user" flags and return everyone's items.
  const { adapter, calls } = fake({}, { token: undefined });
  await expect(adapter.discover(null)).rejects.toThrow("Forgejo discovery needs a token");
  expect(calls).toEqual([]);
});
