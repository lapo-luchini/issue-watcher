// GitLab adapter against a fake API: responses are minimal, sanitized shapes of real GitLab payloads
// (invent.kde.org and gitlab.com; system-note texts as GitLab writes them).
import { expect, test } from "bun:test";
import { GitLabAdapter } from "../src/adapters/gitlab.ts";
import type { InstanceConfig } from "../src/core/config.ts";
import { GoneError, HttpError } from "../src/core/http.ts";
import type { ItemRef } from "../src/core/model.ts";
import { expectAdapterContract } from "./contract.ts";
import { fakeApi } from "./fake-http.ts";

const API = "https://gitlab.example.org/api/v4";
const WEB = "https://gitlab.example.org";
const inst: InstanceConfig = { id: "gl", type: "gitlab", url: API, user: "lapo", emails: [], token: "dummy" };
const NOW = new Date("2026-11-04T12:00:00.000Z");

function fakeGitLab(routes: Record<string, unknown>, extra: Partial<InstanceConfig> = {}) {
  const api = fakeApi(API, routes);
  return { ...api, adapter: new GitLabAdapter({ ...inst, ...extra }, api.http, () => NOW) };
}

const MR = `${WEB}/kde/apps/konsole/-/merge_requests/42`;
const MR_REF: ItemRef = { url: MR, instance: "gl", kind: "pr" };
const P = "/projects/kde%2Fapps%2Fkonsole";
const MRB = `${P}/merge_requests/42`;

const user = (id: number, username: string, bot = false) => ({ id, username, bot });
const LAPO = user(1, "Lapo");
const MAINT = user(2, "maint");
const RANDO = user(3, "rando");
const TOKEN_BOT = user(4, "project_318_bot_0123456789abcdef", true);

const mrRoutes: Record<string, unknown> = {
  [MRB]: {
    title: "Fix build on FreeBSD", state: "opened", draft: true, author: LAPO, labels: ["bug"],
    detailed_merge_status: "mergeable", has_conflicts: false, head_pipeline: { status: "failed" },
  },
  [`${MRB}/notes?sort=asc&per_page=100`]: [
    { id: 10, system: true, author: MAINT, created_at: "2026-11-01T09:00:00.000Z", body: "assigned to @lapo and @maint" },
    { id: 11, system: true, author: MAINT, created_at: "2026-11-01T09:01:00.000Z", body: "requested review from @Lapo" },
    { id: 12, system: false, author: MAINT, created_at: "2026-11-01T10:00:00.000Z", body: "Please rebase, @lapo" },
    { id: 13, system: false, author: RANDO, created_at: "2026-11-01T11:00:00.000Z", body: "+1" },
    { id: 14, system: false, author: LAPO, created_at: "2026-11-01T11:30:00.000Z", body: "Done, thanks @lapo-bot" },
    { id: 15, system: true, author: LAPO, created_at: "2026-11-01T11:31:00.000Z",
      body: "added 3 commits\n\n<ul><li>ebbe7a70...cd8963d7 - 2 commits from branch <code>master</code></li>" +
        "<li>c1fb19bf - Fix &quot;dark&quot; scrollbars &amp; more</li></ul>\n\n[Compare with previous version](/kde/apps/konsole/-/merge_requests/42/diffs?diff_id=1)" },
    { id: 16, system: true, author: MAINT, created_at: "2026-11-01T12:00:00.000Z", body: "approved this merge request" },
    { id: 17, system: true, author: RANDO, created_at: "2026-11-01T12:10:00.000Z", body: "requested changes" },
    { id: 18, system: true, author: MAINT, created_at: "2026-11-01T12:20:00.000Z", body: "changed the description" },
    { id: 19, system: true, author: MAINT, created_at: "2026-11-01T12:30:00.000Z", body: "mentioned in merge request !7353" },
    { id: 20, system: false, author: TOKEN_BOT, created_at: "2026-11-01T12:40:00.000Z", body: "Pipeline report for @lapo" },
  ],
  [`${MRB}/resource_state_events?per_page=100`]: [
    { id: 30, user: MAINT, created_at: "2026-11-01T13:00:00.000Z", state: "closed" },
    { id: 31, user: MAINT, created_at: "2026-11-01T13:05:00.000Z", state: "reopened" },
  ],
  [`${MRB}/resource_label_events?per_page=100`]: [
    { id: 40, user: RANDO, created_at: "2026-11-01T14:00:00.000Z", action: "add", label: { name: "ready" } },
    { id: 41, user: user(5, "gitlab-bot"), created_at: "2026-11-01T14:01:00.000Z", action: "remove", label: { name: "triage" } },
  ],
  [`${MRB}/resource_milestone_events?per_page=100`]: [
    { id: 50, user: MAINT, created_at: "2026-11-01T15:00:00.000Z", action: "add", milestone: { title: "6.9" } },
  ],
  [`${P}/members/all/2`]: { id: 2, username: "maint", access_level: 40 },
  [`${P}/members/all/3`]: 404, // not a member
};

test("refFromUrl accepts this instance's MR, issue and work item URLs, with nested groups", () => {
  const { adapter } = fakeGitLab({});
  expect(adapter.refFromUrl(MR)).toEqual(MR_REF);
  expect(adapter.refFromUrl(`${WEB}/foo/bar/-/issues/7`)).toEqual({ url: `${WEB}/foo/bar/-/issues/7`, instance: "gl", kind: "issue" });
  // Newer GitLab links issues as work items; both URLs open the same page, so they share one key.
  expect(adapter.refFromUrl(`${WEB}/foo/bar/-/work_items/7`)?.url).toBe(`${WEB}/foo/bar/-/issues/7`);
  expect(adapter.refFromUrl(`${WEB}/a/b/c/d/-/merge_requests/1`)?.url).toBe(`${WEB}/a/b/c/d/-/merge_requests/1`);
});

test("refFromUrl canonicalizes URLs copied from the browser", () => {
  const { adapter } = fakeGitLab({});
  for (const u of [
    `${MR}/`, `${MR}/diffs`, `${MR}/commits/`, `${MR}/pipelines`, `${MR}?tab=x`, `${MR}#note_123`,
    `${MR}/diffs#abc_1_2`, "https://GitLab.Example.org/kde/apps/konsole/-/merge_requests/42",
  ]) {
    expect(adapter.refFromUrl(u)?.url).toBe(MR);
  }
});

test("refFromUrl rejects other hosts, other paths and non-URLs", () => {
  const { adapter } = fakeGitLab({});
  for (const u of [
    "https://gitlab.com/foo/bar/-/merge_requests/1", "https://gitlab.example.org.evil.example/foo/bar/-/issues/1",
    `${WEB}/foo/bar`, `${WEB}/foo/bar/-/merge_requests`, `${WEB}/foo/bar/-/merge_requests/1/other`,
    `${WEB}/foo/bar/-/epics/1`, `${WEB}/bar/-/issues/1`, `${WEB}/foo/-/bar/-/issues/1`,
    `${WEB}/groups/foo/-/work_items/7`, // a group-level work item (epic), not a project's
    "https://github.com/foo/bar/pull/1", "not a url",
  ]) {
    expect(adapter.refFromUrl(u)).toBeNull();
  }
});

test("refFromUrl on a sub-path install requires the prefix", () => {
  const { adapter } = fakeGitLab({}, { url: "https://example.org/gitlab/api/v4" });
  expect(adapter.refFromUrl("https://example.org/gitlab/foo/bar/-/issues/3?x")?.url).toBe("https://example.org/gitlab/foo/bar/-/issues/3");
  expect(adapter.refFromUrl("https://example.org/foo/bar/-/issues/3")).toBeNull();
  expect(adapter.refFromUrl("https://example.org/gitlabx/foo/bar/-/issues/3")).toBeNull();
});

test("fetch normalizes an MR: comments, system notes, resource events, roles", async () => {
  const { adapter, calls } = fakeGitLab(mrRoutes);
  const snap = await adapter.fetch(MR_REF);
  expect(snap).toMatchObject({
    ref: MR_REF, repo: "kde/apps/konsole", title: "Fix build on FreeBSD", state: "open", stateDetail: "draft",
    ciState: "failure", hasConflicts: false, authoredByMe: true, labels: ["bug"],
  });
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual([
    "a:10", "c:12", "c:13", "c:14", "c:20", "l:40", "l:41", "m:12", "ms:50", "push:15", "r:16", "r:17", "rr:11", "s:30", "s:31",
  ]);
  expect(byKey["c:12"]).toMatchObject({ kind: "comment", actor: "maint", actorRole: "maintainer", body: "Please rebase, @lapo" });
  expect(byKey["c:12"]?.at.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  expect(byKey["m:12"]).toMatchObject({ kind: "mention", actor: "maint", actorRole: "maintainer" });
  expect(byKey["c:13"]?.actorRole).toBe("contributor");
  expect(byKey["c:14"]?.actorRole).toBe("me"); // "@lapo-bot" is not me, and my own notes never mention me
  expect(byKey["c:20"]?.actorRole).toBe("bot"); // project access token: its mention of me is not a person's
  expect(byKey["a:10"]).toMatchObject({ kind: "assign", actor: "maint" });
  expect(byKey["rr:11"]).toMatchObject({ kind: "review_request", actor: "maint" });
  expect(byKey["push:15"]).toMatchObject({ kind: "push", actor: "Lapo", actorRole: "me",
    details: { commits: 3, sha: "c1fb19bf", message: 'Fix "dark" scrollbars & more' } });
  expect(byKey["r:16"]).toMatchObject({ kind: "review", actorRole: "maintainer", details: { state: "approved" } });
  expect(byKey["r:17"]).toMatchObject({ kind: "review", actorRole: "contributor", details: { state: "changes_requested" } });
  expect(byKey["s:30"]).toMatchObject({ kind: "state", details: { to: "closed" } });
  expect(byKey["s:31"]).toMatchObject({ kind: "state", details: { to: "reopened" } });
  // Only Reporter+ can label: a non-member human doing it was a maintainer when it happened; bots stay bots.
  expect(byKey["l:40"]).toMatchObject({ kind: "label", actorRole: "maintainer", details: { action: "added", label: "ready" } });
  expect(byKey["l:41"]).toMatchObject({ actorRole: "bot", details: { action: "removed", label: "triage" } });
  expect(byKey["ms:50"]).toMatchObject({ kind: "milestone", actorRole: "maintainer", details: { action: "added", milestone: "6.9" } });
  // One member lookup per distinct human other than me, even though maint and rando act several times.
  expect(calls.filter((c) => c.includes("/members/"))).toEqual([`${P}/members/all/2`, `${P}/members/all/3`]);
});

test("member lookups are cached across fetches of the same project", async () => {
  const { adapter, calls } = fakeGitLab(mrRoutes);
  await adapter.fetch(MR_REF);
  await adapter.fetch(MR_REF);
  expect(calls.filter((c) => c.includes("/members/"))).toHaveLength(2);
});

test("a Reporter is not a maintainer", async () => {
  const { adapter } = fakeGitLab({ ...mrRoutes, [`${P}/members/all/2`]: { id: 2, username: "maint", access_level: 20 } });
  const snap = await adapter.fetch(MR_REF);
  expect(snap.events.find((e) => e.key === "c:12")?.actorRole).toBe("contributor");
});

test("assignment and review-request notes count only when they name me", async () => {
  const note = (id: number, body: string) => ({ id, system: true, author: MAINT, created_at: "2026-11-01T09:00:00.000Z", body });
  const { adapter } = fakeGitLab({
    ...mrRoutes,
    [`${MRB}/notes?sort=asc&per_page=100`]: [
      note(1, "assigned to @maint"),
      note(2, "assigned to @maint and unassigned @lapo"),
      note(3, "reassigned to @lapo"),
      note(4, "unassigned @lapo"),
      note(5, "requested review from @maint and removed review request for @lapo"),
      note(6, "requested review from @maint and @lapo"),
      note(7, "removed review request for @lapo"),
      note(8, "requested review from @lapo.luchini2"),
    ],
  });
  const keys = (await adapter.fetch(MR_REF)).events.filter((e) => e.key.startsWith("a:") || e.key.startsWith("rr:")).map((e) => e.key);
  expect(keys).toEqual(["a:3", "rr:6"]);
});

test("a push of only target-branch commits has no message", async () => {
  const { adapter } = fakeGitLab({
    ...mrRoutes,
    [`${MRB}/notes?sort=asc&per_page=100`]: [{ id: 1, system: true, author: MAINT, created_at: "2026-11-01T09:00:00.000Z",
      body: "added 7 commits\n\n<ul><li>a0000d8b...965334ce - 7 commits from branch <code>main</code></li></ul>" }],
  });
  const push = (await adapter.fetch(MR_REF)).events[0];
  expect(push).toMatchObject({ key: "push:1", kind: "push", actor: "maint", actorRole: "maintainer", details: { commits: 7 } });
  expect(push?.details?.message).toBeUndefined();
});

test("head pipeline status maps to CI state", async () => {
  const cases: [unknown, string | null][] = [
    [{ status: "success" }, "success"], [{ status: "failed" }, "failure"], [{ status: "canceled" }, "failure"],
    [{ status: "running" }, "pending"], [{ status: "manual" }, "pending"], [{ status: "waiting_for_resource" }, "pending"],
    [{ status: "skipped" }, null], [null, null], [undefined, null],
  ];
  for (const [pipeline, expected] of cases) {
    const { adapter } = fakeGitLab({ ...mrRoutes, [MRB]: { ...(mrRoutes[MRB] as object), head_pipeline: pipeline } });
    expect((await adapter.fetch(MR_REF)).ciState).toBe(expected as never);
  }
});

test("conflicts are unknown while GitLab is still checking mergeability", async () => {
  const cases: [string | undefined, boolean, boolean | null][] = [
    ["conflict", true, true], ["mergeable", false, false], ["need_rebase", false, false], ["not_open", false, false],
    ["checking", true, null], ["unchecked", false, null], ["preparing", false, null], ["approvals_syncing", false, null],
    [undefined, false, null],
  ];
  for (const [status, conflicts, expected] of cases) {
    const { adapter } = fakeGitLab({
      ...mrRoutes, [MRB]: { ...(mrRoutes[MRB] as object), detailed_merge_status: status, has_conflicts: conflicts },
    });
    expect((await adapter.fetch(MR_REF)).hasConflicts).toBe(expected);
  }
});

test("merged and locked MR states", async () => {
  for (const [glState, state, detail] of [["merged", "merged", undefined], ["locked", "open", "locked"], ["closed", "closed", undefined]]) {
    const { adapter } = fakeGitLab({ ...mrRoutes, [MRB]: { ...(mrRoutes[MRB] as object), state: glState } });
    expect(await adapter.fetch(MR_REF)).toMatchObject({ state, stateDetail: detail });
  }
});

test("fetch normalizes an issue", async () => {
  const I = `${P}/issues/7`;
  const { adapter } = fakeGitLab({
    [I]: { title: "Crash on start", state: "closed", author: RANDO, labels: ["crash"] },
    [`${I}/notes?sort=asc&per_page=100`]: [
      { id: 1, system: false, author: LAPO, created_at: "2026-11-01T09:00:00.000Z", body: "Backtrace attached" },
      { id: 2, system: true, author: MAINT, created_at: "2026-11-01T10:00:00.000Z", body: "closed" },
    ],
    [`${I}/resource_state_events?per_page=100`]: [{ id: 3, user: MAINT, created_at: "2026-11-01T10:00:00.000Z", state: "closed" }],
    [`${I}/resource_label_events?per_page=100`]: [],
    [`${I}/resource_milestone_events?per_page=100`]: [],
    [`${P}/members/all/2`]: { access_level: 50 },
  });
  const ref: ItemRef = { url: `${WEB}/kde/apps/konsole/-/issues/7`, instance: "gl", kind: "issue" };
  const snap = await adapter.fetch(ref);
  expect(snap).toMatchObject({
    repo: "kde/apps/konsole", title: "Crash on start", state: "closed", stateDetail: undefined,
    ciState: null, hasConflicts: false, authoredByMe: false, labels: ["crash"],
  });
  expect(snap.events.map((e) => [e.key, e.kind, e.actorRole])).toEqual([
    ["c:1", "comment", "me"], ["s:3", "state", "maintainer"],
  ]);
});

test("only a 404 on the item itself means gone; a 404 on a sub-request is a plain error", async () => {
  expect(await fakeGitLab({ [MRB]: 404 }).adapter.fetch(MR_REF).catch((e) => e)).toBeInstanceOf(GoneError);
  for (const sub of ["notes?sort=asc&per_page=100", "resource_state_events?per_page=100",
    "resource_label_events?per_page=100", "resource_milestone_events?per_page=100"]) {
    const err = await fakeGitLab({ ...mrRoutes, [`${MRB}/${sub}`]: 404 }).adapter.fetch(MR_REF).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(GoneError);
    expect(err.status).toBe(404);
  }
});

test("sends the token as PRIVATE-TOKEN, and nothing without one", async () => {
  const { adapter, headers } = fakeGitLab(mrRoutes);
  await adapter.fetch(MR_REF);
  expect(headers[0]).toEqual({ "user-agent": "watcher", "private-token": "dummy" });
  const anon = fakeGitLab(mrRoutes, { token: undefined });
  await anon.adapter.fetch(MR_REF);
  expect(anon.headers[0]).toEqual({ "user-agent": "watcher" });
});

/** The role-filter searches discover() issues, in order, for one `when` clause. */
const searches = (when: string) => [
  `/merge_requests?scope=all&author_username=lapo&${when}&per_page=100`,
  `/merge_requests?scope=all&assignee_username=lapo&${when}&per_page=100`,
  `/merge_requests?scope=all&reviewer_username=lapo&${when}&per_page=100`,
  `/issues?scope=all&author_username=lapo&${when}&per_page=100`,
  `/issues?scope=all&assignee_username=lapo&${when}&per_page=100`,
];

test("discover: first run finds open items by role, pending to-dos and items I commented on", async () => {
  const [mrAuthor, mrAssignee, mrReviewer, issueAuthor, issueAssignee] = searches("state=opened");
  const { adapter, calls } = fakeGitLab({
    [mrAuthor!]: [{ web_url: MR }],
    [mrAssignee!]: [{ web_url: MR }],
    [mrReviewer!]: [{ web_url: `${WEB}/r/q/-/merge_requests/5` }],
    [issueAuthor!]: [{ web_url: `${WEB}/x/y/-/work_items/1` }],
    [issueAssignee!]: [],
    "/todos?state=pending&per_page=100": [
      { target_url: `${WEB}/t/u/-/issues/2#note_9`, created_at: "2020-01-01T00:00:00.000Z" }, // first run: any age
      { target_url: `${WEB}/t/u/-/commit/abc123`, created_at: "2026-11-01T00:00:00.000Z" },
      { target_url: null, created_at: "2026-11-01T00:00:00.000Z" },
    ],
    // 90 days before NOW, as a date.
    "/events?action=commented&after=2026-08-06&per_page=100": [
      { project_id: 318, note: { noteable_type: "MergeRequest", noteable_iid: 1352 } },
      { project_id: 318, note: { noteable_type: "Issue", noteable_iid: 1 } },
      { project_id: 318, note: { noteable_type: "Commit", noteable_iid: null } },
      { project_id: 999, note: { noteable_type: "Issue", noteable_iid: 4 } }, // project since deleted
    ],
    "/projects/318": { id: 318, path_with_namespace: "utilities/konsole" },
    "/projects/999": 404,
  });
  const refs = await adapter.discover(null, []);
  expect(refs.map((r) => [r.url, r.kind])).toEqual([
    [MR, "pr"],
    [`${WEB}/r/q/-/merge_requests/5`, "pr"],
    [`${WEB}/x/y/-/issues/1`, "issue"],
    [`${WEB}/t/u/-/issues/2`, "issue"],
    [`${WEB}/utilities/konsole/-/merge_requests/1352`, "pr"],
    [`${WEB}/utilities/konsole/-/issues/1`, "issue"],
  ]);
  expect(calls.filter((c) => c.startsWith("/projects/"))).toEqual(["/projects/318", "/projects/999"]); // cached per id
});

test("discover: incremental run uses the cursor, recent to-dos of both states, and checks known items", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const after = `updated_after=${encodeURIComponent("2026-11-04T10:00:00.000Z")}`;
  const routes: Record<string, unknown> = Object.fromEntries(searches(after).map((s) => [s, []]));
  routes[searches(after)[0]!] = [{ web_url: MR }];
  routes["/todos?state=pending&per_page=100"] = [
    { target_url: `${WEB}/t/u/-/merge_requests/3`, created_at: "2026-11-04T10:30:00.000Z" },
    { target_url: `${WEB}/t/u/-/merge_requests/4`, created_at: "2026-11-01T10:30:00.000Z" }, // older than the cursor
  ];
  routes["/todos?state=done&per_page=100"] = [
    { target_url: `${WEB}/t/u/-/issues/5`, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-11-04T11:00:00.000Z" },
  ];
  routes["/events?action=commented&after=2026-11-02&per_page=100"] = []; // two days before the cursor
  // 55 known MRs in one project: two batches. MR 42 is known too, but the author search
  // already found it, so it is not checked again. One known issue in a project that is gone now.
  const known: ItemRef[] = [MR_REF];
  for (let i = 101; i <= 155; i++) known.push({ url: `${WEB}/kde/apps/konsole/-/merge_requests/${i}`, instance: "gl", kind: "pr" });
  known.push({ url: `${WEB}/gone/proj/-/issues/1`, instance: "gl", kind: "issue" });
  // Cached before the instance's url was edited: skipped, not fatal.
  known.push({ url: "https://old.example.org/x/y/-/issues/2", instance: "gl", kind: "issue" });
  const iids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `iids[]=${from + i}`).join("&");
  routes[`${P}/merge_requests?${iids(101, 150)}&${after}&per_page=100`] = [{ web_url: `${WEB}/kde/apps/konsole/-/merge_requests/107` }];
  routes[`${P}/merge_requests?${iids(151, 155)}&${after}&per_page=100`] = [];
  routes[`/projects/gone%2Fproj/issues?iids[]=1&${after}&per_page=100`] = 404; // the project is gone
  const { adapter, calls } = fakeGitLab(routes);

  const refs = await adapter.discover(since, known);
  expect(refs.map((r) => r.url)).toEqual([
    MR, `${WEB}/t/u/-/merge_requests/3`, `${WEB}/t/u/-/issues/5`, `${WEB}/kde/apps/konsole/-/merge_requests/107`,
  ]);
  expect(calls.some((c) => c.includes("iids[]=42&"))).toBe(false);
  expect(calls).toContain(`/projects/gone%2Fproj/issues?iids[]=1&${after}&per_page=100`);
});

test("adapter contract", async () => {
  await expectAdapterContract(fakeGitLab(mrRoutes).adapter, MR_REF);
});

test("discover: refuses to run without a token", async () => {
  const { adapter, calls } = fakeGitLab({}, { token: undefined });
  await expect(adapter.discover(null, [])).rejects.toThrow("GitLab discovery needs a token");
  expect(calls).toEqual([]);
});

test("discover: known items are not checked on the first run", async () => {
  const { adapter, calls } = fakeGitLab({
    ...Object.fromEntries(searches("state=opened").map((s) => [s, []])),
    "/todos?state=pending&per_page=100": [],
    "/events?action=commented&after=2026-08-06&per_page=100": [],
  });
  expect(await adapter.discover(null, [MR_REF])).toEqual([]);
  expect(calls.some((c) => c.includes("iids"))).toBe(false);
});
