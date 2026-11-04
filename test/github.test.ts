// GitHub adapter against a fake API: responses are minimal, sanitized shapes of real GitHub payloads.
import { expect, test } from "bun:test";
import { GitHubAdapter } from "../src/adapters/github.ts";
import type { HttpDeps } from "../src/core/http.ts";

const API = "https://api.github.com";
const inst = { id: "github", type: "github" as const, url: API, user: "lapo", token: "t" };

/** Fake GitHub: maps "path?query" (without the API base) to a JSON body or a status code. */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const http: HttpDeps = {
    fetchFn: async (url) => {
      const path = url.slice(API.length);
      calls.push(path);
      const body = routes[path];
      if (body === undefined) return new Response(`no route for ${path}`, { status: 404 });
      if (typeof body === "number") return new Response("", { status: body });
      return Response.json(body);
    },
    sleep: async () => {},
    retries: 0,
    timeoutMs: 1000,
  };
  return { adapter: new GitHubAdapter(inst, http), calls };
}

const PR = "https://github.com/foo/bar/pull/42";

const prRoutes = {
  "/repos/foo/bar/issues/42": {
    title: "Fix build on FreeBSD", state: "closed", state_reason: null,
    user: { login: "Lapo" }, labels: [{ name: "bug" }],
  },
  "/repos/foo/bar/issues/42/timeline?per_page=100": [
    { event: "commented", id: 1, actor: { login: "maint" }, user: { login: "maint" }, author_association: "MEMBER",
      created_at: "2026-11-01T10:00:00Z", body: "Please rebase" },
    { event: "commented", id: 2, actor: { login: "rando" }, user: { login: "rando" }, author_association: "NONE",
      created_at: "2026-11-01T11:00:00Z", body: "+1" },
    { event: "reviewed", id: 3, user: { login: "maint" }, author_association: "MEMBER",
      submitted_at: "2026-11-01T12:00:00Z", state: "approved", body: "" },
    { event: "reviewed", id: 4, user: { login: "lapo" }, state: "pending", submitted_at: "2026-11-01T12:30:00Z" },
    { event: "labeled", id: 5, actor: { login: "triager" }, created_at: "2026-11-01T13:00:00Z", label: { name: "ready" } },
    { event: "mentioned", id: 6, actor: { login: "lapo" }, created_at: "2026-11-01T13:30:00Z" },
    { event: "mentioned", id: 7, actor: { login: "someone-else" }, created_at: "2026-11-01T13:30:00Z" },
    { event: "merged", id: 8, actor: { login: "maint" }, created_at: "2026-11-01T14:00:00Z" },
    { event: "cross-referenced", created_at: "2026-11-01T14:10:00Z" },
  ],
  "/repos/foo/bar/pulls/42": { merged: true, mergeable_state: "clean", head: { sha: "abc123" } },
  "/repos/foo/bar/pulls/42/commits?per_page=100": [
    { sha: "abc123def4567890", author: { login: "lapo" },
      commit: { message: "Fix build\n\nlong text", author: { name: "Lapo", date: "2026-10-30T09:00:00Z" }, committer: { date: "2026-10-30T09:00:00Z" } } },
  ],
  "/repos/foo/bar/commits/abc123/check-runs?per_page=100": {
    check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }],
  },
  "/repos/foo/bar/commits/abc123/status": { state: "success", total_count: 1 },
};

test("refFromUrl accepts only this instance's PR/issue URLs", () => {
  const { adapter } = fakeGitHub({});
  expect(adapter.refFromUrl(PR)).toEqual({ url: PR, instance: "github", kind: "pr" });
  expect(adapter.refFromUrl("https://github.com/foo/bar/issues/7/")?.kind).toBe("issue");
  expect(adapter.refFromUrl("https://gitlab.com/foo/bar/-/issues/7")).toBeNull();
  expect(adapter.refFromUrl("https://github.com/foo/bar")).toBeNull();
});

test("fetch normalizes a merged PR", async () => {
  const { adapter } = fakeGitHub(prRoutes);
  const snap = await adapter.fetch({ url: PR, instance: "github", kind: "pr" });
  expect(snap).toMatchObject({
    repo: "foo/bar", title: "Fix build on FreeBSD", state: "merged", ciState: "failure",
    hasConflicts: false, authoredByMe: true, labels: ["bug"],
  });
  const byKey = Object.fromEntries(snap.events.map((e) => [e.key, e]));
  expect(Object.keys(byKey).sort()).toEqual(["c:1", "c:2", "commit:abc123def4567890", "l:5", "m:6", "r:3", "s:8"]);
  expect(byKey["c:1"]).toMatchObject({ kind: "comment", actor: "maint", actorRole: "maintainer", body: "Please rebase" });
  expect(byKey["c:1"]?.at.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  expect(byKey["c:2"]?.actorRole).toBe("contributor");
  expect(byKey["r:3"]).toMatchObject({ kind: "review", details: { state: "approved" } });
  expect(byKey["l:5"]).toMatchObject({ kind: "label", actorRole: "maintainer", details: { action: "added", label: "ready" } });
  expect(byKey["m:6"]).toMatchObject({ kind: "mention", actorRole: "unknown" });
  expect(byKey["s:8"]).toMatchObject({ kind: "state", details: { to: "merged" } });
  expect(byKey["commit:abc123def4567890"]).toMatchObject({ kind: "push", actorRole: "me", details: { sha: "abc123def456", message: "Fix build" } });
});

test("issues skip PR-only calls", async () => {
  const { adapter, calls } = fakeGitHub({
    "/repos/foo/bar/issues/7": { title: "Crash", state: "open", user: { login: "x" }, labels: ["a"] },
    "/repos/foo/bar/issues/7/timeline?per_page=100": [],
  });
  const snap = await adapter.fetch({ url: "https://github.com/foo/bar/issues/7", instance: "github", kind: "issue" });
  expect(snap).toMatchObject({ state: "open", ciState: null, authoredByMe: false, labels: ["a"], events: [] });
  expect(calls).toHaveLength(2);
});

test("discover: first run searches open items only", async () => {
  const q = encodeURIComponent("involves:lapo is:open");
  const { adapter, calls } = fakeGitHub({
    [`/search/issues?q=${q}&sort=updated&per_page=100`]: { items: [{ html_url: PR }, { html_url: "https://github.com/x/y/issues/1" }] },
  });
  const refs = await adapter.discover(null);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://github.com/x/y/issues/1"]);
  expect(calls).toHaveLength(1);
});

test("discover: incremental run adds subscribed items from notifications", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const q = encodeURIComponent("involves:lapo updated:>=2026-11-04T10:00:00Z");
  const { adapter } = fakeGitHub({
    [`/search/issues?q=${q}&sort=updated&per_page=100`]: { items: [{ html_url: PR }] },
    [`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`]: [
      { subject: { url: "https://api.github.com/repos/k/l/issues/9" } },
      { subject: { url: "https://api.github.com/repos/k/l/pulls/10" } },
      { subject: { url: "https://api.github.com/repos/k/l/releases/1" } },
    ],
  });
  const refs = await adapter.discover(since);
  expect(refs.map((r) => r.url)).toEqual([PR, "https://github.com/k/l/issues/9", "https://github.com/k/l/pull/10"]);
});

test("discover: notifications forbidden (fine-grained token) is skipped", async () => {
  const since = new Date("2026-11-04T10:00:00.000Z");
  const q = encodeURIComponent("involves:lapo updated:>=2026-11-04T10:00:00Z");
  const { adapter } = fakeGitHub({
    [`/search/issues?q=${q}&sort=updated&per_page=100`]: { items: [] },
    [`/notifications?all=true&per_page=50&since=${encodeURIComponent(since.toISOString())}`]: 403,
  });
  expect(await adapter.discover(since)).toEqual([]);
});
